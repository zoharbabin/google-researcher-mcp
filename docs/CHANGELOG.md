# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [6.2.0] - 2026-04-17

### Fixed
- **MCP Prompt Number Parameters**: Prompt arguments are always passed as strings by MCP clients; replaced `z.number()` with `z.coerce.number()` in `fact-check` (sources), `literature-review` (yearFrom, sources) prompts to fix "Expected number, received string" errors

### Changed
- **Memory Optimization — Targeted Crawlee Imports**: Replaced umbrella `crawlee` import (loads 12 sub-packages including puppeteer, jsdom, linkedom) with targeted `@crawlee/cheerio` + `@crawlee/core` — saves ~61 MB RSS per instance
- **Memory Optimization — Lazy PlaywrightCrawler**: `PlaywrightCrawler` is now dynamically imported on first JS-rendered scrape instead of at startup — saves ~30-50 MB for sessions that never need JS rendering
- **Memory Optimization — Lazy Document Parsers**: pdf-parse, mammoth, and jszip are now dynamically imported inside their respective parse functions instead of at module load — saves ~74 MB RSS
- **Memory Optimization — Lazy HTTP Dependencies**: express, cors, and express-rate-limit are now dynamically imported inside `createAppAndHttpTransport()` — saves ~24 MB in STDIO mode
- **PID Lock File**: Server now writes a PID lock file (`storage/.server.pid`) on startup and sends SIGTERM to stale processes, preventing orphan instance accumulation across MCP client reconnections
- **Stdin Health Check**: Periodic check (every 5s) detects destroyed or ended stdin as a safety net for parent process death beyond the existing `end`/`close` event listeners
- **Bounded sanitizeUrlCache**: URL sanitization cache is now capped at 500 entries with FIFO eviction to prevent unbounded memory growth over long sessions
- **Event Store Lazy Loading**: Event store `eagerLoading` set to `false` — events are loaded on demand instead of all at startup, reducing memory for STDIO sessions that don't use HTTP reconnection
- **Net Memory Impact**: Per-instance idle RSS reduced from ~430 MB to ~80-95 MB (78% reduction); ~175 MB after Playwright warms on first use (59% reduction)

## [6.1.0] - 2026-04-17

### Fixed
- **Orphan Process Prevention**: Server now detects stdin EOF and triggers graceful shutdown, preventing orphaned processes when parent (Claude Code, Claude Desktop) terminates
- **Unified Shutdown**: Consolidated duplicate shutdown paths into a single `gracefulShutdown()` function with idempotency guard
- **Playwright Process Leaks**: Timeout-killed Playwright scrapes now properly await `crawler.teardown()` and `crawlPromise` in finally blocks
- **Event Store O(n) Scan**: Added per-stream index (`Map<string, Set<string>>`) to `PersistentEventStore`, reducing `replayEventsAfter` and limit enforcement from O(n) to O(k) per stream
- **Event Store Disk Load**: `loadEventFromDisk` now updates the stream index, fixing broken replays for disk-loaded events
- **Event ID Parsing**: `getStreamIdFromEventId` now handles stream IDs containing underscores
- **Cache Triple Serialization**: Eliminated redundant JSON.stringify calls in `PersistenceManager.saveAllEntries()`
- **Cache Dirty Flag**: `persistToDisk` now restores `isDirty = true` on failure so the next attempt retries
- **JWKS Cache Leak**: Replaced `PersistentCache` for OAuth JWKS with a simple TTL Map, eliminating timer and signal handler leaks
- **Document Parser OOM**: `fetchDocument` now streams response body with per-chunk size limits instead of buffering the entire response
- **Deduplication Accuracy**: Replaced character-set overlap similarity with trigram-based similarity for near-duplicate detection
- **Regex Recompilation**: Pre-compiled module-scope regexes in `contentSizeOptimization.ts` and `qualityScoring.ts`
- **Test Suite DOMMatrix**: Added polyfill in `jest.setup.js` for `DOMMatrix` and `Path2D` required by pdfjs-dist, fixing 160 pre-existing test failures

