// src/cache/persistentCache.ts
import { Cache } from './cache.js';
import { CacheEntry, IPersistenceManager, PersistenceStrategy, PersistentCacheOptions } from './types.js';
import { PersistenceManager } from './persistenceManager.js';
import { HybridPersistenceStrategy } from './persistenceStrategies.js';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { logger } from '../shared/logger.js';

/**
 * Advanced cache implementation with disk persistence capabilities
 *
 * This cache extends the in-memory Cache with:
 * - Configurable disk persistence strategies
 * - Namespace-based organization of cached data
 * - Automatic recovery after restarts
 * - Graceful shutdown handling
 * - Optional eager loading of all entries on startup
 *
 * The PersistentCache maintains both an in-memory cache for performance
 * and a disk-based storage for durability. It uses various persistence
 * strategies to determine when and how to write data to disk.
 *
 * @see PersistenceStrategy for different persistence approaches
 * @see IPersistenceManager for the storage interface
 */
export class PersistentCache extends Cache {
  declare protected defaultTTL: number; // Use declare for inherited property
  private persistenceManager: IPersistenceManager;
  private persistenceStrategy: PersistenceStrategy;
  private persistenceTimer: NodeJS.Timeout | null = null;
  private namespaceCache: Map<string, Map<string, CacheEntry<any>>> = new Map();
  private isDirty: boolean = false;
  private isInitialized: boolean = false;
  private initPromise: Promise<void>;
  private eagerLoading: boolean;
  private handlersRegistered: boolean = false;

  /**
   * Creates a new PersistentCache
   *
   * @param options - Configuration options for the cache
   * @param options.defaultTTL - Default time-to-live in milliseconds
   * @param options.maxSize - Maximum number of entries before LRU eviction
   * @param options.storagePath - Path to store persistent cache files
   * @param options.persistenceStrategy - Strategy for when to persist entries
   * @param options.eagerLoading - Whether to load all entries on startup
   * @param options.persistentNamespaces - Namespaces to persist to disk
   */
  constructor(options: PersistentCacheOptions = {}) {
    // Initialize the base Cache class
    super({
      defaultTTL: options.defaultTTL,
      maxSize: options.maxSize
    });

    // Initialize persistence manager: use injected one or create default
    if (options.persistenceManager) {
      this.persistenceManager = options.persistenceManager;
    } else {
      // Use absolute path for storage to ensure consistency across different transports
      // This fixes cache misses when different transports have different working directories
      const __filename = fileURLToPath(import.meta.url);
      const __dirname = path.dirname(__filename);
      // Match the path resolution used in server.ts (only one level up)
      const storagePath = options.storagePath || path.resolve(__dirname, '..', 'storage', 'persistent_cache');
      this.persistenceManager = new PersistenceManager(storagePath);
    }

    // Initialize persistence strategy
    this.persistenceStrategy = options.persistenceStrategy ||
      new HybridPersistenceStrategy(
        [], // No critical namespaces by default
        5 * 60 * 1000, // 5 minutes persistence interval
        options.persistentNamespaces || []
      );

    // Initialize eager loading flag
    this.eagerLoading = options.eagerLoading || false;

    // Initialize the cache asynchronously. Store the promise so callers
    // can await it instead of polling with setInterval.
    this.initPromise = this.initialize().catch(error => {
      logger.error('Error during cache initialization', { error: error instanceof Error ? error.message : String(error) });
    });

    // Register shutdown handlers unless caller manages shutdown itself
    if (options.registerShutdownHandlers !== false) {
      this.registerShutdownHandlers();
    }
  }

