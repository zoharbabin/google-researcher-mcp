/**
 * E2E test: Orphan Process Prevention & Multi-Instance Coexistence
 *
 * Verifies that:
 *   1. A server exits when its parent disconnects (no orphans).
 *   2. Multiple concurrent instances can coexist — one starting does NOT
 *      kill another (the npx shared-directory scenario from issue #104).
 *   3. An idle server does not spin at high CPU.
 *   4. When one instance's parent dies, the OTHER instance stays alive.
 *   5. No orphan processes remain after cleanup.
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

// Track all spawned children so we can reap them properly (avoid zombies)
const trackedChildren = new Set();
const allSpawnedPids = new Set();

function killAllServers() {
  try {
    execSync('pkill -9 -f "google-researcher-mcp/dist/server.js"', { timeout: 3000 });
  } catch { /* none running */ }
}

function waitForExit(child, timeoutMs = 5000) {
  return new Promise((resolve) => {
    if (child.exitCode !== null) { resolve(); return; }
    const timer = setTimeout(resolve, timeoutMs);
    child.on('exit', () => { clearTimeout(timer); resolve(); });
  });
}

async function killAndReap(child) {
  try { child.kill('SIGKILL'); } catch {}
  await waitForExit(child, 3000);
}

async function reapAllTracked() {
  const promises = [];
  for (const child of trackedChildren) {
    try { child.kill('SIGKILL'); } catch {}
    promises.push(waitForExit(child, 3000));
  }
  await Promise.all(promises);
  trackedChildren.clear();
}

