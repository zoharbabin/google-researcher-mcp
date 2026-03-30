/**
 * Resource Link Support
 *
 * Implements the resource_link content type per MCP spec 2025-11-25.
 * Allows tools to return URI references to resources instead of embedding
 * large content directly in responses.
 *
 * Benefits:
 * - Reduced payload size for large content
 * - Client-side caching of resources
 * - Selective loading by clients
 */

import { randomUUID } from 'node:crypto';

// ── Types ────────────────────────────────────────────────────────────────────

/**
 * Resource link content as per MCP spec
 */
export interface ResourceLinkContent {
  type: 'resource_link';
  uri: string;
  title?: string;
  description?: string;
  mimeType?: string;
}

/**
 * Cached resource entry
 */
interface CachedResource {
  uri: string;
  content: string;
  mimeType: string;
  title?: string;
  createdAt: Date;
  expiresAt: Date;
}

// ── Resource Cache ───────────────────────────────────────────────────────────

/**
 * In-memory cache for resource content
 * Resources expire after 1 hour
 */
const resourceCache = new Map<string, CachedResource>();
const RESOURCE_TTL_MS = 60 * 60 * 1000; // 1 hour
const MAX_RESOURCE_CACHE_SIZE = 500;

/**
 * Cleanup expired resources periodically
 */
function cleanupExpiredResources(): void {
  const now = new Date();
  for (const [uri, resource] of resourceCache.entries()) {
    if (now > resource.expiresAt) {
      resourceCache.delete(uri);
    }
  }
}

// Run cleanup every 10 minutes (skip in test environment).
// .unref() ensures this timer doesn't prevent the process from exiting cleanly.
if (process.env.NODE_ENV !== 'test' && !process.env.JEST_WORKER_ID) {
  setInterval(cleanupExpiredResources, 10 * 60 * 1000).unref();
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Creates a resource link for content
 *
 * @param content - The content to cache
 * @param options - Resource metadata
 * @returns Resource link content object
 */
export function createResourceLink(
  content: string,
  options: {
    title?: string;
    mimeType?: string;
    description?: string;
    namespace?: string;
  } = {}
): ResourceLinkContent {
  const {
    title,
    mimeType = 'text/plain',
    description,
    namespace = 'content',
  } = options;

  // Generate unique URI
  const id = randomUUID();
  const uri = `resource://${namespace}/${id}`;

  // Evict oldest entries if cache is full
  if (resourceCache.size >= MAX_RESOURCE_CACHE_SIZE) {
    cleanupExpiredResources();
    // If still full after expiry cleanup, evict oldest entries
    if (resourceCache.size >= MAX_RESOURCE_CACHE_SIZE) {
      const sorted = [...resourceCache.entries()]
        .sort((a, b) => a[1].createdAt.getTime() - b[1].createdAt.getTime());
      const toRemove = sorted.slice(0, Math.ceil(MAX_RESOURCE_CACHE_SIZE * 0.2));
      for (const [key] of toRemove) {
        resourceCache.delete(key);
      }
    }
  }

  // Cache the content
  const now = new Date();
  resourceCache.set(uri, {
    uri,
    content,
    mimeType,
    title,
    createdAt: now,
    expiresAt: new Date(now.getTime() + RESOURCE_TTL_MS),
  });

  return {
    type: 'resource_link',
    uri,
    title,
    description,
    mimeType,
  };
}

/**
 * Retrieves a cached resource by URI
 *
 * @param uri - The resource URI
 * @returns The cached resource or null if not found/expired
 */
export function getResourceContent(uri: string): CachedResource | null {
  const resource = resourceCache.get(uri);
  if (!resource) {
    return null;
  }

  // Check expiration
  if (new Date() > resource.expiresAt) {
    resourceCache.delete(uri);
    return null;
  }

  return resource;
}

/**
 * Gets all cached resource URIs
 *
 * @returns Array of cached resource URIs
 */
export function listCachedResources(): string[] {
  cleanupExpiredResources();
  return Array.from(resourceCache.keys());
}

/**
 * Clears all cached resources (for testing)
 */
export function clearResourceCache(): void {
  resourceCache.clear();
}

/**
 * Gets statistics about the resource cache
 */
export function getResourceCacheStats(): {
  count: number;
  totalSize: number;
  oldestAge: number | null;
} {
  cleanupExpiredResources();

  let totalSize = 0;
  let oldestDate: Date | null = null;

  for (const resource of resourceCache.values()) {
    totalSize += resource.content.length;
    if (!oldestDate || resource.createdAt < oldestDate) {
      oldestDate = resource.createdAt;
    }
  }

  return {
    count: resourceCache.size,
    totalSize,
    oldestAge: oldestDate ? Date.now() - oldestDate.getTime() : null,
  };
}