  /**
   * Initializes the cache
   *
   * This method:
   * 1. Loads persisted entries from disk if eager loading is enabled
   * 2. Skips loading expired entries
   * 3. Populates both the namespace cache and in-memory cache
   * 4. Starts the persistence timer based on the strategy
   *
   * Eager loading improves startup performance for frequently accessed entries
   * but increases initial memory usage and startup time.
   *
   * @private
   */
  private async initialize(): Promise<void> {
    try {
      if (this.eagerLoading) {
        try {
          // Load all entries at once
          const entries = await this.persistenceManager.loadAllEntries();

          // Add entries to the in-memory cache
          for (const [namespace, namespaceEntries] of entries.entries()) {
            // Create namespace map if it doesn't exist
            if (!this.namespaceCache.has(namespace)) {
              this.namespaceCache.set(namespace, new Map());
            }

            // Add entries to the namespace map
            const namespaceMap = this.namespaceCache.get(namespace)!;
            for (const [key, entry] of namespaceEntries.entries()) {
              // Skip expired entries
              if (entry.expiresAt <= this.now()) { // Use this.now()
                continue;
              }

              // Add to namespace map
              namespaceMap.set(key, entry);

              // Add to in-memory cache
              super.set(this.generateFullKey(namespace, key), entry);
            }
          }
        } catch (loadError) {
          try {
            logger.error('Error loading entries from persistent storage', { error: loadError instanceof Error ? loadError.message : String(loadError) });
          } catch (_) {
            // Ignore logger errors during shutdown
          }
          // Continue with empty cache even if loading fails
        }
      }

      // Start persistence timer if needed
      this.startPersistenceTimer();

      // Mark initialization as complete
      this.isInitialized = true;
    } catch (error) {
      try {
        logger.error('Error initializing persistent cache', { error: error instanceof Error ? error.message : String(error) });
      } catch (_) {
        // Ignore logger errors during shutdown
      }
      // Continue with empty cache
      this.isInitialized = true;
    }
  }

  /**
   * Registers shutdown handlers to ensure cache is persisted before exit
   *
   * This method sets up handlers for:
   * - Normal process exit
   * - SIGINT (Ctrl+C)
   * - SIGTERM (termination signal)
   * - Uncaught exceptions
   *
   * Each handler attempts to persist the cache to disk before exiting,
   * ensuring data durability even during abnormal termination.
   *
   * Special handling is provided for EPIPE errors, which can occur when
   * the parent process terminates unexpectedly.
   *
   * @private
   */
  // Store bound handler functions so we can remove them later.
  // The 'exit' handler must stay synchronous — no async I/O is possible once
  // the event loop is draining. Signal handlers use an async-first approach:
  // attempt async persistToDisk() with a grace period, falling back to
  // persistSync() only if the async path times out or fails.

  private exitHandler = () => this.persistSync();

  private attemptAsyncPersistThenExit(exitCode: number): void {
    if (process.env.NODE_ENV === 'test' || process.env.JEST_WORKER_ID) {
      // In tests, just persist synchronously without exiting
      this.persistSync();
      return;
    }

    const GRACE_MS = 5000;
    let settled = false;

    const finish = () => {
      if (settled) return;
      settled = true;
      process.exit(exitCode);
    };

    // Race: async persist vs grace-period timeout
    this.persistToDisk()
      .catch(() => {
        // Async failed — fall back to sync
        this.persistSync();
      })
      .finally(finish);

    // If async takes too long, fall back to sync + exit
    setTimeout(() => {
      if (!settled) {
        this.persistSync();
        finish();
      }
    }, GRACE_MS).unref();
  }

  private sigintHandler = () => {
    try { logger.info('Persisting cache before exit (SIGINT)'); } catch (_) { /* ignore */ }
    this.attemptAsyncPersistThenExit(0);
  };
  private sigtermHandler = () => {
    try { logger.info('Persisting cache before exit (SIGTERM)'); } catch (_) { /* ignore */ }
    this.attemptAsyncPersistThenExit(0);
  };
  private sighupHandler = () => {
    try { logger.info('Persisting cache before exit (SIGHUP)'); } catch (_) { /* ignore */ }
    this.attemptAsyncPersistThenExit(0);
  };
  private uncaughtExceptionHandler = (error: Error) => {
    if ((error as NodeJS.ErrnoException).code === 'EPIPE') {
      this.stopPersistenceTimer();
      return;
    }
    try {
      logger.error('Uncaught exception, persisting cache before exit', { error: error.message });
    } catch (_) { /* ignore */ }
    this.attemptAsyncPersistThenExit(1);
  };

  private registerShutdownHandlers(): void {
    // Always register handlers — dispose() will properly clean them up.
    // Signal handlers are guarded to not call process.exit() in test env.
    this.handlersRegistered = true;

    // Each PersistentCache instance adds 5 listeners. Increase max if needed
    // to avoid warnings when multiple instances exist (e.g., during tests).
    const needed = process.listenerCount('SIGINT') + 5;
    if (needed > process.getMaxListeners()) {
      process.setMaxListeners(needed + 5);
    }

    process.on('exit', this.exitHandler);
    process.on('SIGINT', this.sigintHandler);
    process.on('SIGTERM', this.sigtermHandler);
    process.on('SIGHUP', this.sighupHandler);
    process.on('uncaughtException', this.uncaughtExceptionHandler);
  }

