/**
 * Parent Process Watchdog — Worker Thread Implementation
 *
 * When a unix domain socket breaks (parent dies), Node.js's libuv layer can
 * enter a tight CPU spin loop at the C++ level. This starves the JavaScript
 * event loop, preventing setInterval/setTimeout callbacks from executing.
 *
 * This watchdog runs in a SEPARATE worker thread with its own event loop,
 * immune to main thread starvation. It monitors the parent PID and forcefully
 * terminates the process if the parent dies.
 */

import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';

// ── Worker Thread Code (runs in its own event loop) ──────────────────────────

if (!isMainThread && parentPort) {
  const { targetParentPid, checkIntervalMs } = workerData as {
    targetParentPid: number;
    checkIntervalMs: number;
  };

  function isParentAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch (e: unknown) {
      // EPERM = process exists but different user (alive)
      // ESRCH = no such process (dead)
      return (e as NodeJS.ErrnoException).code === 'EPERM';
    }
  }

  const check = setInterval(() => {
    if (!isParentAlive(targetParentPid)) {
      // Parent is dead — force exit immediately.
      // We bypass graceful shutdown because the main thread's event loop
      // is likely saturated and cannot process shutdown logic.
      parentPort!.postMessage({ type: 'parent-dead', pid: targetParentPid });

      // Give main thread 500ms to handle the message gracefully,
      // then force-kill the entire process.
      setTimeout(() => {
        process.exit(0);
      }, 500);
    }
  }, checkIntervalMs);

  // Keep the worker alive
  check.unref();
  // But re-ref it so the worker thread doesn't exit
  check.ref();
}

// ── Main Thread API ──────────────────────────────────────────────────────────

let watchdogWorker: Worker | null = null;

/**
 * Starts the parent watchdog in a separate worker thread.
 * Must be called from the main thread only.
 *
 * @param parentPid - The PID of the parent process to monitor
 * @param onParentDead - Callback invoked when parent death is detected
 *                       (best-effort; process.exit(0) follows regardless)
 * @param checkIntervalMs - How often to check parent liveness (default: 2000ms)
 */
export function startParentWatchdog(
  parentPid: number,
  onParentDead?: (pid: number) => void,
  checkIntervalMs = 2000,
): Worker | null {
  if (!isMainThread) return null;
  if (watchdogWorker) return watchdogWorker;

  watchdogWorker = new Worker(new URL(import.meta.url), {
    workerData: { targetParentPid: parentPid, checkIntervalMs },
  });

  watchdogWorker.on('message', (msg: { type: string; pid: number }) => {
    if (msg.type === 'parent-dead') {
      if (onParentDead) {
        try { onParentDead(msg.pid); } catch {}
      }
      // The worker thread will force-exit after 500ms anyway,
      // but try to exit cleanly from main thread too.
      setTimeout(() => process.exit(0), 200).unref();
    }
  });

  watchdogWorker.on('error', () => {
    // If the worker crashes, null it out so it can be restarted
    watchdogWorker = null;
  });

  // Don't let the watchdog worker prevent process exit during normal shutdown
  watchdogWorker.unref();

  return watchdogWorker;
}

/**
 * Stops the watchdog worker thread. Call during graceful shutdown
 * to prevent the watchdog from killing the process mid-cleanup.
 */
export async function stopParentWatchdog(): Promise<void> {
  if (watchdogWorker) {
    await watchdogWorker.terminate();
    watchdogWorker = null;
  }
}
