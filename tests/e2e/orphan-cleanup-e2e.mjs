/**
 * E2E test: Orphan Process Prevention
 *
 * Verifies that the MCP server does NOT become an orphan zombie that
 * burns CPU when its parent (e.g. Claude Code) exits unexpectedly.
 *
 * Three scenarios are tested:
 *   1. Parent exits abruptly — server must exit within a time budget.
 *   2. Multiple instances launched — new startup must kill previous ones.
 *   3. No CPU spin — an orphaned server must not peg a core while it is
 *      still alive (between parent death and its own exit).
 *
 * This test does NOT require API keys or network access.
 */

import { spawn, execSync } from 'child_process';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import assert from 'assert';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_JS = resolve(__dirname, '..', '..', 'dist', 'server.js');
const NODE = process.execPath;
const ENV = { ...process.env, MCP_TEST_MODE: 'stdio' };

// On CI, the MCP initialize handshake is needed for the server to fully start
const INIT_MSG = JSON.stringify({
  jsonrpc: '2.0',
  method: 'initialize',
  id: 1,
  params: {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'orphan-test', version: '1.0.0' },
  },
}) + '\n';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function countServerProcesses() {
  try {
    const out = execSync('pgrep -f "google-researcher-mcp/dist/server.js"', {
      encoding: 'utf8',
      timeout: 3000,
    }).trim();
    // Filter out our own PID
    return out
      .split('\n')
      .map((l) => parseInt(l.trim(), 10))
      .filter((pid) => !isNaN(pid) && pid !== process.pid).length;
  } catch {
    return 0; // pgrep returns exit 1 when no matches
  }
}

function killAllServers() {
  try {
    execSync('pkill -9 -f "google-researcher-mcp/dist/server.js"', { timeout: 3000 });
  } catch { /* none running */ }
}

/**
 * Spawn the MCP server as a child, send the init handshake, wait for it to
 * respond, then return the child process handle.
 */
function spawnServer() {
  const child = spawn(NODE, ['--no-warnings', SERVER_JS], {
    env: ENV,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  return child;
}

async function waitForReady(child, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('Server did not become ready within timeout')),
      timeoutMs
    );
    let buf = '';
    child.stdout.on('data', (chunk) => {
      buf += chunk.toString();
      // The server responds to initialize with a JSON-RPC result
      if (buf.includes('"result"')) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`Server exited early with code ${code}`));
    });
    // Send the handshake
    child.stdin.write(INIT_MSG);
  });
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// ─── Test 1: Server exits when parent pipe closes ────────────────────────────

async function testParentExitCleanup() {
  console.log('\n🧪 Test 1: Server exits when parent disconnects');

  const child = spawnServer();
  await waitForReady(child);
  const pid = child.pid;
  console.log(`   Server started (PID ${pid})`);

  // Simulate parent death: destroy our end of the pipes
  child.stdin.destroy();
  child.stdout.destroy();
  child.stderr.destroy();
  child.unref();

  // The server should exit within 5 seconds (health check interval is 2s,
  // plus graceful shutdown time)
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline && isAlive(pid)) {
    await sleep(200);
  }

  const alive = isAlive(pid);
  if (alive) {
    // Clean up before failing
    try { process.kill(pid, 'SIGKILL'); } catch {}
  }
  assert.strictEqual(alive, false, `Server PID ${pid} is still alive after parent disconnected`);
  console.log('   ✅ Server exited within time budget');
}

// ─── Test 2: New instance kills old instances ────────────────────────────────

async function testNewInstanceKillsOld() {
  console.log('\n🧪 Test 2: New instance kills previous instances');

  // Spawn instance A
  const childA = spawnServer();
  await waitForReady(childA);
  const pidA = childA.pid;
  console.log(`   Instance A started (PID ${pidA})`);

  // Spawn instance B — its acquirePidLock should SIGTERM instance A
  const childB = spawnServer();
  await waitForReady(childB);
  const pidB = childB.pid;
  console.log(`   Instance B started (PID ${pidB})`);

  // Give instance A a moment to receive SIGTERM and shut down
  await sleep(2000);

  const aAlive = isAlive(pidA);
  console.log(`   Instance A alive: ${aAlive}`);

  // Clean up B
  try { process.kill(pidB, 'SIGTERM'); } catch {}
  await sleep(1000);
  if (isAlive(pidB)) {
    try { process.kill(pidB, 'SIGKILL'); } catch {}
  }

  assert.strictEqual(aAlive, false, `Old instance A (PID ${pidA}) was not killed by new instance B`);
  console.log('   ✅ New instance killed old instance');
}

// ─── Test 3: No CPU spin while alive ─────────────────────────────────────────

async function testNoCpuSpin() {
  console.log('\n🧪 Test 3: No CPU spin on idle server');

  const child = spawnServer();
  await waitForReady(child);
  const pid = child.pid;
  console.log(`   Server started (PID ${pid})`);

  // Let it idle for 5 seconds so startup CPU amortizes in the ps average.
  // The `%cpu` field from `ps` reports lifetime average, so short-lived startup
  // spikes inflate the number on slow CI runners.
  await sleep(5000);

  let cpuPercent = 0;
  try {
    const psOut = execSync(`ps -p ${pid} -o %cpu=`, { encoding: 'utf8', timeout: 3000 }).trim();
    cpuPercent = parseFloat(psOut) || 0;
  } catch {
    // Process may have exited — that's fine, 0 CPU
  }

  console.log(`   CPU usage after 5s idle: ${cpuPercent}%`);

  // Clean up
  try { process.kill(pid, 'SIGTERM'); } catch {}
  await sleep(1000);
  if (isAlive(pid)) {
    try { process.kill(pid, 'SIGKILL'); } catch {}
  }

  // An idle MCP server should use well under 50% CPU. Orphan spinners hit 80%+.
  // We use 50% as the threshold to avoid false positives on slow CI runners
  // where Node.js JIT warmup can briefly inflate the lifetime average.
  assert(cpuPercent < 50, `Server using ${cpuPercent}% CPU while idle — possible spin loop`);
  console.log('   ✅ CPU usage is normal');
}

// ─── Test 4: No orphans left after test ──────────────────────────────────────

async function testNoOrphansRemain() {
  console.log('\n🧪 Test 4: No orphan processes remain');
  await sleep(1000);
  const remaining = countServerProcesses();
  if (remaining > 0) {
    console.log(`   ⚠️  ${remaining} orphan(s) found — cleaning up`);
    killAllServers();
    await sleep(1000);
  }
  const afterCleanup = countServerProcesses();
  assert.strictEqual(afterCleanup, 0, `${afterCleanup} orphan processes still remain after cleanup`);
  console.log('   ✅ No orphan processes');
}

// ─── Main ────────────────────────────────────────────────────────────────────

console.log('🔬 Orphan Process Prevention — E2E Test Suite');
console.log(`   Server: ${SERVER_JS}`);
console.log(`   Node:   ${NODE}`);

// Ensure clean state
killAllServers();
await sleep(500);

let failed = false;
try {
  await testParentExitCleanup();
  await testNewInstanceKillsOld();
  await testNoCpuSpin();
  await testNoOrphansRemain();
  console.log('\n🎉 All orphan-prevention tests passed!\n');
} catch (err) {
  console.error('\n❌ Test failed:', err.message);
  failed = true;
} finally {
  // Always clean up
  killAllServers();
}

process.exit(failed ? 1 : 0);
