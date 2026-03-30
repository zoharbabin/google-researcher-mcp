/**
 * Test cleanup utilities to prevent resource leaks and lock file conflicts
 */
import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * Removes stale lock directories that may be left behind by tests
 */
export async function cleanupStaleLocks(basePath: string = 'storage'): Promise<void> {
  try {
    const lockDirs = await findLockDirectories(basePath);
    for (const lockDir of lockDirs) {
      try {
        await fs.rm(lockDir, { recursive: true, force: true });
        process.stderr.write(`Cleaned up stale lock directory: ${lockDir}\n`);
      } catch (error: any) {
        process.stderr.write(`Could not remove lock directory ${lockDir}: ${error.message}\n`);
      }
    }
  } catch (error: any) {
    process.stderr.write(`Error during lock cleanup: ${error.message}\n`);
  }
}

/**
 * Recursively finds all .lock directories
 */
async function findLockDirectories(basePath: string): Promise<string[]> {
  const lockDirs: string[] = [];
  
  try {
    const entries = await fs.readdir(basePath, { withFileTypes: true });
    
    for (const entry of entries) {
      const fullPath = path.join(basePath, entry.name);
      
      if (entry.isDirectory()) {
        if (entry.name.endsWith('.lock')) {
          lockDirs.push(fullPath);
        } else {
          // Recursively search subdirectories
          const subLocks = await findLockDirectories(fullPath);
          lockDirs.push(...subLocks);
        }
      }
    }
  } catch (error) {
    // Ignore errors for non-existent directories
    if (error.code !== 'ENOENT') {
      process.stderr.write(`Error reading directory ${basePath}: ${error.message}\n`);
    }
  }
  
  return lockDirs;
}

/**
 * Creates isolated test storage directories to prevent conflicts
 */
export function createTestStoragePaths(testSuiteName: string): {
  cachePath: string;
  eventPath: string;
  requestQueuesPath: string;
} {
  const testId = `${testSuiteName}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  const basePath = path.resolve('storage', 'test_temp', testId);
  
  return {
    cachePath: path.join(basePath, 'cache'),
    eventPath: path.join(basePath, 'events'),
    requestQueuesPath: path.join(basePath, 'queues')
  };
}

/**
 * Cleanup test storage directories
 */
export async function cleanupTestStorage(testPaths: {
  cachePath: string;
  eventPath: string;
  requestQueuesPath: string;
}): Promise<void> {
  const basePath = path.dirname(testPaths.cachePath);
  
  try {
    await fs.rm(basePath, { recursive: true, force: true });
    process.stderr.write(`Cleaned up test storage: ${basePath}\n`);
  } catch (error: any) {
    process.stderr.write(`Could not cleanup test storage ${basePath}: ${error.message}\n`);
  }
}

/**
 * Force cleanup of all test temporary directories
 */
export async function cleanupAllTestStorage(): Promise<void> {
  const testTempPath = path.resolve('storage', 'test_temp');
  
  try {
    await fs.rm(testTempPath, { recursive: true, force: true });
    process.stderr.write(`Cleaned up all test storage: ${testTempPath}\n`);
  } catch (error: any) {
    if (error.code !== 'ENOENT') {
      process.stderr.write(`Could not cleanup test storage ${testTempPath}: ${error.message}\n`);
    }
  }
}

/**
 * Enhanced cleanup for Jest tests - handles timers and async operations
 */
export async function cleanupJestTestEnvironment(): Promise<void> {
  // Force garbage collection if available
  if (global.gc) {
    global.gc();
  }

  // Give async cleanup operations time to complete
  await new Promise(resolve => setTimeout(resolve, 10)); // Reduced from 50ms to 10ms
}

/**
 * Check for and cleanup any remaining open file handles
 */
export async function cleanupOpenHandles(): Promise<void> {
  try {
    // Clean up any remaining lock files
    await cleanupStaleLocks();
    
    // Clean up test storage
    await cleanupAllTestStorage();
    
    // Enhanced Jest environment cleanup
    await cleanupJestTestEnvironment();
    
  } catch (error: any) {
    process.stderr.write(`Error during open handles cleanup: ${error.message}\n`);
  }
}