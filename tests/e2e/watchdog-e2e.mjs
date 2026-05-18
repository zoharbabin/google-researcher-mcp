/**
 * E2E test: Worker Thread Watchdog — Parent PID Death Detection
 *
 * This test verifies the worker thread watchdog correctly detects and handles
 * parent process death. Unlike the orphan-cleanup E2E test (which destroys
 * pipes), this test kills the ACTUAL parent process to simulate the real
 * failure scenario where:
 *   1. Claude Code spawns the MCP server
 *   2. Claude Code dies/is killed
 *   3. The unix domain socket breaks → libuv spin loop → JS event loop starved
 *   4. Worker thread watchdog (separate event loop) detects parent death
 *   5. Worker thread force-exits the process
 *
 * Architecture: We spawn an intermediary "parent" process that itself spawns
 * the server. Then we kill the intermediary, and verify the server exits.
 */

import { spawn, execSync } from 'child_process';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import assert from 'assert';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_JS = resolve(__dirname, '..', '..', 'dist', 'server.js');
const NODE = process.execPath;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// ─── Test: Kill parent process, verify server self-terminates ────────────────

async function testParentProcessKill() {
  console.log('\n  Test: Server exits when parent process is killed');

  // Spawn an intermediary "parent" that spawns the server.
  // The intermediary simply forwards stdin/stdout and waits.
  const intermediary = spawn(NODE, ['-e', `
    const { spawn } = require('child_process');
    const child = spawn(process.execPath, ['--no-warnings', '${SERVER_JS}'], {
      env: { ...process.env, MCP_TEST_MODE: 'stdio' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    // Report the child PID to our parent
    process.stdout.write(JSON.stringify({ childPid: child.pid }) + '\\n');
    // Forward the MCP init message to the server
    child.stdin.write(JSON.stringify({
      jsonrpc: '2.0',
      method: 'initialize',
      id: 1,
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'watchdog-test', version: '1.0.0' },
      },
    }) + '\\n');
    // Keep running until killed
    setInterval(() => {}, 10000);
  `], {
    env: { ...process.env, MCP_TEST_MODE: 'stdio' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  // Read the child PID from the intermediary's stdout
  const childPid = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timeout waiting for child PID')), 15000);
    let buf = '';
    intermediary.stdout.on('data', (chunk) => {
      buf += chunk.toString();
      const lines = buf.split('\n');
      for (const line of lines) {
        if (line.trim()) {
          try {
            const data = JSON.parse(line);
            if (data.childPid) {
              clearTimeout(timer);
              resolve(data.childPid);
              return;
            }
          } catch {}
        }
      }
    });
    intermediary.on('error', (e) => { clearTimeout(timer); reject(e); });
    intermediary.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`Intermediary exited early with code ${code}`));
    });
  });

  console.log(`   Intermediary PID: ${intermediary.pid}`);
  console.log(`   Server PID: ${childPid}`);

  // Let the server initialize and the watchdog start
  await sleep(3000);
  assert(isAlive(childPid), 'Server should be alive before parent kill');
  console.log('   Server is alive, watchdog should be active');

  // Kill the intermediary (simulates Claude Code crashing)
  intermediary.kill('SIGKILL');
  console.log('   Killed intermediary (simulating Claude Code crash)');

  // The watchdog checks every 2s. Give it up to 8s to detect and exit.
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline && isAlive(childPid)) {
    await sleep(200);
  }

  const serverAlive = isAlive(childPid);
  if (serverAlive) {
    console.log('   FAIL — Server still alive, killing it');
    try { process.kill(childPid, 'SIGKILL'); } catch {}
  }

  assert.strictEqual(serverAlive, false,
    `Server (PID ${childPid}) did not exit after parent (PID ${intermediary.pid}) was killed`);
  console.log('   PASS — Server self-terminated after parent death');
}

// ─── Main ────────────────────────────────────────────────────────────────────

console.log('Worker Thread Watchdog — E2E Test');
console.log(`   Server: ${SERVER_JS}`);
console.log(`   Node:   ${NODE}`);

let failed = false;
try {
  await testParentProcessKill();
  console.log('\nWatchdog test passed!\n');
} catch (err) {
  console.error('\nTest failed:', err.message);
  failed = true;
}

process.exit(failed ? 1 : 0);