  /**
   * Starts the persistence timer if needed
   *
   * Based on the persistence strategy, this may:
   * - Set up a periodic timer to persist cache entries
   * - Skip timer creation if the strategy doesn't use periodic persistence
   *
   * The timer is configured to not prevent Node.js from exiting when it's
   * the only active handle (using unref()).
   *
   * @private
   */
  private startPersistenceTimer(): void {
    // Do not start the timer in the test environment to prevent open handles
    if (process.env.NODE_ENV === 'test') {
      return;
    }

    const interval = this.persistenceStrategy.getPersistenceInterval();

    if (interval !== null && interval > 0) {
      this.persistenceTimer = setInterval(() => {
        // Wrap in try-catch to prevent uncaught exceptions from timer callbacks
        try {
          this.persistToDisk().catch(error => {
            // If we get an EPIPE error, stop the timer
            if ((error as NodeJS.ErrnoException).code === 'EPIPE') {
              this.stopPersistenceTimer();
            }
          });
        } catch (error) {
          // If we get an EPIPE error, stop the timer
          if ((error as NodeJS.ErrnoException).code === 'EPIPE') {
            this.stopPersistenceTimer();
          }
        }
      }, interval);

      // Ensure timer doesn't prevent Node from exiting
      if (this.persistenceTimer.unref) {
        this.persistenceTimer.unref();
      }
    }
  }

  /**
   * Stops the persistence timer
   *
   * Cancels any scheduled persistence operations.
   * Used during shutdown or when reconfiguring the cache.
   *
   * @private
   */
  private stopPersistenceTimer(): void {
    if (this.persistenceTimer) {
      clearInterval(this.persistenceTimer);
      this.persistenceTimer = null;
    }
  }

  /**
   * Generates a full cache key from namespace and key
   *
   * Creates a composite key in the format "namespace:key" that uniquely
   * identifies an entry across all namespaces.
   *
   * @param namespace - The namespace
   * @param key - The key within the namespace (this should be the HASHED key)
   * @returns The full cache key
   * @private
   */
  private generateFullKey(namespace: string, key: string): string {
    // Key passed here is expected to be the hashed key already
    return `${namespace}:${key}`;
  }

  /**
   * Parses a full cache key into namespace and key components
   *
   * Splits a composite key in the format "namespace:key" into its
   * constituent parts. Handles edge cases like missing colons.
   *
   * @param fullKey - The full cache key (namespace:hashedKey)
   * @returns Object containing namespace and key (hashedKey)
   * @private
   */
  private parseFullKey(fullKey: string): { namespace: string; key: string } {
    const firstColonIndex = fullKey.indexOf(':');
    if (firstColonIndex === -1) {
      // Default to empty namespace if no colon
      return { namespace: '', key: fullKey };
    }

    const namespace = fullKey.substring(0, firstColonIndex);
    const key = fullKey.substring(firstColonIndex + 1); // This part is the hashed key
    return { namespace, key };
  }

  /**
   * Gets the total number of entries in the cache
   *
   * Counts entries across all namespaces in the namespace cache.
   * Used for statistics and monitoring.
   *
   * @returns The total number of entries
   * @private
   */
  private getEntryCount(): number {
    let count = 0;
    for (const namespaceEntries of this.namespaceCache.values()) {
      count += namespaceEntries.size;
    }
    return count;
  }

  /**
   * Sets a value in the cache with persistence support
   *
   * This method:
   * 1. Sets the value in the in-memory cache (via super.set)
   * 2. Updates the namespace cache for organization
   * 3. Persists to disk if required by the persistence strategy
   * 4. Marks the cache as dirty for periodic persistence
   *
   * @param fullKey - The full cache key (namespace:hashedKey)
   * @param entry - The cache entry
   * @protected - Available to subclasses but not external code
   */
  protected async set(fullKey: string, entry: CacheEntry<any>): Promise<void> {
    // Parse the full key to get namespace and hashedKey
    const { namespace, key: hashedKey } = this.parseFullKey(fullKey);

    // Set in the in-memory cache using the full key
    super.set(fullKey, entry);

    // Add to namespace cache using the hashedKey
    if (!this.namespaceCache.has(namespace)) {
      this.namespaceCache.set(namespace, new Map());
    }
    this.namespaceCache.get(namespace)!.set(hashedKey, entry); // Store by hashedKey

    // Mark as dirty for periodic persistence
    this.isDirty = true;

    // Persist if needed (using hashedKey)
    if (this.persistenceStrategy.shouldPersistOnSet(namespace, hashedKey, entry)) {
      try {
        await this.persistenceManager.saveEntry(namespace, hashedKey, entry); // Use hashedKey for persistence
      } catch (error) {
        try {
          logger.error('Error persisting cache entry', { namespace, key: hashedKey, error: error instanceof Error ? error.message : String(error) });
        } catch (_) {
          // Ignore logger errors during shutdown
        }
      }
    }
  }

