import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  closeSync,
  mkdtempSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const launcher = resolve(dirname(fileURLToPath(import.meta.url)), "../scripts/auto-sandbox.py");
const root = mkdtempSync(join(tmpdir(), "ac-auto-sandbox-"));
const main = join(root, "main"),
  sibling = join(root, "sibling"),
  own = join(root, "own");
const scratch = join(root, "private-tmp"),
  session = join(root, "private-session");
const python = process.env.PYTHON || "python3";
function run(command: string, args: string[], cwd = root) {
  return spawnSync(command, args, { cwd, encoding: "utf8", timeout: 30_000 });
}
function ok(command: string, args: string[], cwd = root) {
  const result = run(command, args, cwd);
  assert.equal(result.status, 0, `${command}: ${result.error || result.stderr || result.stdout}`);
  return result;
}

try {
  for (const path of [main, sibling, own, scratch, session]) mkdirSync(path);
  writeFileSync(join(main, "important.txt"), "main unchanged\n");
  writeFileSync(join(sibling, "important.txt"), "sibling unchanged\n");
  ok("git", ["init", "-q", main]);
  ok("git", ["-C", main, "add", "."]);
  ok("git", [
    "-C",
    main,
    "-c",
    "user.name=Sandbox Test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "-qm",
    "Seed",
  ]);

  // Unsupported kernels must fail closed: even the supplied command never runs.
  const marker = join(root, "must-not-run");
  const unavailable = run(python, [
    "-c",
    `
import importlib.util, errno, sys
sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location('sandbox', ${JSON.stringify(launcher)})
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
def unavailable():
    raise OSError(errno.ENOSYS, 'simulated unsupported Landlock')
module._landlock_abi = unavailable
sys.exit(module.main(['--write', ${JSON.stringify(own)}, '--', sys.executable, '-c', ${JSON.stringify(`open(${JSON.stringify(marker)}, 'w').write('unsafe')`)}]))
`,
  ]);
  assert.equal(unavailable.status, 78, unavailable.stderr);
  assert.match(unavailable.stderr, /refusing to start command/);
  assert.throws(() => readFileSync(marker), /ENOENT/);
  const probe = run(python, [launcher, "--check"]);
  if (probe.status !== 0) {
    assert.equal(probe.status, 78, probe.stderr);
    assert.match(probe.stderr, /refusing to start command/);
    console.log("PASS auto sandbox: unavailable host fails closed; supported-host checks skipped");
  } else {
    assert.ok(JSON.parse(probe.stdout).landlockAbi >= 3);
    const roots = ["--write", own, "--write", scratch, "--write", session];
    const result = run(python, [
      launcher,
      ...roots,
      "--",
      python,
      "-c",
      `
import ctypes, errno, os, pathlib, socket, subprocess, sys
own, main, sibling, scratch, session = map(pathlib.Path, sys.argv[1:])
os.chdir(own)
def denied(fn):
    try:
        fn()
    except OSError as error:
        assert error.errno in (errno.EACCES, errno.EPERM, errno.EXDEV), error
    else:
        raise AssertionError('operation unexpectedly allowed')
for directory in (main, sibling):
    target = directory / 'important.txt'
    assert 'unchanged' in target.read_text(), 'reads remain allowed'
    denied(lambda: target.write_text('corruption'))
    denied(lambda: os.truncate(target, 0))
    denied(lambda: target.unlink())
    denied(lambda: target.rename(own / 'stolen'))
    denied(lambda: os.link(target, own / 'linked'))
    denied(lambda: (directory / 'new-file').touch())
    denied(lambda: (directory / 'new-directory').mkdir())
    shell = subprocess.run(['bash', '-c', 'echo corruption > "$1"', 'bash', str(target)], capture_output=True)
    assert shell.returncode != 0, shell
    link = own / ('symlink-' + directory.name)
    link.symlink_to(directory, target_is_directory=True)
    denied(lambda: (link / 'important.txt').write_text('symlink corruption'))
    denied(lambda: (link / 'new-via-symlink').touch())
git = subprocess.run(['git', '-C', str(main), 'config', 'sandbox.escape', 'yes'], capture_output=True)
assert git.returncode != 0, 'git -C main config bypassed isolation'
git = subprocess.run(['git', '-C', str(main), 'reset', '--hard', 'HEAD'], capture_output=True)
assert git.returncode != 0, 'git -C main reset bypassed isolation'
for directory in (own, scratch, session):
    target = directory / 'allowed'
    target.write_text('safe')
    target.chmod(0o700)
    os.utime(target, None)
    target.rename(directory / 'renamed')
    (directory / 'renamed').unlink()
subprocess.run(['git', 'init', '-q'], check=True)
(own / 'change.txt').write_text('own commit works')
subprocess.run(['git', 'add', '.'], check=True)
subprocess.run(['git', '-c', 'user.name=Sandbox Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'Own isolated commit'], check=True)
assert subprocess.run(['git', 'rev-parse', '--verify', 'HEAD'], capture_output=True).returncode == 0
# Local networking remains available for model providers, package tools and tests.
with socket.socket() as server:
    server.bind(('127.0.0.1', 0))
    server.listen(1)
    with socket.create_connection(server.getsockname()) as client:
        connection, _ = server.accept()
        with connection:
            client.sendall(b'network works')
            assert connection.recv(64) == b'network works'
# External-process mutation/descriptor borrowing is unavailable as well.
libc = ctypes.CDLL(None, use_errno=True)
for number in (101, 311, 425, 438):
    assert libc.syscall(number, 0, 0, 0, 0, 0, 0) == -1
    assert ctypes.get_errno() == errno.EPERM
print('sandbox content isolation verified')
`,
      own,
      main,
      sibling,
      scratch,
      session,
    ]);
    assert.equal(result.status, 0, `${result.error || result.stderr}\n${result.stdout}`);
    const inherited = openSync(join(main, "important.txt"), "r+");
    try {
      const handles = spawnSync(
        python,
        [
          launcher,
          ...roots,
          "--",
          python,
          "-c",
          `
import os, errno
try:
    os.write(3, b'inherited descriptor corruption')
except OSError as error:
    assert error.errno == errno.EBADF
else:
    raise AssertionError('inherited writable descriptor survived sandbox')
`,
        ],
        {
          cwd: root,
          encoding: "utf8",
          timeout: 30_000,
          stdio: ["ignore", "pipe", "pipe", inherited],
        },
      );
      assert.equal(handles.status, 0, handles.stderr);
    } finally {
      closeSync(inherited);
    }
    assert.equal(readFileSync(join(main, "important.txt"), "utf8"), "main unchanged\n");
    assert.equal(readFileSync(join(sibling, "important.txt"), "utf8"), "sibling unchanged\n");
    assert.doesNotMatch(readFileSync(join(main, ".git/config"), "utf8"), /escape/);
    const broad = run(python, [launcher, "--write", "/", "--", "true"]);
    assert.equal(broad.status, 78);
    console.log(
      "PASS auto sandbox: shell/Python/Git/symlink/truncate/link denied outside roots; own commit and private temp/session writes work; unavailable support fails closed",
    );
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}
