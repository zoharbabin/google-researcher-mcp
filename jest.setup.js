// jest.setup.js

// Polyfill browser globals required by pdfjs-dist (used transitively by pdf-parse)
if (typeof globalThis.DOMMatrix === 'undefined') {
  globalThis.DOMMatrix = class DOMMatrix {
    constructor() { this.m = new Float64Array(16); this.m[0] = this.m[5] = this.m[10] = this.m[15] = 1; }
    get a() { return this.m[0]; }
    get b() { return this.m[1]; }
    get c() { return this.m[4]; }
    get d() { return this.m[5]; }
    get e() { return this.m[12]; }
    get f() { return this.m[13]; }
    isIdentity = true;
    is2D = true;
    inverse() { return new DOMMatrix(); }
    multiply() { return new DOMMatrix(); }
    scale() { return new DOMMatrix(); }
    translate() { return new DOMMatrix(); }
    transformPoint(p) { return p; }
  };
}
if (typeof globalThis.Path2D === 'undefined') {
  globalThis.Path2D = class Path2D { constructor() {} };
}

import { jest, afterAll, afterEach, beforeEach, beforeAll } from '@jest/globals';
import { cleanupStaleLocks, cleanupAllTestStorage, cleanupOpenHandles } from './src/shared/testCleanup.js';

// Store original console methods
const originalConsoleLog = console.log;
const originalConsoleError = console.error;

// Check if Jest is running in verbose mode
const isVerbose = process.argv.includes('--verbose') || process.argv.includes('-v');

// Global cleanup before all tests
beforeAll(async () => {
  // Set up valid env vars for all tests (format-valid fake credentials)
  // These are required by envValidator to pass format checks
  process.env.GOOGLE_CUSTOM_SEARCH_API_KEY = 'AIzaSyTEST_KEY_FOR_UNIT_TESTS_123456789';
  process.env.GOOGLE_CUSTOM_SEARCH_ID = '123456789012345:testengine';

  // Clean up any stale locks from previous test runs
  await cleanupStaleLocks();
  await cleanupAllTestStorage();
});

// Mock console methods before each test suite
beforeEach(() => {
  if (!isVerbose) {
    // Suppress console output if not in verbose mode
    console.log = jest.fn();
    console.error = jest.fn();
  } else {
    // Restore original console methods if in verbose mode
    console.log = originalConsoleLog;
    console.error = originalConsoleError;
  }
});

// Make all tests use fake timers
jest.useFakeTimers();

// After every test, clear timers and cleanup any test resources
afterEach(async () => {
  jest.clearAllTimers();
  
  // Clean up any locks that may have been created during the test
  await cleanupStaleLocks();
});

// After every test suite, clean up all resources
afterAll(async () => {
  // Restore original console methods first
  console.log = originalConsoleLog;
  console.error = originalConsoleError;

  // Minimal cleanup to avoid hangs
  try {
    // Basic cleanup without the problematic enhanced cleanup
    await cleanupStaleLocks();
    await cleanupAllTestStorage();
    
    // --- Timer Cleanup ---
    // Clear any remaining fake timers
    jest.clearAllTimers();
    // Ensure we switch back to real timers for any subsequent operations
    jest.useRealTimers();

    // --- Process Listener Cleanup ---
    // Remove listeners registered by PersistentCache shutdown handlers
    ['SIGINT', 'SIGTERM', 'SIGHUP'].forEach(sig => process.removeAllListeners(sig));
    process.removeAllListeners('exit');
    process.removeAllListeners('uncaughtException');

  } catch (error) {
    console.warn('Jest afterAll: Cleanup error:', error.message);
  }
}, 10000); // 10 second timeout for afterAll hook