### Changed
- **Bounded Scraping Concurrency**: `search_and_scrape` now limits parallel scrapes to 3 via `mapWithConcurrency` (new `src/shared/concurrency.ts`)
- **Playwright Event-Driven Waits**: Replaced fixed `page.waitForTimeout()` sleeps with `page.waitForSelector()` and `page.waitForLoadState('networkidle')`
- **Cache Persistence Batching**: `saveAllEntries` now processes disk writes in batches of 50
- **Expired Entry Pruning**: Cache `loadAllEntries` now deletes expired entries during load; `persistToDisk` filters them before write
- **Sequential Search Caps**: Added per-session limits: 100 steps, 200 sources, 50 knowledge gaps
- **Startup Cleanup**: `initializeGlobalInstances` sweeps orphaned crawlee temp directories
- **URL Sanitization Cache**: `sanitizeUrl` results are now memoized per server lifetime
- **Automated Chromium Install**: `npm install` now automatically installs Chromium via postinstall hook; graceful fallback if install fails
- **Playwright Missing Browser Guard**: `scrapeWithPlaywright` returns a clear error message instead of crashing when Chromium is not installed

## [6.0.1] - 2026-03-30

### Fixed
- **Timer Leak in withTimeout**: `setTimeout` was never cleared when the wrapped promise resolved first, causing accumulation of orphaned timers over the server lifetime
- **HTTP Server Not Closed on Shutdown**: The HTTP server variable was scoped locally and unreachable from `gracefulShutdown()`, leaving ports bound and sockets open
- **Crawler Storage Directory Leak**: Cheerio and Playwright crawlers created unique storage directories per scrape that were never cleaned up, causing unbounded disk growth
- **Playwright Zombie Browser Processes**: Added `crawler.teardown()` in finally blocks to ensure browser processes are terminated even on timeout
- **STDIO Protocol Corruption in testCleanup.ts**: Replaced `console.log`/`console.warn` calls with `process.stderr.write()` to prevent stdout pollution in STDIO transport mode
- **Missing Fetch Timeout in Patent Search**: `fetch()` call in `patentSearch.ts` had no timeout and could hang indefinitely; added `AbortSignal.timeout(30s)`
- **Unbounded Resource Cache**: `resourceLinks.ts` cache Map had no size limit; added cap at 500 entries with LRU-style eviction (oldest 20%)
- **Unbounded Sequential Search Sessions**: `sequentialSearch.ts` session Map had no upper bound; added cap at 50 sessions with oldest-eviction
- **Memory Leak in Base Cache Dispose**: `Cache.dispose()` cleared the interval but not the `cache`, `accessLog`, or `pendingPromises` maps, preventing garbage collection
- **Orphaned .tmp File Accumulation**: Failed atomic writes left `.tmp` files on disk that were skipped but never deleted during cache load; now cleaned up automatically
- **persistSync Shutdown Hang**: Synchronous cache persistence on shutdown iterated all entries without limit; capped at 2000 writes to prevent process hang on large caches

## [Unreleased]

