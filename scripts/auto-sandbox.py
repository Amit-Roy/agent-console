#!/usr/bin/env python3
"""Restrict unattended workers' filesystem writes before executing their command.

Usage: python3 scripts/auto-sandbox.py --write DIRECTORY [--write DIRECTORY] -- COMMAND...
       python3 scripts/auto-sandbox.py --check

Linux x86-64, Landlock ABI >= 3 and seccomp are required. Failure never launches
the command. Descendants inherit the restrictions. Reads and network access are
unchanged. Each writable root must already exist; callers should grant only the
issue worktree, required Git metadata, and private session/temp directories.

Landlock does not restrict chmod/chown/timestamps/xattrs. This protects file
content, creation, deletion, linking, renaming and truncation, not all metadata.
It is not a confidentiality sandbox: credentials and network remain accessible.
"""

import argparse
import ctypes
import errno
import json
import os
import platform
import resource
import sys
from pathlib import Path


class SandboxError(RuntimeError):
    pass


LIBC = ctypes.CDLL(None, use_errno=True)
LIBC.syscall.restype = ctypes.c_long
WRITE_FILE = 1 << 1
TRUNCATE = 1 << 14
WRITE_ACCESS = WRITE_FILE | sum(1 << bit for bit in range(4, 15))


class Ruleset(ctypes.Structure):
    _fields_ = [("handled_access_fs", ctypes.c_uint64)]


class PathRule(ctypes.Structure):
    _layout_ = "ms"
    _pack_ = 1
    _fields_ = [("allowed_access", ctypes.c_uint64), ("parent_fd", ctypes.c_int32)]


def _syscall(number, *args):
    result = LIBC.syscall(ctypes.c_long(number), *args)
    if result < 0:
        code = ctypes.get_errno()
        raise OSError(code, os.strerror(code))
    return result


def _landlock_abi():
    if sys.platform != "linux" or platform.machine() not in ("x86_64", "amd64"):
        raise SandboxError("Linux x86-64 is required")
    # Linux UAPI: landlock_create_ruleset(444), VERSION flag = 1.
    abi = _syscall(444, ctypes.c_void_p(), ctypes.c_size_t(0), ctypes.c_uint(1))
    if abi < 3:
        raise SandboxError(f"Landlock ABI >= 3 is required (found {abi})")
    return abi


def _no_new_privileges():
    if LIBC.prctl(38, 1, 0, 0, 0) != 0:  # PR_SET_NO_NEW_PRIVS
        raise OSError(ctypes.get_errno(), "PR_SET_NO_NEW_PRIVS failed")


def _landlock(roots):
    attr = Ruleset(WRITE_ACCESS)
    ruleset = _syscall(444, ctypes.byref(attr), ctypes.c_size_t(ctypes.sizeof(attr)), 0)
    try:
        for path, rights in [
            *((root, WRITE_ACCESS) for root in roots),
            (Path("/dev/null"), WRITE_FILE | TRUNCATE),
        ]:
            fd = os.open(path, os.O_PATH | os.O_CLOEXEC)
            try:
                rule = PathRule(rights, fd)
                _syscall(445, ruleset, 1, ctypes.byref(rule), 0)
            finally:
                os.close(fd)
        _syscall(446, ruleset, 0)  # landlock_restrict_self
    finally:
        os.close(ruleset)


class Filter(ctypes.Structure):
    _fields_ = [
        ("code", ctypes.c_ushort),
        ("jt", ctypes.c_ubyte),
        ("jf", ctypes.c_ubyte),
        ("k", ctypes.c_uint32),
    ]


class FilterProgram(ctypes.Structure):
    _fields_ = [("len", ctypes.c_ushort), ("filter", ctypes.POINTER(Filter))]


def _seccomp():
    # Deny external-process memory/FD acquisition and io_uring. These can bypass
    # path checks or borrow a descriptor opened outside our Landlock domain.
    # Keep ordinary chmod/utime available for Git and package installation.
    deny = (101, 311, 425, 438)  # ptrace, process_vm_writev, io_uring_setup, pidfd_getfd
    instructions = [
        Filter(0x20, 0, 0, 4),  # load seccomp_data.arch
        Filter(0x15, 1, 0, 0xC000003E),  # AUDIT_ARCH_X86_64
        Filter(0x06, 0, 0, 0x80000000),  # KILL_PROCESS (also denies int 0x80)
        Filter(0x20, 0, 0, 0),  # load syscall number
        Filter(0x35, 0, 1, 0x40000000),  # reject x32 syscall table
        Filter(0x06, 0, 0, 0x80000000),
    ]
    for number in deny:
        instructions.extend(
            (Filter(0x15, 0, 1, number), Filter(0x06, 0, 0, 0x00050000 | errno.EPERM))
        )
    instructions.append(Filter(0x06, 0, 0, 0x7FFF0000))  # ALLOW
    array = (Filter * len(instructions))(*instructions)
    program = FilterProgram(len(instructions), array)
    if LIBC.prctl(22, 2, ctypes.byref(program), 0, 0) != 0:  # PR_SET_SECCOMP, FILTER
        raise OSError(ctypes.get_errno(), "seccomp filter failed")


def enforce(roots):
    abi = _landlock_abi()
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    _no_new_privileges()
    _landlock(roots)
    _seccomp()
    # Do not carry writable files or directory handles from the parent process.
    max_fd = resource.getrlimit(resource.RLIMIT_NOFILE)[0]
    os.closerange(3, int(max_fd if max_fd != resource.RLIM_INFINITY else 1_048_576))
    return abi


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--write", action="append", default=[], metavar="DIRECTORY")
    parser.add_argument("--check", action="store_true")
    parser.add_argument("command", nargs=argparse.REMAINDER)
    args = parser.parse_args(argv)
    command = args.command[1:] if args.command[:1] == ["--"] else args.command
    if not args.check and (not command or not args.write):
        parser.error("--write and a command after -- are required")
    try:
        roots = [Path(path).resolve(strict=True) for path in args.write]
        if any(not root.is_dir() or root == Path("/") for root in roots):
            raise SandboxError("writable roots must be existing directories other than /")
        abi = enforce(roots)
        if args.check:
            print(json.dumps({"supported": True, "landlockAbi": abi}))
            return 0
        os.execvp(command[0], command)
    except (OSError, SandboxError) as error:
        print(f"auto-sandbox: {error}; refusing to start command", file=sys.stderr)
        return 78


if __name__ == "__main__":
    sys.exit(main())
