// Boot time test: measures time from process start to HTTP server listening.
// Must complete in under 2000ms (2 seconds). Tests production boot path (no AGENT_CONSOLE_MOCK).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

const dataDir = './test-data-boot-time';
const PORT = 17800;

const server = spawn(process.execPath, ['server/index.ts'], {
  env: { ...process.env, PORT: String(PORT), AGENT_CONSOLE_DATA: dataDir },
  stdio: 'pipe'
});

const start = Date.now();
let resolved = false;

server.stdout.on('data', (data) => {
  const text = data.toString();
  if (text.includes('listening on') && !resolved) {
    resolved = true;
    const elapsed = Date.now() - start;
    console.log(`Boot time: ${elapsed}ms`);
    assert.ok(elapsed < 2000, `Boot time ${elapsed}ms exceeds 2000ms threshold`);
    server.kill();
    process.exit(0);
  }
});

server.stderr.on('data', (data) => {
  // Ignore stderr noise
});

setTimeout(() => {
  if (!resolved) {
    console.log('Timeout - server did not start within 60s');
    server.kill();
    process.exit(1);
  }
}, 60000);