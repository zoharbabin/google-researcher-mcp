// src/cache/cache.ts
import { createHash } from "crypto";
import { CacheEntry } from "./types.js";
import { logger } from "../shared/logger.js";

/**
 * Generic in-memory cache implementation with advanced features
 *
 * This cache provides:
 * - Time-to-live (TTL) expiration for entries
 * - Promise coalescing to prevent cache stampedes
 * - Stale-while-revalidate pattern for improved performance
 * - Least Recently Used (LRU) eviction policy
 * - Automatic cleanup of expired entries
 * - Comprehensive metrics for monitoring
 *
 * Cache stampede prevention: When multiple requests for the same uncached key arrive
 * simultaneously, only one computation is performed while others wait for the result.
 *
 * @see https://en.wikipedia.org/wiki/Cache_stampede
 * @see https://web.dev/stale-while-revalidate/ for stale-while-revalidate pattern
 */
export class Cache {
  protected cache: Map<string, CacheEntry<any>> = new Map();
  private pendingPromises: Map<string, Promise<any>> = new Map();
  protected defaultTTL: number;
  private maxSize: number; // Changed from protected to private
  protected accessLog: Map<string, number> = new Map(); // Track last access time for LRU eviction
  protected metrics = { // Changed from private to protected
    hits: 0,
    misses: 0,
    errors: 0,
    evictions: 0
  };
  private cleanupIntervalId: NodeJS.Timeout | null = null; // Added to store interval ID

  /**
   * Returns the current time in milliseconds.
   * Can be overridden in tests to control time.
   * @protected
   */
  protected now(): number {
    return Date.now();
  }

  /**
   * Creates a new Cache instance
   *
   * @param options - Configuration options
   * @param options.defaultTTL - Default time-to-live in milliseconds (default: 5 minutes)
   * @param options.maxSize - Maximum number of entries before LRU eviction (default: 1000)
   */
  constructor(options: { defaultTTL?: number; maxSize?: number } = {}) {
    this.defaultTTL = options.defaultTTL || 5 * 60 * 1000; // 5 minutes default
    this.maxSize = options.maxSize || 1000; // Default max 1000 entries
    
    // Periodically clean expired entries, but not in test environment
    if (process.env.NODE_ENV !== 'test') {
      this.cleanupIntervalId = setInterval(() => {
        try {
          this.cleanExpiredEntries();
        } catch (error) {
          logger.error("Error during periodic cache cleanup", { error: error instanceof Error ? error.message : String(error) });
        }
      }, 60 * 1000); // Every minute

      // Ensure the timer doesn't prevent the process from exiting
      if (this.cleanupIntervalId?.unref) {
        this.cleanupIntervalId.unref();
      }
    } else {
      this.cleanupIntervalId = null; // Ensure it's null in tests
    }
  }

  /**
   * Generate a deterministic cache key from function arguments
   *
   * Creates a SHA-256 hash of the stringified arguments to ensure:
   * - Consistent key generation for the same arguments
   * - Keys of reasonable length regardless of argument size
   * - Support for complex nested objects as arguments
   *
   * @param namespace - The namespace to scope this key to
   * @param args - The arguments to hash
   * @returns A unique cache key string
   */
  generateKey(namespace: string, args: any): string {
    const argsStr = JSON.stringify(args);
    return `${namespace}:${createHash('sha256').update(argsStr).digest('hex')}`;
  }