### Added
- **Per-Tool Execution Metrics**: New metrics system tracks performance for all 8 MCP tools. Records call counts (total/success/failure), latency percentiles (p50, p95, p99), cache hit rates, and success rates per tool. Uses reservoir sampling (max 1000 samples per tool) for memory-bounded percentile calculation. Exposed via `stats://tools` MCP resource and Prometheus-format endpoint at `GET /mcp/metrics/prometheus`. Includes `MetricsCollector` class, `instrumentTool` wrapper, and `prometheusFormatter`. (#46)
- **Patent Search Tool**: New `patent_search` tool searches Google Patents via Custom Search API with `site:patents.google.com` filter. Supports filtering by patent office (US, EP, WO, JP, CN, KR), assignee, inventor, CPC classification code, and publication year range. Returns patent numbers, titles, abstracts, inventors, assignees, filing/publication dates, and PDF download URLs. Search types include `prior_art` (find existing patents), `specific` (known patent lookup), and `landscape` (technology area analysis). (#78)
- **Content Size Optimization**: `scrape_page` and `search_and_scrape` now support smart content size management to prevent context overflow. New parameters: `max_length` (character limit with truncation at natural breakpoints), `mode: 'preview'` (metadata + structure without full content). Response includes size metadata: `contentLength`, `estimatedTokens` (~4 chars/token), `sizeCategory` (small/medium/large/very_large), `truncated` flag, and `originalLength` when truncated. Also adds keyword-based paragraph filtering via `filter_by_query` parameter. All operations are mechanical string processing—no LLM-based summarization. (#79)
- **Sequential Search Tool**: New `sequential_search` tool for tracking multi-step research, following the pattern of the official `sequential_thinking` MCP server. Tracks search steps, sources with quality scores, knowledge gaps, revisions, and branching. State exposed via `search://session/current` resource. Key principle: LLM does reasoning, server tracks state. (#68)
- **Academic Paper Search**: New `academic_search` tool searches peer-reviewed papers via Google Custom Search API (filtered to academic sources: arXiv, PubMed, IEEE, Nature, Springer, ResearchGate, JSTOR, etc.). Returns titles, authors, abstracts, PDF URLs, and pre-formatted citations (APA, MLA, BibTeX). Filter by source (`arxiv`, `pubmed`, `ieee`, `nature`, `springer`), year range, and PDF-only. Papers cached for 24 hours since they don't change. (#74)
- **Type Safety Improvements**: Added proper TypeScript interfaces for Google API responses (`GoogleSearchResponse`, `GoogleImageSearchResponse`, `GoogleNewsSearchResponse`). Replaced unsafe `as any` casts with type-safe accessors. Added `getErrorMessage()` helper for proper error handling. (#60)
- **Tool Icons and Metadata**: All tools now include SVG icons and `_meta` fields per MCP spec 2025-11-25. Icons render in MCP client tool pickers. Meta fields include category, tier, cacheTTL, rateLimit, and externalAPIs. (#50)
- **Resource Link Support**: Added infrastructure for `resource_link` content type per MCP spec. Tools can return URI references instead of embedding large content. Resource cache with 1-hour TTL. Stats exposed via `stats://resources` resource. (#48)
- **MCP Sampling Infrastructure**: Added foundation for MCP Sampling primitive (server-initiated LLM calls). Includes `expandQuery()` and `detectLanguage()` helpers. Designed for narrow, well-defined tasks like query expansion—not general reasoning. Graceful fallback when client doesn't support sampling. (#76)
- **MCP Resources Primitive**: Server now exposes state via MCP Resources protocol. Available resources include `search://recent` (last 20 search queries), `config://server` (server configuration), `stats://cache` (cache statistics), and `stats://events` (event store statistics). Resources are registered and discoverable via `resources/list` and readable via `resources/read`. (#41)
- **MCP Prompts Primitive**: Research workflow templates accessible via MCP Prompts protocol. Four prompts available: `comprehensive-research` (multi-source topic research with depth control), `fact-check` (claim verification against multiple sources), `summarize-url` (single URL summarization in various formats), `news-briefing` (current news summary with time range filtering). (#42)
- **Google Image Search Tool**: New `google_image_search` tool searches Google Images via Custom Search API. Supports filtering by size (`huge`, `large`, `medium`, `small`), type (`clipart`, `face`, `lineart`, `photo`, `animated`), color type, dominant color, and file type. Returns image URLs, thumbnails, dimensions, and source context links. (#38)
- **Google News Search Tool**: New `google_news_search` tool searches Google News via Custom Search API. Supports freshness filtering (`hour`, `day`, `week`, `month`, `year`), date-based sorting, and news source filtering. Returns article headlines, snippets, publication dates, and source domains. (#43)
- **Content Annotations**: Tool responses now include MCP-compliant content annotations per spec 2025-11-25. Annotations specify `audience` (`user`, `assistant`, or both), `priority` (0.0-1.0 importance weight), and `lastModified` timestamp. Pre-configured presets for primary results, supporting context, metadata, citations, and summaries enable clients to filter and prioritize content appropriately. (#49)
- **Quality Scoring**: Sources in `search_and_scrape` are now scored and ranked by quality. Scoring factors include relevance (query term matching, 35%), freshness (publication recency, 20%), authority (domain reputation like .gov/.edu, 25%), and content quality (length, structure, readability, 20%). Each source includes an overall quality score (0-1) in the response. (#66)
- **Citation Tracking**: `scrape_page` now extracts citation metadata from web pages, including title, author, publication date, site name, and description. Parses Open Graph, Twitter Cards, JSON-LD structured data, and standard meta tags. Returns pre-formatted citations in APA 7th edition and MLA 9th edition formats. `search_and_scrape` includes citations for each source in the `structuredContent.sources` array. (#69)
- **Structured Output Schemas**: All tools now return `structuredContent` in addition to text `content`, enabling type-safe responses per MCP spec. Uses Zod schemas for validation: `googleSearchOutputSchema` (URLs, query, result count), `scrapePageOutputSchema` (URL, content, content type, metadata, citation), `searchAndScrapeOutputSchema` (sources array with citations, combined content, summary stats). Backward compatible — clients can use either format. (#45)
- **Document Parsing**: `scrape_page` now automatically parses PDF, DOCX, and PPTX documents when the URL points to a supported file type. Extracts text content and metadata (page count, title, author). Uses pdf-parse, mammoth, and jszip libraries. 10 MB file size limit protects against memory exhaustion. (#58)
- **Content Deduplication**: `search_and_scrape` now removes duplicate and near-duplicate paragraphs across sources by default. Uses paragraph-level hashing with configurable similarity threshold. New `deduplicate` parameter (default: true) controls this behavior. Reduces redundancy when multiple sources quote the same material. (#64)
- **Advanced Search Filtering**: `google_search` now supports powerful filtering options: `site_search` (limit to specific domains), `exact_terms` (required phrase), `exclude_terms` (filter out unwanted content), `language` (ISO 639-1), `country` (ISO 3166-1), and `safe` (content filtering level). All filters are properly cached to avoid cross-contamination. (#51)
- **Environment Variable Validation**: New `envValidator` module provides comprehensive validation of all configuration at startup with clear, actionable error messages. Validates format patterns for Google API keys (`AIzaSy...`), Search Engine IDs, OAuth URLs (HTTPS required), encryption keys (64 hex chars), and more. Fails fast with helpful diagnostics instead of cryptic runtime errors. (#67)

### Changed
- **Improved LLM Tool Descriptions**: Standardized all 8 tool descriptions with consistent "When to use" format. Added missing caching information to image/news/academic/patent tools. Improved google_search description to focus on standalone use cases. Makes LLM tool selection more accurate and efficient.
- **Server Capabilities**: Server now properly declares tool capabilities during MCP initialization handshake. The SDK handles automatic capability negotiation when tools are registered via `registerTool()`. (#52)
- **Circuit Breaker**: External API calls (Google Search, web scraping) are now protected by a circuit breaker that prevents cascading failures. When an external service is down, the circuit opens after 5 consecutive failures and automatically recovers after a cooldown period. Stale cached data is served transparently while the circuit is open. (#71)
- **Request Tracing**: Every tool invocation generates a unique `traceId` (UUID) that flows through the entire request pipeline — search, scrape, and composite `search_and_scrape` operations. All log entries include the trace ID for end-to-end debugging. (#39)
- **JavaScript Rendering**: `scrape_page` now renders JavaScript-heavy pages (React, Next.js, SPAs) via a Playwright fallback when static HTML extraction returns insufficient content. Static pages still use the fast CheerioCrawler path.

### Security
- **SDK Upgrade**: Upgraded `@modelcontextprotocol/sdk` from 1.11.0 to ^1.26.0, fixing cross-client data leak (GHSA-345p-7cg4-v4c7)
- **SSRF Protection**: Added URL validation to block private IPs, metadata endpoints, and non-HTTP protocols in `scrape_page`
- **Admin Key Hardening**: Removed hardcoded admin key fallback; admin endpoints are disabled when `CACHE_ADMIN_KEY` is unset
- **Encryption Safety**: Encryption failures now throw `EncryptionError` instead of silently falling back to plaintext
- **Log Sanitization**: API keys are redacted from log output

### Fixed
- **Cache Init Race Condition**: `PersistentCache.getOrCompute()` now awaits a shared init promise instead of spawning per-call `setInterval` polling timers. Concurrent calls during startup no longer risk timeouts or resource leaks. (#54)
- **Synchronous Shutdown I/O**: Signal handlers (SIGINT, SIGTERM, SIGHUP) now attempt async `persistToDisk()` with a 5-second grace period before falling back to synchronous writes. Added `registerShutdownHandlers` option so `server.ts` can manage shutdown exclusively via its own `gracefulShutdown()`, eliminating double signal handling. (#53)
- **Crawlee Request Queue Corruption**: Fixed silent scraping failures where only the first scraped URL returned content. Root cause: Crawlee's global request queue gets corrupted when multiple `CheerioCrawler`/`PlaywrightCrawler` instances are created with `maxRequestsPerCrawl: 1`. Fix: Each crawler now uses its own `Configuration` instance with a unique storage directory.
- **Crawlee STDIO Corruption**: Suppressed Crawlee's default logging which writes to stdout, corrupting the MCP STDIO JSON-RPC protocol. Added `log.setLevel(LogLevel.OFF)` during initialization.
- **YouTube Transcripts**: Upgraded `@danielxceron/youtube-transcript` to ^1.2.6 to fix `playerCaptionsTracklistRenderer` extraction errors
- **EventEmitter Leak**: Fixed process listener cleanup in `PersistentCache.dispose()` to prevent `MaxListenersExceededWarning`
- **Jest Worker Exit**: Guarded STDIO transport initialization in test environments to prevent worker hang

### Changed
- **Zod Upgrade**: Upgraded Zod to ^3.25.0 for SDK compatibility
- **Dead Code Removal**: Removed unused npm dependencies (`youtube-transcript-api`, `youtube-transcript-ts`), deleted orphaned files (`inMemoryEventStore.ts`, `e2e_combined_test.mjs`)

### Documentation
- Fixed duplicate Troubleshooting section in README, replaced with actual troubleshooting content
- Fixed broken links in architecture docs and testing guide
- Updated TODO.md to reflect completed P0 security items
- Replaced placeholder emails in CONTRIBUTING.md and CODE_OF_CONDUCT.md with GitHub security advisory links
- Removed references to non-existent lint/format scripts in CONTRIBUTING.md

## [6.0.0] - 2026-02-07

### Removed
- **Tool Simplification**: Removed `analyze_with_gemini`, `extract_structured_data` tools and the `@google/genai` dependency. The host LLM already has analysis capabilities — delegating to a second LLM was redundant and added confusion for tool selection.
- **Gemini Dependency**: Fully removed `@google/genai` package and `GOOGLE_GEMINI_API_KEY` environment variable.

### Changed
- **Renamed `research_topic` to `search_and_scrape`**: Stripped Gemini analysis step; now returns combined raw scraped content with source attribution instead of an AI-generated summary.

### Added
- **Structured Logging**: Zero-dependency logger (`src/shared/logger.ts`) — JSON in production, human-readable in dev, silent in test.
- **Enhanced Input Validation**: Stricter Zod schemas — `.min()`, `.max()` on all tool parameters.
- **Rate Limiting**: `express-rate-limit` middleware on HTTP transport, keyed on `oauth.sub` or IP.
- **Recency Filtering**: `time_range` parameter on `google_search` — `day`, `week`, `month`, `year`.
- **Source Attribution**: `include_sources` parameter on `search_and_scrape` — appends numbered source URL list.
- **Event Store Encryption**: Wired `EVENT_STORE_ENCRYPTION_KEY` env var to existing AES-256-GCM infrastructure.

## [1.2.1] - 2024-07-15

### Fixed
- **Critical Scraping Issue**: Resolved a critical bug where `scrape_page` and the composite research tool were returning placeholder test content instead of actual scraped web data.
  - **Root Cause**: Removed problematic fallback mechanism that was adding dummy test content when scraped text was shorter than 100 characters.
  - **Impact**: Both tools now consistently return real web content, dramatically improving data quality and user experience.
  - **Verification**: Comprehensive testing confirmed tools now extract actual content from web pages and GitHub discussions.
- **Cache Cleanup**: Cleared all cached placeholder responses to ensure fresh, real content delivery.
- **Build System**: Rebuilt entire project with clean artifacts to ensure fix propagation.

### Improved
- **Testing**: All 244 unit tests and end-to-end tests pass successfully, confirming system integrity.
- **Performance**: Maintained high performance while ensuring data authenticity.


## [1.2.0] - 2025-01-09

### Added
- **Robust YouTube Transcript Extraction**: Implemented a highly resilient YouTube transcript extraction system with comprehensive error handling and automatic retries.
  - **Advanced Error Classification**: The system can now identify 10 distinct error types (e.g., `TRANSCRIPT_DISABLED`, `VIDEO_UNAVAILABLE`, `RATE_LIMITED`), providing clear and actionable feedback.
  - **Exponential Backoff**: A sophisticated retry mechanism with exponential backoff is now in place for transient errors, significantly improving reliability.
  - **Enhanced Logging**: Added detailed logging for the entire transcript extraction process to simplify troubleshooting.
- **Production-Ready Controls**: Introduced environment variables to control and fine-tune the behavior of the YouTube transcript system in production.

### Changed
- **`scrape_page` Tool**: The `scrape_page` tool has been enhanced to seamlessly handle YouTube URLs, leveraging the new transcript extraction system. It now returns detailed error messages for failed transcript extractions.

### Fixed
- **Performance**: Optimized the YouTube transcript extraction process, resulting in a **91% improvement** in end-to-end test performance and an **80% reduction** in log volume.

### Documentation
- Created detailed [Technical Documentation](youtube-transcript-extraction.md) for the new YouTube transcript extraction system.
- Added a comprehensive [API Reference](api-scrape-page.md) for the `scrape_page` tool, including examples of error responses.

## [1.1.0] - 2024-07-06

### Added
- **Complete CI/CD Pipeline:** Implemented a comprehensive CI/CD pipeline using GitHub Actions for fully automated testing, building, and multi-environment publishing (development, pre-release, production) to the npm registry.
- **Automated Package Publishing:** A robust system for managing package versions, including:
  - Development builds with timestamp-based versioning.
  - Pre-release channels for beta and release candidates (RCs).
  - Fully automated production release workflows.
  - Health monitoring and emergency rollback capabilities.
- **Enhanced Tool Descriptions:** Implemented a comprehensive metadata system for all tools to improve discoverability and usability for LLMs, developers, and users. This includes:
  - **Detailed Descriptions:** Each tool now has a multi-line description explaining its purpose, best practices, and use cases.
  - **Parameter Documentation:** Every tool parameter is documented with its type, description, constraints, and usage examples.
  - **Rich Annotations:** Tools are now annotated with a human-readable title, category (`search`, `extraction`, `analysis`, `composite`), complexity, and workflow guidance.
  - **Self-Documenting Code:** The rich metadata serves as living documentation, ensuring that tool information is always up-to-date.
- **Enhanced Testing Infrastructure:** Improved overall test reliability with comprehensive timeout and resilience testing, and more robust E2E test scripts.

### Changed
- **Package Configuration:** Significantly enhanced [`package.json`](package.json:1) for npm publishing, including proper file inclusion/exclusion with [`.npmignore`](.npmignore:1) and automated TypeScript declaration file generation (`.d.ts`).
- **README.md:** Updated the "Available Tools" section with a new, detailed table generated from the enhanced tool metadata, providing a clear and comprehensive overview of the server's capabilities.

### Fixed
- **Unit Test Environment:** Resolved issues with environment variables in unit tests, ensuring consistent and reliable test execution.

### Security
- **NPM Provenance:** Enabled build attestations for published npm packages to guarantee package integrity and provenance.
- **Secure Token Management:** Implemented secure handling of `NPM_TOKEN` in CI/CD workflows.
- **Vulnerability Scanning:** Integrated automated vulnerability scanning into the pipeline to proactively identify and address security risks.

### Documentation
- Comprehensive documentation review and enhancement for public release readiness.

## [1.0.0] - 2025-07-06

### Added
- **Timeout Protection & Reliability:** Implemented comprehensive timeout handling for all external API calls to enhance stability and prevent connection errors.
- **Graceful Degradation:** The composite research tool now continues processing even if some sources fail, ensuring more resilient outcomes.
- **Resource Limiting:** Enforced content size limits to prevent resource exhaustion during scraping and analysis.
- **Comprehensive Timeout Test Suite:** A new end-to-end test suite (`tests/e2e/comprehensive_timeout_test.js`) validates all timeout and error handling mechanisms.
- **OAuth Endpoints:** Added public endpoints for OAuth configuration (`/mcp/oauth-config`) and scope documentation (`/mcp/oauth-scopes`), and an authenticated endpoint to inspect tokens (`/mcp/oauth-token-info`).
- **OAuth Testing:** Added extensive unit tests for the OAuth middleware and scope validation logic.

### Changed
- **Security Model:** Implemented a mandatory OAuth 2.1 Bearer token validation for all protected HTTP endpoints, replacing legacy static API keys. The system uses `jsonwebtoken` and `jwks-rsa` for robust, standard-compliant token verification.
- **Server Architecture:** Refactored the server to use global singleton instances for the `PersistentCache` and `PersistentEventStore`, ensuring data consistency across all transports and sessions.
- **Test Infrastructure:** Reorganized all end-to-end tests into a dedicated `tests/e2e/` directory for improved clarity.
- **Test Hygiene:** Disabled internal timers during test runs (`NODE_ENV === 'test'`) to prevent open handles and improve test stability.
- **Dependencies:** Updated to `@modelcontextprotocol/sdk` version `1.11.0` and added `jsonwebtoken` and `jwks-rsa` for security.
- **Build Process:** Converted all remaining JavaScript files in `src/` to TypeScript and simplified the build process.

### Removed
- **Static API Key Checks:** Removed the insecure `CACHE_ADMIN_KEY` check for management endpoints. Access is now controlled exclusively by granular OAuth scopes.

### Documentation
- **Complete Overhaul:** Updated all major documentation files, including the `README.md`, `CONTRIBUTING.md`, and architecture documents, to reflect the current implementation, security model, and best practices.
- **New Guides:** Created detailed guides for testing, security configuration, and system architecture.
- **Changelog:** Created and formatted this `CHANGELOG.md` to track all notable changes.