  /**
   * Gets a value from the cache with persistence support
   *
   * This method implements a multi-level lookup strategy:
   * 1. First checks the in-memory cache for performance
   * 2. If not found and not using eager loading, tries to load from disk
   * 3. If found on disk, adds to in-memory cache for future requests
   * 4. Optionally persists the entry if required by the strategy
   *
   * This approach provides a balance between performance and durability.
   *
   * @param fullKey - The full cache key (namespace:hashedKey)
   * @returns The cache entry, or undefined if not found
   * @private
   */
  private async getWithPersistence(fullKey: string): Promise<CacheEntry<any> | undefined> {
    // Parse the full key
    const { namespace, key: hashedKey } = this.parseFullKey(fullKey);

    // Try to get from in-memory cache first (super.get updates accessLog)
    let entry = super.get(fullKey);

    // If found in memory, check if it's expired (it might be stale but valid)
    if (entry && entry.expiresAt <= this.now() && (!entry.staleUntil || entry.staleUntil <= this.now())) {
        entry = undefined; // Treat expired entry as not found in memory
        this.cache.delete(fullKey); // Clean up expired entry from memory explicitly
        this.accessLog.delete(fullKey);
    }

    // If not found in memory (or was expired) AND not eager loading, try disk
    if (!entry && !this.eagerLoading) {
      try {
        const persistedEntry = await this.persistenceManager.loadEntry(namespace, hashedKey); // Load using hashedKey

        // If found on disk, add to in-memory cache
        if (persistedEntry) {
          // Skip expired entries
          if (persistedEntry.expiresAt <= this.now()) { // Use this.now()
             // Optionally remove expired entry from disk here
             this.persistenceManager.removeEntry(namespace, hashedKey).catch(err => logger.error("Failed to remove expired entry from disk", { namespace, key: hashedKey, error: err instanceof Error ? err.message : String(err) }));
             return undefined;
          }

          // Add to in-memory cache using fullKey (this also updates accessLog)
          super.set(fullKey, persistedEntry);
          entry = persistedEntry; // Update the entry variable to be returned

          // Add to namespace cache using hashedKey
          if (!this.namespaceCache.has(namespace)) {
            this.namespaceCache.set(namespace, new Map());
          }
          this.namespaceCache.get(namespace)!.set(hashedKey, persistedEntry);
        }
      } catch (error) {
        try {
          logger.error('Error loading cache entry from disk', { namespace, key: hashedKey, error: error instanceof Error ? error.message : String(error) });
        } catch (_) {
          // Ignore logger errors during shutdown
        }
      }
    }

    // If entry is found and should be persisted on get, persist it (using hashedKey)
    if (entry && this.persistenceStrategy.shouldPersistOnGet(namespace, hashedKey, entry)) {
      this.persistenceManager.saveEntry(namespace, hashedKey, entry) // Use hashedKey
        .catch(error => {
          try {
            logger.error('Error persisting cache entry on get', { namespace, key: hashedKey, error: error instanceof Error ? error.message : String(error) });
          } catch (_) {
            // Ignore logger errors during shutdown
          }
        });
    }

    return entry;
  }