  /**
   * Get a value from cache or compute it if not present
   *
   * This is the core method of the cache, implementing:
   * 1. Cache lookup with TTL checking
   * 2. Stale-while-revalidate pattern when enabled
   * 3. Promise coalescing to prevent cache stampedes
   * 4. Automatic storage of computed values
   *
   * The stale-while-revalidate pattern allows serving stale content while
   * refreshing the cache in the background, improving perceived performance.
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
      staleWhileRevalidate?: boolean; // Enable stale-while-revalidate pattern
      staleTime?: number; // How long after expiry the value is still usable while revalidating
    } = {}
  ): Promise<T> {
    const key = this.generateKey(namespace, args);
    const ttl = options.ttl || this.defaultTTL;
    
    const currentTime = this.now(); // Use this.now()
    const cached = this.cache.get(key);
    
    // Case 1: Fresh cache hit
    if (cached && cached.expiresAt > currentTime) { // Use currentTime
      // Update access time for LRU tracking
      this.accessLog.set(key, currentTime); // Use currentTime
      this.metrics.hits++;
      return cached.value;
    }
    
    // Case 2: Stale cache hit with stale-while-revalidate enabled
    const staleWhileRevalidate = options.staleWhileRevalidate ?? false;
    const staleTime = options.staleTime ?? 60 * 1000; // Default 1 minute stale time
    
    if (staleWhileRevalidate && cached && cached.staleUntil && cached.staleUntil > currentTime) { // Use currentTime
      // Value is stale but still usable - trigger background refresh
      this.metrics.hits++;
      logger.debug("Serving stale content while revalidating", { namespace });
      
      // Background revalidation (don't await)
      this.revalidateInBackground(namespace, args, key, computeFn, options);
      
      return cached.value;
    }
    
    // Case 3: Cache miss or expired stale content
    this.metrics.misses++;
    
    // If there's already a pending promise for this key, return it
    // This prevents cache stampedes by coalescing concurrent requests
    if (this.pendingPromises.has(key)) {
      return this.pendingPromises.get(key);
    }
    
    // Otherwise, compute the value
    try {
      const promise = computeFn();
      this.pendingPromises.set(key, promise);
      
      const value = await promise;
      
      const storeTime = this.now(); // Use this.now()
      // Store in cache with expiration and optional stale-until time
      this.set(key, {
        value,
        expiresAt: storeTime + ttl, // Use storeTime
        staleUntil: options.staleWhileRevalidate ? storeTime + ttl + (options.staleTime ?? 60 * 1000) : undefined // Use storeTime
      });
      
      return value;
    } catch (error) {
      // Don't cache errors
      logger.error("Cache computation error", { namespace, error: error instanceof Error ? error.message : String(error) });
      this.metrics.errors++;
      throw error;
    } finally {
      // Clean up pending promise
      this.pendingPromises.delete(key);
    }
  }

  /**
   * Revalidate a cache entry in the background without blocking
   *
   * This is a key part of the stale-while-revalidate pattern:
   * 1. The main request thread returns stale data immediately
   * 2. This method runs asynchronously to refresh the cache
   * 3. Future requests get fresh data without waiting
   *
   * @param namespace - The namespace of the entry
   * @param args - The arguments used to generate the key
   * @param key - The cache key
   * @param computeFn - Function to recompute the value
   * @param options - Cache options for the revalidated entry
   */
  protected async revalidateInBackground(
    namespace: string,
    args: any,
    key: string,
    computeFn: () => Promise<any>,
    options: { ttl?: number; staleTime?: number; staleWhileRevalidate?: boolean } = {}
  ): Promise<void> {
    try {
      // Don't coalesce background revalidations to avoid blocking
      const value = await computeFn();
      const ttl = options.ttl || this.defaultTTL;
      const storeTime = this.now(); // Use this.now()
      
      // Update the cache with fresh value
      this.set(key, {
        value,
        expiresAt: storeTime + ttl, // Use storeTime
        staleUntil: options.staleWhileRevalidate ? storeTime + ttl + (options.staleTime ?? 60 * 1000) : undefined // Use storeTime
      });
      
      logger.debug("Background revalidation completed", { namespace });
    } catch (error) {
      // Log but don't throw - this is a background operation
      logger.error("Background revalidation failed", { namespace, error: error instanceof Error ? error.message : String(error) });
      // Keep the stale value in cache
    }
  }

  /**
   * Manually invalidate a cache entry
   *
   * Removes an entry from the cache, forcing the next request to recompute it.
   * Useful for clearing stale data after updates or when data is known to be invalid.
   *
   * @param namespace - The namespace of the entry
   * @param args - The arguments used to generate the key
   */
  invalidate(namespace: string, args: any): void {
    const key = this.generateKey(namespace, args);
    this.cache.delete(key);
    this.accessLog.delete(key);
  }

  /**
   * Clear all cache entries
   *
   * Completely empties the cache while preserving cumulative metrics.
   * Use this when you need to reset the cache state but keep historical statistics.
   */
  clear(): void {
    this.cache.clear();
    this.accessLog.clear();
    this.pendingPromises.clear();
    
    // Reset metrics except for the total counts
    const totalHits = this.metrics.hits;
    const totalMisses = this.metrics.misses;
    const totalErrors = this.metrics.errors;
    const totalEvictions = this.metrics.evictions;
    
    this.metrics = {
      hits: totalHits,
      misses: totalMisses,
      errors: totalErrors,
      evictions: totalEvictions
    };
  }
  
