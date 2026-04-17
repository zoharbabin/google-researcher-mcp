# Deep Dive: Event Store Architecture

This document provides a detailed technical explanation of the server's `PersistentEventStore`. It is intended for developers who need to understand how session resumption for the HTTP/SSE transport is implemented.

For a higher-level view, please see the main [**Architecture Guide**](./architecture.md).

## The Purpose of the Event Store

The Event Store's sole purpose is to enable **session resumption** for clients using the HTTP/SSE transport. When a web-based client communicates with the server, it maintains a persistent connection to receive a stream of events (responses). If this connection is interrupted (e.g., due to a network drop), the client can reconnect and "catch up" on any missed messages.

The Event Store is the component that makes this possible by acting as a durable, short-term memory for all messages sent by the server.

## Component Diagram

The `PersistentEventStore` shares a similar architecture with the caching system, using a `PersistenceManager` to handle disk I/O.

```mermaid
graph TD
    subgraph "Application Layer"
        A[HTTP/SSE Transport]
    end

    subgraph "Event Store System"
        B(PersistentEventStore)
        C[EventPersistenceManager]
    end

    subgraph "Storage Layer"
        D[In-Memory Store (Map)]
        E[Filesystem]
    end

    A -- Calls storeEvent() & replayEventsAfter() --> B
    B -- Uses --> D
    B -- Delegates I/O to --> C
    C -- Reads/Writes --> E

    style B fill:#cce6ff,stroke:#333,stroke-width:2px
    style C fill:#e6ffcc,stroke:#333,stroke-width:2px
```

## Core Components

### `PersistentEventStore`
-   **File**: [`src/shared/persistentEventStore.ts`](../src/shared/persistentEventStore.ts)
-   **Description**: The main class that implements the `EventStore` interface required by the MCP SDK's `StreamableHTTPServerTransport`. It orchestrates the storage and retrieval of events.
-   **Key Responsibilities**:
    -   Managing an in-memory `Map` of recent events for fast access.
    -   Maintaining a **per-stream index** (`Map<string, Set<string>>`) for O(k) stream lookups instead of O(n) full scans.
    -   Tracking estimated memory usage without expensive serialization.
    -   Generating unique, chronologically sortable event IDs.
    -   Enforcing limits on the number of events stored (per-stream and globally) to prevent memory exhaustion.
    -   Handling event expiration (TTL).
    -   Coordinating with the `EventPersistenceManager` for disk-based persistence.
    -   Providing optional hooks for encryption, access control, and audit logging.

### `EventPersistenceManager`
-   **File**: [`src/shared/eventPersistenceManager.ts`](../src/shared/eventPersistenceManager.ts)
-   **Description**: An abstraction layer over the filesystem, responsible for all disk I/O operations.
-   **Key Responsibilities**:
    -   Organizing events on disk into directories based on their `streamId` (which corresponds to a client's session ID).
    -   Performing **atomic writes** for each event to prevent data corruption.
    -   Loading event streams from disk when a client reconnects and its session is not fully in memory.

## Data Flow and Logic

### Storing an Event

1.  The **HTTP/SSE Transport** sends a message to a client.
2.  It calls `eventStore.storeEvent()` with the `streamId` and the message.
3.  The `PersistentEventStore` generates a new `eventId`.
4.  The event is added to the in-memory `Map`.
5.  The store checks if any limits (e.g., `maxEventsPerStream`) have been exceeded and evicts the oldest events if necessary.
6.  The `EventPersistenceManager` is called to write the new event to a JSON file on disk (e.g., `storage/event_store/<streamId>/<eventId>.json`).

### Replaying Events (Session Resumption)

1.  A client reconnects to the HTTP/SSE endpoint, providing the `lastEventId` it successfully received.
2.  The transport calls `eventStore.replayEventsAfter(lastEventId)`.
3.  The `PersistentEventStore` uses the **per-stream index** to look up only events belonging to that stream (O(k) where k is the stream size), rather than scanning all events.
4.  If the `lastEventId` is not in memory, it asks the `EventPersistenceManager` to load it from disk and rebuilds the stream index entry.
5.  Once the full sequence of missed events is gathered, they are sent back to the client in the correct order.

## Configuration and Usage

Like the cache, the `PersistentEventStore` is instantiated as a **global singleton** in `src/server.ts` to ensure a single, unified store is used across the entire application.

```typescript
// Simplified example from src/server.ts
const eventStoreInstance = new PersistentEventStore({
  storagePath: path.resolve(__dirname, '..', 'storage', 'event_store'),
  eventTTL: 24 * 60 * 60 * 1000, // 24 hours
  maxEventsPerStream: 1000,
  persistenceInterval: 5 * 60 * 1000, // 5 minutes
  eagerLoading: true, // Load all events from disk on startup
});
```

This singleton instance is then passed to the `StreamableHTTPServerTransport` during its initialization.

## Shutdown and Data Integrity

The `PersistentEventStore` registers its `dispose` method with the same global shutdown handler as the cache. This ensures that when the server terminates, any events still in the in-memory store are flushed to disk in a final, synchronous write, preventing data loss and ensuring reliable session resumption even across server restarts.