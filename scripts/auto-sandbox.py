#!/usr/bin/env python3
"""Restrict unattended workers' filesystem writes before executing their command.

Usage: python3 scripts/auto-sandbox.py [--read PATH]... --write DIRECTORY [--write DIRECTORY] -- COMMAND...
       python3 scripts/auto-sandbox.py --check

Linux x86-64, Landlock ABI >= 3 and seccomp are required. Failure never launches
the command. Descendants inherit the restrictions. Network access is unchanged.
Each writable root must already exist; callers should grant only the issue
worktree, required Git metadata, and private session/temp directories.

Without --read, reads are unchanged. With at least one --read (repeatable) read
mode is on: reading, listing and executing anything outside the --read and --write
roots is denied. --read roots get read+exec; --write roots get read+exec+write.
Missing --read paths are skipped silently. Callers must list everything the
command needs (for example /usr, /bin, /lib, /lib64, /etc, /proc, /dev).

Landlock does not restrict chmod/chown/timestamps/xattrs. This protects file
content, creation, deletion, linking, renaming and truncation, not all metadata.
Without --read it is not a confidentiality sandbox: credentials and network remain
accessible. Read mode is a confidentiality boundary for files outside the allow-list,
with remaining gaps: connecting to pathname unix sockets is not restricted, and
other processes' /proc/PID/cmdline stays readable when /proc is allowed.
"""

import argparse
import ctypes
import errno
import json
import os
import platform
import resource
import stat
import sys
from pathlib import Path


class SandboxError(RuntimeError):
    pass


LIBC = ctypes.CDLL(None, use_errno=True)
LIBC.syscall.restype = ctypes.c_long
EXECUTE = 1 << 0
WRITE_FILE = 1 << 1
READ_FILE = 1 << 2
READ_DIR = 1 << 3
TRUNCATE = 1 << 14
WRITE_ACCESS = WRITE_FILE | sum(1 << bit for bit in range(4, 15))
READ_ACCESS = EXECUTE | READ_FILE | READ_DIR
FILE_ACCESS = EXECUTE | WRITE_FILE | READ_FILE | TRUNCATE


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


def _landlock_rules(roots, reads):
    read_mode = bool(reads)
    extra = READ_ACCESS if read_mode else 0
    rules = [(root, WRITE_ACCESS | extra) for root in roots]
    rules.extend((path, READ_ACCESS) for path in reads)
    rules.append((Path("/dev/null"), WRITE_FILE | TRUNCATE | (READ_FILE if read_mode else 0)))
    return rules


def _landlock(roots, reads=()):
    handled = WRITE_ACCESS | (READ_ACCESS if reads else 0)
    attr = Ruleset(handled)
    ruleset = _syscall(444, ctypes.byref(attr), ctypes.c_size_t(ctypes.sizeof(attr)), 0)
    try:
        for path, rights in _landlock_rules(roots, reads):
            try:
                path_fd = os.open(path, os.O_PATH | os.O_CLOEXEC)
            except FileNotFoundError:
                continue
            try:
                if not stat.S_ISDIR(os.fstat(path_fd).st_mode):
                    rights &= FILE_ACCESS
                rule = PathRule(rights, path_fd)
                _syscall(445, ruleset, 1, ctypes.byref(rule), 0)
            finally:
                os.close(path_fd)
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


def enforce(roots, reads=()):
    abi = _landlock_abi()
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    _no_new_privileges()
    _landlock(roots, reads)
    _seccomp()
    # Do not carry writable files or directory handles from the parent process.
    max_fd = resource.getrlimit(resource.RLIMIT_NOFILE)[0]
    os.closerange(3, int(max_fd if max_fd != resource.RLIM_INFINITY else 1_048_576))
    return abi


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--write", action="append", default=[], metavar="DIRECTORY")
    parser.add_argument("--read", action="append", default=[], metavar="PATH")
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
        reads = [Path(path).resolve() for path in args.read]
        abi = enforce(roots, reads)
        if args.check:
            print(json.dumps({"supported": True, "landlockAbi": abi}))
            return 0
        os.execvp(command[0], command)
    except (OSError, SandboxError) as error:
        print(f"auto-sandbox: {error}; refusing to start command", file=sys.stderr)
        return 78


if __name__ == "__main__":
    sys.exit(main())