  /**
   * Override the getOrCompute method to add persistence support
   *
   * This implementation:
   * 1. Waits for initialization to complete
   * 2. Uses the persistence-aware getWithPersistence method
   * 3. Handles stale-while-revalidate pattern
   * 4. Stores computed values with appropriate persistence
   *
   * @param namespace - The namespace to scope this key to
   * @param args - The arguments to generate the cache key
   * @param computeFn - Function to compute the value if not in cache
   * @param options - Additional options for this specific cache operation
   * @returns The cached or computed value
   */
  async getOrCompute<T>(
    namespace: string,
    args: any,
    computeFn: () => Promise<T>,
    options: {
      ttl?: number;
      staleWhileRevalidate?: boolean;
      staleTime?: number;
    } = {}
  ): Promise<T> {
    // Wait for initialization to complete (all callers share one promise)
    if (!this.isInitialized) {
      await this.initPromise;
    }

    // Generate the hashed key and full key
    const hashedKey = super.generateKey(namespace, args); // Use base class to hash args
    const fullKey = this.generateFullKey(namespace, hashedKey); // Construct full key

    // Try to get from cache using the persistence-aware method
    const cached = await this.getWithPersistence(fullKey);

    // Case 1: Fresh cache hit
    if (cached && cached.expiresAt > this.now()) { // Use this.now()
      this.metrics.hits++; // FIX: Increment hits (metrics is now protected)
      return cached.value;
    }

    // Case 2: Stale cache hit with stale-while-revalidate enabled
    const staleWhileRevalidate = options.staleWhileRevalidate ?? false;

    if (staleWhileRevalidate && cached && cached.staleUntil && cached.staleUntil > this.now()) { // Use this.now()
      // Value is stale but still usable - trigger background refresh
      this.metrics.hits++; // FIX: Increment hits (stale hit) (metrics is now protected)

      // Background revalidation (don't await) - pass hashedKey
      this.revalidateInBackground(namespace, args, hashedKey, computeFn, options);

      return cached.value;
    }

    // Case 3: Cache miss or expired stale content
    this.metrics.misses++; // FIX: Increment misses (metrics is now protected)
    // Compute the value
    const value = await computeFn();

    // Store in cache
    const currentTime = this.now(); // Use this.now()
    const ttl = options.ttl || this.defaultTTL;
    const entry: CacheEntry<T> = {
      value,
      expiresAt: currentTime + ttl, // Use currentTime
      staleUntil: options.staleWhileRevalidate ? currentTime + ttl + (options.staleTime ?? 60 * 1000) : undefined // Use currentTime
    };

    // Set in cache using the full key
    await this.set(fullKey, entry);

    return value;
  }

  /**
   * Override the revalidateInBackground method to add persistence
   *
   * This implementation ensures that background revalidation:
   * 1. Computes fresh values asynchronously
   * 2. Stores them in both memory and disk according to the persistence strategy
   * 3. Properly handles errors without affecting the main request flow
   *
   * @param namespace - The namespace of the entry
   * @param args - The arguments used to generate the key
   * @param key - The HASHED cache key (passed from getOrCompute)
   * @param computeFn - Function to recompute the value
   * @param options - Cache options for the revalidated entry
   * @protected - Available to subclasses but not external code
   */
  protected async revalidateInBackground(
    namespace: string,
    args: any, // Keep args for potential future use, though key is already hashed
    key: string, // This is the HASHED key
    computeFn: () => Promise<any>,
    options: { ttl?: number; staleTime?: number; staleWhileRevalidate?: boolean } = {}
  ): Promise<void> {
    try {
      // Compute the value
      const value = await computeFn();

      // Store in cache
      const currentTime = this.now(); // Use this.now()
      const ttl = options.ttl || this.defaultTTL;
      const entry: CacheEntry<any> = {
        value,
        expiresAt: currentTime + ttl, // Use currentTime
        staleUntil: options.staleWhileRevalidate ? currentTime + ttl + (options.staleTime ?? 60 * 1000) : undefined // Use currentTime
      };

      // Set in cache using the full key (namespace + hashed key)
      const fullKey = this.generateFullKey(namespace, key);
      this.set(fullKey, entry);
    } catch (error) {
      // Log but don't throw - this is a background operation
      try {
        logger.error('Background revalidation failed', { namespace, error: error instanceof Error ? error.message : String(error) });
      } catch (_) {
        // Ignore logger errors during shutdown
      }
    }
  }

  /**
   * Override the invalidate method to add persistence
   *
   * This implementation ensures that invalidation:
   * 1. Removes entries from the in-memory cache
   * 2. Removes entries from the namespace cache
   * 3. Removes entries from disk storage
   *
   * This provides complete invalidation across all storage layers.
   *
   * @param namespace - The namespace of the entry
   * @param args - The arguments used to generate the key
   */
  async invalidate(namespace: string, args: any): Promise<void> {
    // Generate the hashed key
    const key = super.generateKey(namespace, args); // Use base class to hash args
    const fullKey = this.generateFullKey(namespace, key); // Construct full key

    // Remove from in-memory cache using base invalidate (which uses generateKey)
    // This deletes from this.cache and this.accessLog
    super.invalidate(namespace, args);
    this.cache.delete(fullKey); // Explicitly delete again to be sure

    // Also remove from namespace cache using the hashed key
    if (this.namespaceCache.has(namespace)) {
      this.namespaceCache.get(namespace)!.delete(key);
      // If namespace becomes empty, remove it
      if (this.namespaceCache.get(namespace)!.size === 0) {
          this.namespaceCache.delete(namespace);
      }
    }

    // Remove from disk using the hashed key
    try {
      await this.persistenceManager.removeEntry(namespace, key); // Use hashed key
    } catch (error) {
      try {
        logger.error('Error removing cache entry from disk', { namespace, key, error: error instanceof Error ? error.message : String(error) });
      } catch (_) {
        // Ignore logger errors during shutdown
      }
    }
  }