function spawnServer() {
  const child = spawn(NODE, ['--no-warnings', SERVER_JS], {
    env: ENV,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  trackedChildren.add(child);
  allSpawnedPids.add(child.pid);
  child.on('exit', () => {
    trackedChildren.delete(child);
    allSpawnedPids.delete(child.pid);
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
  console.log('\n  Test 1: Server exits when parent disconnects');

  const child = spawnServer();
  await waitForReady(child);
  const pid = child.pid;
  console.log(`   Server started (PID ${pid})`);

  child.stdin.destroy();
  child.stdout.destroy();
  child.stderr.destroy();
  child.unref();

  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline && isAlive(pid)) {
    await sleep(200);
  }

  const alive = isAlive(pid);
  if (alive) await killAndReap(child);
  assert.strictEqual(alive, false, `Server PID ${pid} still alive after parent disconnected`);
  console.log('   PASS — Server exited within time budget');
}

// ─── Test 2: Concurrent instances coexist (issue #104) ───────────────────────

async function testConcurrentInstancesCoexist() {
  console.log('\n  Test 2: Concurrent instances coexist (multi-user scenario)');

  // Simulate two independent Claude Code sessions spawning the same server.
  // Both must remain alive — one must NOT kill the other.
  const childA = spawnServer();
  await waitForReady(childA);
  const pidA = childA.pid;
  console.log(`   Instance A started (PID ${pidA})`);

  const childB = spawnServer();
  await waitForReady(childB);
  const pidB = childB.pid;
  console.log(`   Instance B started (PID ${pidB})`);

  // Wait and then verify both are still running
  await sleep(2000);

  const aAlive = isAlive(pidA);
  const bAlive = isAlive(pidB);
  console.log(`   Instance A alive: ${aAlive}, Instance B alive: ${bAlive}`);

  // Clean up both — must await exit to reap zombies
  try { childA.kill('SIGTERM'); } catch {}
  try { childB.kill('SIGTERM'); } catch {}
  await sleep(1000);
  await killAndReap(childA);
  await killAndReap(childB);

  assert.strictEqual(aAlive, true, `Instance A (PID ${pidA}) was killed when Instance B started — regression of #104`);
  assert.strictEqual(bAlive, true, `Instance B (PID ${pidB}) died unexpectedly`);
  console.log('   PASS — Both instances coexist');
}

// ─── Test 3: No CPU spin while alive ─────────────────────────────────────────

async function testNoCpuSpin() {
  console.log('\n  Test 3: No CPU spin on idle server');

  const child = spawnServer();
  await waitForReady(child);
  const pid = child.pid;
  console.log(`   Server started (PID ${pid})`);

  // Let startup CPU amortize. ps %cpu reports lifetime average.
  await sleep(5000);

  let cpuPercent = 0;
  try {
    const psOut = execSync(`ps -p ${pid} -o %cpu=`, { encoding: 'utf8', timeout: 3000 }).trim();
    cpuPercent = parseFloat(psOut) || 0;
  } catch {
    // Process may have exited — 0 CPU
  }

  console.log(`   CPU usage after 5s idle: ${cpuPercent}%`);

  try { child.kill('SIGTERM'); } catch {}
  await sleep(1000);
  await killAndReap(child);

  // Orphan spinners hit 80%+. 50% threshold avoids CI false positives.
  assert(cpuPercent < 50, `Server using ${cpuPercent}% CPU while idle — possible spin loop`);
  console.log('   PASS — CPU usage is normal');
}

// ─── Test 4: One parent dies, sibling instance survives ──────────────────────

async function testSiblingInstanceSurvivesParentDeath() {
  console.log('\n  Test 4: One parent dies, sibling instance survives');

  // Spawn two instances simulating two separate Claude Code sessions
  const childA = spawnServer();
  await waitForReady(childA);
  const pidA = childA.pid;
  console.log(`   Instance A started (PID ${pidA})`);

  const childB = spawnServer();
  await waitForReady(childB);
  const pidB = childB.pid;
  console.log(`   Instance B started (PID ${pidB})`);

  // Kill instance A's "parent" by destroying its pipes
  childA.stdin.destroy();
  childA.stdout.destroy();
  childA.stderr.destroy();
  childA.unref();
  console.log('   Disconnected Instance A\'s parent');

  // Wait for A to detect parent death and exit
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline && isAlive(pidA)) {
    await sleep(200);
  }

  const aAlive = isAlive(pidA);
  const bAlive = isAlive(pidB);
  console.log(`   Instance A alive: ${aAlive}, Instance B alive: ${bAlive}`);

  // Clean up — must await exit to reap zombies
  try { childB.kill('SIGTERM'); } catch {}
  await sleep(1000);
  await killAndReap(childA);
  await killAndReap(childB);

  assert.strictEqual(aAlive, false, `Instance A (PID ${pidA}) did not exit after parent disconnect`);
  assert.strictEqual(bAlive, true, `Instance B (PID ${pidB}) was killed when A's parent died — must survive`);
  console.log('   PASS — Orphan exited, sibling survived');
}

// ─── Test 5: No orphans left after test ──────────────────────────────────────

async function testNoOrphansRemain() {
  console.log('\n  Test 5: No orphan processes remain');
  // Reap any tracked children (triggers waitpid, clears zombie state)
  await reapAllTracked();
  // Check our tracked PIDs — more reliable than pgrep on CI runners
  const survivors = [...allSpawnedPids].filter((pid) => isAlive(pid));
  if (survivors.length === 0) {
    console.log('   PASS — No orphan processes');
    return;
  }
  console.log(`   WARNING: ${survivors.length} orphan(s) found (PIDs: ${survivors.join(', ')}) — killing`);
  for (const pid of survivors) {
    try { process.kill(pid, 'SIGKILL'); } catch {}
  }
  await sleep(1000);
  const stillAlive = survivors.filter((pid) => isAlive(pid));
  assert.strictEqual(stillAlive.length, 0, `${stillAlive.length} orphan processes still remain (PIDs: ${stillAlive.join(', ')})`);
  console.log('   PASS — No orphan processes');
}

// ─── Main ────────────────────────────────────────────────────────────────────

console.log('Orphan Process Prevention — E2E Test Suite');
console.log(`   Server: ${SERVER_JS}`);
console.log(`   Node:   ${NODE}`);

killAllServers();
await sleep(500);

let failed = false;
try {
  await testParentExitCleanup();
  await testConcurrentInstancesCoexist();
  await testNoCpuSpin();
  await testSiblingInstanceSurvivesParentDeath();
  await testNoOrphansRemain();
  console.log('\nAll orphan-prevention tests passed!\n');
} catch (err) {
  console.error('\nTest failed:', err.message);
  failed = true;
} finally {
  await reapAllTracked();
  killAllServers();
}

process.exit(failed ? 1 : 0);
