// src/shared/persistentEventStore.ts

import { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { EventStore } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { EventPersistenceManager } from "./eventPersistenceManager.js";
import { EventStoreEncryption, sanitizeMessage } from "./eventStoreEncryption.js";
import { logger } from "./logger.js";
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { 
  EventData, 
  PersistentEventStoreOptions, 
  EventStoreStats,
  EventStoreInternalStats,
  AccessControlOptions,
  AuditLogOptions,
  AuditEvent
} from "./types/eventStore.js";

/**
 * Production-grade implementation of the EventStore interface with persistence
 * 
 * This class provides:
 * - In-memory storage with disk persistence
 * - Configurable event limits and expiration
 * - Comprehensive statistics and monitoring
 * - Stream-level and global event management
 * - Optional encryption for sensitive data
 * - Access control for multi-tenant scenarios
 * - Audit logging for compliance
 * 
 * The PersistentEventStore is designed for production use, providing
 * durability across server restarts while maintaining the performance
 * benefits of in-memory storage for active sessions.
 * 
 * @implements EventStore from the MCP SDK
 */
export class PersistentEventStore implements EventStore {
  private memoryStore: Map<string, EventData>;
  private streamIndex: Map<string, Set<string>>; // streamId → set of eventIds
  private estimatedMemoryBytes: number = 0;
  private persistenceManager: EventPersistenceManager;
  private options: PersistentEventStoreOptions;
  private stats: EventStoreInternalStats;
  private cleanupTimer?: NodeJS.Timeout;
  private encryption?: EventStoreEncryption;
  private accessControl?: AccessControlOptions;
  private auditLog?: AuditLogOptions;
  
  /**
   * Creates a new PersistentEventStore
   * 
   * @param options - Configuration options
   */
  constructor(options: PersistentEventStoreOptions & { 
    accessControl?: AccessControlOptions;
    auditLog?: AuditLogOptions;
  }) {
    this.options = {
      maxEventsPerStream: 1000,
      eventTTL: 24 * 60 * 60 * 1000, // 24 hours
      maxTotalEvents: 10000,
      persistenceInterval: 5 * 60 * 1000, // 5 minutes
      eagerLoading: false,
      ...options
    };
    
    this.memoryStore = new Map();
    this.streamIndex = new Map();
    this.persistenceManager = new EventPersistenceManager({
      storagePath: options.storagePath,
      criticalStreamIds: options.criticalStreamIds,
      persistenceInterval: options.persistenceInterval
    });
    
    // Initialize encryption if enabled
    if (options.encryption?.enabled) {
      this.encryption = new EventStoreEncryption(options.encryption);
    }
    
    // Initialize access control if provided
    this.accessControl = options.accessControl;
    
    // Initialize audit logging if provided
    this.auditLog = options.auditLog;
    
    // Initialize stats tracking
    this.stats = {
      hits: 0,
      misses: 0,
      totalRequests: 0
    };

    // Set up the persistence callback
    this.persistenceManager.setOnPersistCallback(() => Promise.resolve(this.memoryStore));
    
    // Start periodic persistence
    this.persistenceManager.startPeriodicPersistence();
    
    // Set up periodic cleanup if TTL is enabled
    if (this.options.eventTTL) {
      this.setupCleanupInterval();
    }
    
    // Load existing events if eagerLoading is enabled
    if (this.options.eagerLoading) {
      this.loadEvents().catch(err =>
        logger.error('Failed to load events from disk', { error: String(err) })
      );
    }
  }

  // --- Internal index helpers ---

  private addToIndex(eventId: string, data: EventData): void {
    this.memoryStore.set(eventId, data);
    let streamSet = this.streamIndex.get(data.streamId);
    if (!streamSet) {
      streamSet = new Set();
      this.streamIndex.set(data.streamId, streamSet);
    }
    streamSet.add(eventId);
    this.estimatedMemoryBytes += this.estimateEventSize(data);
  }

  private removeFromIndex(eventId: string): void {
    const data = this.memoryStore.get(eventId);
    if (!data) return;
    this.estimatedMemoryBytes -= this.estimateEventSize(data);
    this.memoryStore.delete(eventId);
    const streamSet = this.streamIndex.get(data.streamId);
    if (streamSet) {
      streamSet.delete(eventId);
      if (streamSet.size === 0) this.streamIndex.delete(data.streamId);
    }
  }

  private estimateEventSize(data: EventData): number {
    // Rough estimate: 200 bytes base overhead + message size
    return 200 + (typeof data.message === 'object' ? JSON.stringify(data.message).length * 2 : 0);
  }

  /**
   * Loads events from disk into memory
   */
  private async loadEvents(): Promise<void> {
    const events = await this.persistenceManager.loadEvents();
    // Rebuild index from loaded data
    for (const [eventId, data] of events) {
      this.addToIndex(eventId, data);
    }
  }
  
  /**
   * Sets up periodic cleanup of expired events
   */
  private setupCleanupInterval(): void {
    // Run cleanup every hour or 1/4 of the TTL, whichever is shorter
    const cleanupInterval = Math.min(
      60 * 60 * 1000, // 1 hour
      this.options.eventTTL! / 4
    );
    
    this.cleanupTimer = setInterval(() => {
      this.cleanup();
    }, cleanupInterval);
    
    // Ensure the timer doesn't prevent the process from exiting
    this.cleanupTimer.unref();
  }
  
  /**
   * Generates a unique event ID for a stream
   * 
   * The event ID format is: streamId_timestamp_randomString
   * This format ensures:
   * - Events are associated with their stream
   * - Events can be chronologically ordered
   * - IDs are unique even with timestamp collisions
   * 
   * @param streamId - The ID of the stream this event belongs to
   * @returns A unique event ID string
   */
  private generateEventId(streamId: string): string {
    return `${streamId}_${Date.now()}_${Math.random().toString(36).substring(2, 10)}`;
  }
  
  /**
   * Extracts the stream ID from an event ID
   * 
   * Parses the event ID format (streamId_timestamp_randomString)
   * to extract the original stream ID.
   * 
   * @param eventId - The event ID to parse
   * @returns The stream ID portion of the event ID
   */
  private getStreamIdFromEventId(eventId: string): string {
    // Format: streamId_timestamp_random — stream ID may contain underscores
    const lastUnderscore = eventId.lastIndexOf('_');
    if (lastUnderscore <= 0) return "";
    const secondLast = eventId.lastIndexOf('_', lastUnderscore - 1);
    if (secondLast <= 0) return eventId.split("_")[0] || "";
    return eventId.substring(0, secondLast);
  }
  
  /**
   * Stores a JSON-RPC message in the event store
   * 
   * This method:
   * 1. Generates a unique event ID
   * 2. Associates the message with the stream ID
   * 3. Stores the event in memory
   * 4. Persists critical events immediately
   * 5. Enforces configured limits
   * 
   * @param streamId - The ID of the stream this event belongs to
   * @param message - The JSON-RPC message to store
   * @param userId - Optional user ID for audit logging
   * @returns The generated event ID
   */
  async storeEvent(streamId: string, message: JSONRPCMessage, userId?: string): Promise<string> {
    try {
      // Generate event ID with the same format for compatibility
      const eventId = this.generateEventId(streamId);
      
      // Sanitize sensitive data
      const sanitizedMessage = sanitizeMessage(message);
      
      // Encrypt if enabled
      const finalMessage = this.encryption 
        ? await this.encryption.encryptMessage(sanitizedMessage)
        : sanitizedMessage;
      
      const eventData: EventData = { 
        streamId, 
        message: finalMessage, 
        timestamp: Date.now(),
        metadata: { userId } 
      };
      
      // Store in memory with index maintenance
      this.addToIndex(eventId, eventData);
      
      // Enforce limits (synchronous — uses indexed lookups)
      this.enforceStreamLimits(streamId);
      this.enforceGlobalLimits();
      
      // Persist immediately if this is a critical stream
      if (this.options.criticalStreamIds?.includes(streamId)) {
        await this.persistenceManager.persistEvent(eventId, eventData);
      }
      
      // Log audit event if enabled
      await this.logAuditEvent({
        timestamp: new Date().toISOString(),
        operation: 'storeEvent',
        streamId,
        userId,
        eventId,
        result: 'success'
      });
      
      return eventId;
    } catch (error) {
      // Log audit event for failure
      await this.logAuditEvent({
        timestamp: new Date().toISOString(),
        operation: 'storeEvent',
        streamId,
        userId,
        result: 'failure',
        details: { error: (error as Error).message }
      });
      
      throw error;
    }
  }
  
  /**
   * Replays events that occurred after a specific event
   * 
   * This method is used when a client reconnects and needs to catch up on
   * missed events. It:
   * 
   * 1. Validates the last event ID received by the client
   * 2. Extracts the stream ID to filter relevant events
   * 3. Sorts all events chronologically
   * 4. Sends all events for the stream that occurred after the last received event
   * 
   * If the event is not found in memory, it attempts to load it from disk.
   * 
   * @param lastEventId - The ID of the last event received by the client
   * @param options - Options for replaying events
   * @returns The stream ID if successful, empty string otherwise
   */
  async replayEventsAfter(
    lastEventId: string,
    options: { send: (eventId: string, message: JSONRPCMessage) => Promise<void>, userId?: string }
  ): Promise<string> {
    const { send, userId } = options;
    this.stats.totalRequests++;
    
    try {
      if (!lastEventId || !this.memoryStore.has(lastEventId)) {
        // Try to load from disk if not in memory
        if (!lastEventId || !(await this.loadEventFromDisk(lastEventId))) {
          this.stats.misses++;
          return "";
        }
      } else {
        this.stats.hits++;
      }
      
      const streamId = this.getStreamIdFromEventId(lastEventId);
      if (!streamId) return "";
      
      // Check access permissions if access control is enabled
      if (this.accessControl?.enabled && userId) {
        const hasAccess = await this.accessControl.authorizer(streamId, userId);
        if (!hasAccess) {
          await this.logAuditEvent({
            timestamp: new Date().toISOString(),
            operation: 'replayEventsAfter',
            streamId,
            userId,
            result: 'failure',
            details: { reason: 'Access denied' }
          });
          return "";
        }
      }
      
      // Use the stream index for O(k) lookup instead of O(n) full scan
      const streamSet = this.streamIndex.get(streamId);
      if (!streamSet) return "";
      const streamEvents = Array.from(streamSet)
        .map(id => [id, this.memoryStore.get(id)!] as [string, EventData])
        .sort((a, b) => a[1].timestamp - b[1].timestamp);
      
      // Find the position of the last event
      const lastEventIndex = streamEvents.findIndex(([id]) => id === lastEventId);
      if (lastEventIndex === -1) return "";
      
      // Send all subsequent events
      for (let i = lastEventIndex + 1; i < streamEvents.length; i++) {
        const [eventId, { message }] = streamEvents[i];
        
        // Decrypt if necessary
        const decryptedMessage = this.encryption 
          ? await this.encryption.decryptMessage(message) 
          : message;
          
        await send(eventId, decryptedMessage);
      }
      
      // Log audit event if enabled
      await this.logAuditEvent({
        timestamp: new Date().toISOString(),
        operation: 'replayEventsAfter',
        streamId,
        userId,
        result: 'success',
        details: { eventCount: streamEvents.length - lastEventIndex - 1 }
      });
      
      return streamId;
    } catch (error) {
      // Log audit event for failure
      await this.logAuditEvent({
        timestamp: new Date().toISOString(),
        operation: 'replayEventsAfter',
        streamId: lastEventId ? this.getStreamIdFromEventId(lastEventId) : 'unknown',
        userId,
        result: 'failure',
        details: { error: (error as Error).message }
      });
      
      return "";
    }
  }
  
  /**
   * Loads an event from disk if it's not in memory
   * 
   * @param eventId - The ID of the event to load
   * @returns True if the event was loaded successfully, false otherwise
   */
  private async loadEventFromDisk(eventId: string): Promise<boolean> {
    try {
      const eventData = await this.persistenceManager.loadEvent(eventId);
      if (eventData) {
        this.addToIndex(eventId, eventData);
        return true;
      }
    } catch (error) {
      logger.error(`Failed to load event ${eventId} from disk`, { error: String(error) });
    }
    return false;
  }
  
  /**
   * Enforces the maximum events per stream limit
   * 
   * If the number of events for a stream exceeds the configured limit,
   * the oldest events are removed.
   * 
   * @param streamId - The ID of the stream to check
   */
  private enforceStreamLimits(streamId: string): void {
    if (!this.options.maxEventsPerStream) return;
    const streamSet = this.streamIndex.get(streamId);
    if (!streamSet || streamSet.size <= this.options.maxEventsPerStream) return;

    // Sort only this stream's events by timestamp
    const sorted = Array.from(streamSet)
      .map(id => ({ id, ts: this.memoryStore.get(id)!.timestamp }))
      .sort((a, b) => a.ts - b.ts);

    const removeCount = sorted.length - this.options.maxEventsPerStream;
    for (let i = 0; i < removeCount; i++) {
      this.removeFromIndex(sorted[i].id);
    }
  }
  
  /**
   * Enforces the maximum total events limit
   * 
   * If the total number of events exceeds the configured limit,
   * the oldest events are removed.
   */
  private enforceGlobalLimits(): void {
    if (!this.options.maxTotalEvents) return;
    if (this.memoryStore.size <= this.options.maxTotalEvents) return;

    const allEvents = Array.from(this.memoryStore.entries())
      .sort((a, b) => a[1].timestamp - b[1].timestamp);

    const removeCount = allEvents.length - this.options.maxTotalEvents;
    for (let i = 0; i < removeCount; i++) {
      this.removeFromIndex(allEvents[i][0]);
    }
  }
  
  /**
   * Persists all events to disk
   * 
   * This is typically called during graceful shutdown to ensure
   * all events are saved.
   */
  async persistToDisk(): Promise<void> {
    return this.persistenceManager.persistEvents(this.memoryStore);
  }
  
  /**
   * Removes expired events based on TTL
   * 
   * This is called periodically if eventTTL is configured.
   */
  async cleanup(): Promise<void> {
    if (!this.options.eventTTL) return;

    const expirationThreshold = Date.now() - this.options.eventTTL;
    const expiredIds: string[] = [];

    for (const [eventId, data] of this.memoryStore) {
      if (data.timestamp < expirationThreshold) expiredIds.push(eventId);
    }

    for (const eventId of expiredIds) {
      this.removeFromIndex(eventId);
    }

    if (expiredIds.length > 0) {
      logger.info(`Cleaned up ${expiredIds.length} expired events`);
    }
  }
  
  /**
   * Gets statistics about the event store
   * 
   * @returns Statistics about the event store
   */
  async getStats(): Promise<EventStoreStats> {
    // Use stream index for per-stream counts and running memory estimate
    // instead of JSON.stringify-ing every event
    const eventsByStream: Record<string, number> = {};
    for (const [streamId, eventIds] of this.streamIndex) {
      eventsByStream[streamId] = eventIds.size;
    }

    let oldestTimestamp = Date.now();
    let newestTimestamp = 0;
    for (const data of this.memoryStore.values()) {
      if (data.timestamp < oldestTimestamp) oldestTimestamp = data.timestamp;
      if (data.timestamp > newestTimestamp) newestTimestamp = data.timestamp;
    }

    const diskUsage = await this.persistenceManager.calculateDiskUsage();

    return {
      totalEvents: this.memoryStore.size,
      eventsByStream,
      memoryUsage: this.estimatedMemoryBytes,
      diskUsage,
      hitRatio: this.stats.totalRequests ? this.stats.hits / this.stats.totalRequests : 0,
      missRatio: this.stats.totalRequests ? this.stats.misses / this.stats.totalRequests : 0,
      oldestEvent: new Date(oldestTimestamp),
      newestEvent: new Date(newestTimestamp)
    };
  }
  
  /**
   * Cleans up resources when the event store is no longer needed
   * 
   * This should be called during graceful shutdown.
   */
  async dispose(): Promise<void> {
    logger.info('Disposing PersistentEventStore...');

    // Stop cleanup timer first
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = undefined;
      logger.debug('Event cleanup timer stopped.');
    }

    // Attempt to persist all remaining events to disk
    try {
      await this.persistToDisk();
      logger.debug('Final event persistence successful during disposal.');
    } catch (error) {
      logger.error('Error persisting events during disposal', { error: String(error) });
    }

    try {
      await this.persistenceManager.dispose();
    } catch (error) {
      logger.error('Error disposing persistence manager', { error: String(error) });
    }

    // Clear memory store and index to help with garbage collection
    this.memoryStore.clear();
    this.streamIndex.clear();
    this.estimatedMemoryBytes = 0;

    // Log final audit event regardless of persistence success/failure
    await this.logAuditEvent({
      timestamp: new Date().toISOString(),
      operation: 'dispose',
      streamId: 'system',
      result: 'success'
    });

    logger.info('PersistentEventStore disposed.');
  }
  
  /**
   * Deletes all events associated with a specific user
   * 
   * This is useful for GDPR compliance and "right to be forgotten" requests.
   * 
   * @param userId - The ID of the user whose events should be deleted
   * @returns The number of events deleted
   */
  async deleteUserEvents(userId: string): Promise<number> {
    let deletedCount = 0;
    
    // Find all events associated with this user
    const userEvents = Array.from(this.memoryStore.entries())
      .filter(([_, data]) => data.metadata?.userId === userId);

    // Delete each event
    for (const [eventId, data] of userEvents) {
      this.removeFromIndex(eventId);
      
      // Also delete from disk
      try {
        const streamDir = this.persistenceManager.getStreamDirectory(data.streamId);
        const eventPath = path.join(streamDir, `${eventId}.json`);
        await fs.unlink(eventPath);
        deletedCount++;
      } catch (error) {
        logger.error(`Failed to delete event ${eventId} for user ${userId}`, { error: String(error) });
      }
    }
    
    // Log audit event
    await this.logAuditEvent({
      timestamp: new Date().toISOString(),
      operation: 'deleteUserEvents',
      streamId: 'system',
      userId,
      result: 'success',
      details: { deletedCount }
    });
    
    return deletedCount;
  }
  
  /**
   * Logs an audit event if audit logging is enabled
   * 
   * @param event - The audit event to log
   */
  private async logAuditEvent(event: AuditEvent): Promise<void> {
    if (this.auditLog?.enabled && this.auditLog.logger) {
      try {
        await this.auditLog.logger(event);
      } catch (error) {
        logger.error('Failed to log audit event', { error: String(error) });
      }
    }
  }
}