  /**
   * Override the clear method to add persistence
   *
   * This implementation ensures that clearing:
   * 1. Removes all entries from the in-memory cache
   * 2. Removes all entries from the namespace cache
   * 3. Removes all entries from disk storage
   *
   * This provides a complete reset of the cache across all storage layers.
   */
  clear(): void {
    // Clear in-memory cache
    super.clear();

    // Clear namespace cache
    this.namespaceCache.clear();

    // Clear disk cache
    this.persistenceManager.clear()
      .catch(error => {
        try {
          logger.error('Error clearing persistent cache', { error: error instanceof Error ? error.message : String(error) });
        } catch (_) {
          // Ignore logger errors during shutdown
        }
      });
  }

  /**
   * Persists the cache to disk
   *
   * This method:
   * 1. Checks if the cache is dirty (has changes)
   * 2. Skips persistence if no changes have been made
   * 3. Uses the persistence manager to save all entries
   * 4. Resets the dirty flag after successful persistence
   *
   * @returns A promise that resolves when the cache is persisted
   */
  async persistToDisk(): Promise<void> {
    if (!this.isDirty) return;

    try {
      this.isDirty = false;

      // Filter out expired entries before persisting to avoid wasting I/O
      const now = this.now();
      const filtered = new Map<string, Map<string, CacheEntry<any>>>();
      for (const [ns, entries] of this.namespaceCache) {
        const live = new Map<string, CacheEntry<any>>();
        for (const [key, entry] of entries) {
          if (entry.expiresAt > now) live.set(key, entry);
        }
        if (live.size > 0) filtered.set(ns, live);
      }

      await this.persistenceManager.saveAllEntries(filtered);
    } catch (error) {
      // Restore dirty flag so next cycle retries
      this.isDirty = true;
      try {
        logger.error('Error persisting cache to disk', { error: error instanceof Error ? error.message : String(error) });
      } catch (_) {
        // Ignore logger errors during shutdown
      }
      throw error;
    }
  }