  /**
   * Clean expired entries from the cache
   *
   * Automatically removes entries that have exceeded their TTL.
   * This runs periodically to prevent memory leaks from abandoned entries.
   *
   * @protected - Changed from private
   */
  protected cleanExpiredEntries(): void { // Changed from private
    const currentTime = this.now(); // Use this.now()
    let expiredCount = 0;
    
    for (const [key, entry] of this.cache.entries()) {
      if (entry.expiresAt <= currentTime) { // Use currentTime
        this.cache.delete(key);
        this.accessLog.delete(key);
        expiredCount++;
      }
    }
    
    if (expiredCount > 0) {
      logger.debug("Cleaned expired cache entries", { count: expiredCount });
    }
  }
  
  /**
   * Evict least recently used entries
   *
   * Implements the LRU (Least Recently Used) eviction policy:
   * 1. Sorts entries by last access time
   * 2. Removes the oldest accessed entries first
   * 3. Typically removes 20% of entries when cache size limit is reached
   *
   * This prevents unbounded growth of the cache while keeping the most useful entries.
   *
   * @param count - Number of entries to evict
   * @protected - Allow subclasses to override or call
   */
  protected evictLRUEntries(count: number): void {
    // Sort by access time (oldest first)
    const sortedEntries = [...this.accessLog.entries()]
      .sort((a, b) => a[1] - b[1])
      .slice(0, count);
    
    for (const [key] of sortedEntries) {
      this.cache.delete(key);
      this.accessLog.delete(key);
      this.metrics.evictions++;
    }
    
    logger.debug("Evicted LRU cache entries", { count: sortedEntries.length });
  }

  /**
   * Get comprehensive cache statistics
   *
   * Returns detailed metrics about cache performance:
   * - Current size (number of entries)
   * - Number of pending promises (in-flight computations)
   * - Hit count and miss count
   * - Error count
   * - Eviction count
   * - Hit ratio as a percentage
   *
   * Useful for monitoring cache effectiveness and diagnosing performance issues.
   *
   * @returns Object containing cache statistics
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
  } {
    const totalRequests = this.metrics.hits + this.metrics.misses;
    const hitRatio = totalRequests > 0
      ? `${(this.metrics.hits / totalRequests * 100).toFixed(2)}%`
      : 'N/A';
    
    return {
      size: this.cache.size,
      pendingPromises: this.pendingPromises.size,
      metrics: {
        ...this.metrics,
        hitRatio
      }
    };
  }

  /**
   * Set a value in the cache
   *
   * Stores an entry in the cache and updates the access log.
   * Triggers LRU eviction if the cache exceeds its maximum size.
   *
   * @param key - The cache key
   * @param entry - The cache entry with value and expiration
   * @protected - Available to subclasses but not external code
   */
  protected set(key: string, entry: CacheEntry<any>): void {
    this.cache.set(key, entry);
    
    // Update access time for LRU tracking
    this.accessLog.set(key, this.now()); // Use this.now()
    
    // Enforce max size by removing least recently used entries if needed
    if (this.cache.size > this.maxSize) {
      this.evictLRUEntries(Math.floor(this.maxSize * 0.2)); // Remove 20% of entries
    }
  }

  /**
   * Get a value from the cache
   *
   * Retrieves an entry and updates its access time for LRU tracking.
   * Does not check expiration - that's handled by getOrCompute.
   *
   * @param key - The cache key
   * @returns The cache entry, or undefined if not found
   * @protected - Available to subclasses but not external code
   */
  protected get(key: string): CacheEntry<any> | undefined {
    const entry = this.cache.get(key);
    
    if (entry) {
      // Update access time for LRU tracking
      this.accessLog.set(key, this.now()); // Use this.now()
    }
    
    return entry;
  }

  /**
   * Dispose of the cache, clearing any timers or intervals
   *
   * Should be called when the cache is no longer needed to prevent resource leaks.
   */
  dispose(): void {
    if (this.cleanupIntervalId) {
      clearInterval(this.cleanupIntervalId);
      this.cleanupIntervalId = null;
    }
    this.cache.clear();
    this.accessLog.clear();
    this.pendingPromises.clear();
  }
}