  /**
   * Persists the cache to disk synchronously
   *
   * This method is specifically designed for shutdown scenarios where
   * asynchronous operations might not complete before process termination.
   *
   * It uses synchronous file operations to ensure data is written to disk
   * before the process exits, even if it's being terminated.
   *
   * Implementation details:
   * 1. Uses Node.js fs synchronous methods instead of async ones
   * 2. Creates directories if they don't exist
   * 3. Writes each namespace and entry to disk
   * 4. Creates a metadata file with cache statistics
   *
   * @private
   */
  private persistSync(): void {
    if (!this.isDirty) {
      return;
    }

    try {
      // Use a synchronous file write
      // This is not ideal, but it's the only way to ensure the cache is persisted before exit

      // We can't use the persistence manager directly because it's async
      // Instead, we'll use the imported Node.js fs module directly

      // Create the storage directory if it doesn't exist
      const storagePath = (this.persistenceManager as PersistenceManager).storagePath;
      if (!fs.existsSync(storagePath)) {
        fs.mkdirSync(storagePath, { recursive: true });
      }

      // Create the namespaces directory if it doesn't exist
      const namespacesPath = path.join(storagePath, 'namespaces');
      if (!fs.existsSync(namespacesPath)) {
        fs.mkdirSync(namespacesPath, { recursive: true });
      }

      // Write each namespace to disk, capped to prevent hanging on huge caches
      const MAX_SYNC_WRITES = 2000;
      let writeCount = 0;
      for (const [namespace, namespaceEntries] of this.namespaceCache.entries()) {
        if (writeCount >= MAX_SYNC_WRITES) break;

        // Create the namespace directory if it doesn't exist
        const namespacePath = path.join(namespacesPath, encodeURIComponent(namespace));
        if (!fs.existsSync(namespacePath)) {
          fs.mkdirSync(namespacePath, { recursive: true });
        }

        // Write each entry to disk
        for (const [hashedKey, entry] of namespaceEntries.entries()) { // Iterate over hashed keys
          if (writeCount >= MAX_SYNC_WRITES) break;

          // Skip expired entries
          if (entry.expiresAt <= this.now()) { // Use this.now()
            continue;
          }

          // Construct path using the hashed key
          const entryPath = path.join(namespacePath, `${hashedKey}.json`);

          // Serialize the entry (using the hashed key)
          const serializedEntry = {
            key: hashedKey, // Store the hashed key
            value: entry.value,
            metadata: {
              createdAt: this.now(), // Use this.now()
              expiresAt: entry.expiresAt,
              staleUntil: entry.staleUntil,
              size: JSON.stringify(entry.value).length,
              contentType: typeof entry.value === 'object' ? 'application/json' : undefined
            }
          };

          // Write to disk
          fs.writeFileSync(entryPath, JSON.stringify(serializedEntry, null, 2), 'utf8');
          writeCount++;
        }
      }

      // Write metadata
      const metadataPath = path.join(storagePath, 'metadata.json');
      const metadata = {
        version: '1.0.0',
        lastPersisted: this.now(), // Use this.now()
        stats: {
          totalEntries: this.getEntryCount(),
          totalSize: 0 // We don't calculate this for sync persistence
        }
      };
      fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2), 'utf8');
    } catch (error) {
      try {
        logger.error('Error persisting cache synchronously', { error: error instanceof Error ? error.message : String(error) });
      } catch (_) {
        // Ignore logger errors during shutdown
      }
    }
  }

  /**
   * Loads the cache from disk
   *
   * This method:
   * 1. Clears the current in-memory cache
   * 2. Loads all entries from disk using the persistence manager
   * 3. Filters out expired entries
   * 4. Populates both the namespace cache and in-memory cache
   *
   * @returns A promise that resolves when the cache is loaded
   */
  async loadFromDisk(): Promise<void> {
    try { // Restore the outer try block for loadFromDisk
      // Clear in-memory cache first
      super.clear();
      this.namespaceCache.clear();

      // Load all entries
      const entries = await this.persistenceManager.loadAllEntries();

      // Add entries to the in-memory cache
      for (const [namespace, namespaceEntries] of entries.entries()) {
        // Create namespace map if it doesn't exist
        if (!this.namespaceCache.has(namespace)) {
          this.namespaceCache.set(namespace, new Map());
        }

        // Add entries to the namespace map
        const namespaceMap = this.namespaceCache.get(namespace)!;
        for (const [hashedKey, entry] of namespaceEntries.entries()) { // Key from loadAllEntries is the hashed key
          // Skip expired entries
          if (entry.expiresAt <= this.now()) { // Use this.now()
            continue;
          }

          // Add to namespace map using hashedKey
          namespaceMap.set(hashedKey, entry);

          // Add to in-memory cache using full key (namespace:hashedKey)
          const fullKey = this.generateFullKey(namespace, hashedKey);
          super.set(fullKey, entry);
        }
      }
    } catch (error) {
      try {
        logger.error('Error loading cache from disk', { error: error instanceof Error ? error.message : String(error) });
      } catch (_) {
        // Ignore logger errors during shutdown
      }
      throw error;
    }
  }

  /**
   * Gets extended cache stats including persistence info
   *
   * Extends the base cache statistics with persistence-specific information:
   * - Whether the cache has unsaved changes (isDirty)
   * - Number of namespaces in the cache
   * - Number of entries that will be persisted
   *
   * @returns Extended statistics object
   */
  getStats(): {
    size: number;
    pendingPromises: number;
    metrics: {
      hits: number;
      misses: number;
      errors: number;
      evictions: number;
      hitRatio: string;
    };
    persistence: {
      isDirty: boolean;
      namespaces: number;
      persistedEntries: number;
    };
  } {
    // Get base stats
    const baseStats = super.getStats();

    // Add persistence stats
    return {
      ...baseStats,
      persistence: {
        isDirty: this.isDirty,
        namespaces: this.namespaceCache.size,
        persistedEntries: this.getEntryCount()
      }
    };
  }

  /**
   * Cleans up resources when the cache is no longer needed
   *
   * This method:
   * 1. Stops the persistence timer to prevent further disk writes
   * 2. Attempts to persist any dirty entries before disposal
   * 3. Handles errors gracefully during shutdown
   *
   * Call this method when shutting down the application or
   * when the cache instance is no longer needed.
   */
  async dispose(): Promise<void> {
    try {
      if (process.env.NODE_ENV !== 'test') {
        logger.info('Disposing PersistentCache');
      }
    } catch (_) {
      // Ignore logger errors during shutdown
    }

    // Stop the persistence timer first
    this.stopPersistenceTimer();

    // Persist any dirty entries (but don't wait too long in tests)
    if (this.isDirty) {
      try {
        const persistPromise = this.persistToDisk();
        
        // In test environment, use a shorter timeout to prevent hanging
        if (process.env.NODE_ENV === 'test' || process.env.JEST_WORKER_ID) {
          await Promise.race([
            persistPromise,
            new Promise((_, reject) =>
              setTimeout(() => reject(new Error('Persist timeout during test disposal')), 1000)
            )
          ]);
        } else {
          await persistPromise;
        }
        
        try {
          if (process.env.NODE_ENV !== 'test') {
            logger.info('Cache persisted successfully during disposal');
          }
        } catch (_) {
          // Ignore logger errors during shutdown
        }
      } catch (error) {
        try {
          if (process.env.NODE_ENV !== 'test') {
            logger.error('Error persisting cache during disposal', { error: error instanceof Error ? error.message : String(error) });
          }
        } catch (_) {
          // Ignore logger errors during shutdown
        }
        // Don't re-throw in test environment to prevent hanging
      }
    } else {
       try {
          if (process.env.NODE_ENV !== 'test') {
            logger.debug('No dirty entries to persist during disposal');
          }
        } catch (_) {
          // Ignore logger errors during shutdown
        }
    }

    // Remove all event listeners if they were registered
    if (this.handlersRegistered) {
      process.removeListener('exit', this.exitHandler);
      process.removeListener('SIGINT', this.sigintHandler);
      process.removeListener('SIGTERM', this.sigtermHandler);
      process.removeListener('SIGHUP', this.sighupHandler);
      process.removeListener('uncaughtException', this.uncaughtExceptionHandler);
      this.handlersRegistered = false;
    }

    // Clear all internal data structures to help with garbage collection
    this.namespaceCache.clear();
    
    // Call the base class dispose to clear its resources (like the cleanup interval)
    await super.dispose();

    try {
      if (process.env.NODE_ENV !== 'test') {
        logger.info('PersistentCache disposed');
      }
    } catch (_) {
      // Ignore logger errors during shutdown
    }
  }

  /**
   * Override evictLRUEntries to also remove from persistence
   * @param count Number of entries to evict
   * @protected - Changed from private in base class
   */
  // This method overrides the base class evictLRUEntries
  protected async evictLRUEntries(count: number): Promise<void> {
    // Ensure count is valid
    if (count <= 0) return;

    // Get keys sorted by last access time (oldest first)
    const sortedKeys = [...this.accessLog.entries()]
      .sort(([, timeA], [, timeB]) => timeA - timeB)
      .map(([key]) => key)
      .slice(0, count); // Get the 'count' oldest keys

    let actualEvictedCount = 0;
    const removePromises: Promise<void>[] = [];

    for (const fullKey of sortedKeys) {
        // Remove from memory (base cache and access log)
        if (this.cache.delete(fullKey)) {
            this.accessLog.delete(fullKey);
            this.metrics.evictions++;
            actualEvictedCount++;

            // Remove from namespace cache and persistence layer
            const { namespace, key: hashedKey } = this.parseFullKey(fullKey);
            if (this.namespaceCache.has(namespace)) {
                this.namespaceCache.get(namespace)!.delete(hashedKey);
                if (this.namespaceCache.get(namespace)!.size === 0) {
                    this.namespaceCache.delete(namespace);
                }
            }
            // Add persistence removal to promises
            removePromises.push(
                this.persistenceManager.removeEntry(namespace, hashedKey).catch(error => {
                    logger.error('Error removing evicted entry from disk', { namespace, key: hashedKey, error: error instanceof Error ? error.message : String(error) });
                    // Don't block other evictions if one fails
                })
            );
        }
    }

    if (actualEvictedCount > 0) {
        logger.debug('Evicted LRU cache entries from memory', { count: actualEvictedCount });
    }

    // Wait for all persistence removals to complete
    await Promise.all(removePromises);
  }
}
