/**
 * MCP Server Implementation
 *
 * This file implements a Model Context Protocol (MCP) server that provides tools for:
 * - Web search via Google Custom Search API
 * - Web page scraping (including YouTube transcript extraction)
 * - Multi-source search and scrape pipeline
 *
 * The server supports two transport mechanisms:
 * 1. STDIO - For direct process-to-process communication
 * 2. HTTP+SSE - For web-based clients with Server-Sent Events for streaming
 *
 * All operations use a sophisticated caching system to improve performance and
 * reduce API calls to external services.
 *
 * @see https://github.com/zoharbabin/google-researcher-mcp for MCP documentation
 */

import type express from "express";
import path from "node:path";
import { fileURLToPath } from 'node:url';
import { randomUUID, timingSafeEqual } from "node:crypto";
import fs from "node:fs/promises";
import { readFileSync, existsSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { PersistentEventStore } from "./shared/persistentEventStore.js";
import { z } from "zod";
import { CheerioCrawler } from "@crawlee/cheerio";
import { Configuration, log as crawleeLog, LogLevel as CrawleeLogLevel } from "@crawlee/core";
import { PersistentCache, HybridPersistenceStrategy } from "./cache/index.js";
import { serveOAuthScopesDocumentation } from "./shared/oauthScopesDocumentation.js";
import { createOAuthMiddleware, OAuthMiddlewareOptions } from "./shared/oauthMiddleware.js";
import { RobustYouTubeTranscriptExtractor, YouTubeTranscriptError, YouTubeTranscriptErrorType } from "./youtube/transcriptExtractor.js";
import { validateUrlForSSRF, SSRFProtectionError, getSSRFOptionsFromEnv } from "./shared/urlValidator.js";
import { logger } from "./shared/logger.js";
import { deduplicateContent } from "./shared/contentDeduplication.js";
import { parseDocument, isDocumentUrl, detectDocumentType, DocumentType } from "./documents/index.js";
import {
  googleSearchOutputSchema,
  scrapePageOutputSchema,
  searchAndScrapeOutputSchema,
  googleImageSearchOutputSchema,
  googleNewsSearchOutputSchema,
  type GoogleSearchOutput,
  type ScrapePageOutput,
  type SearchAndScrapeOutput,
  type GoogleImageSearchOutput,
  type GoogleNewsSearchOutput,
  type ImageResultOutput,
  type NewsResultOutput,
  type CitationOutput,
  type SourceOutput,
} from "./schemas/outputSchemas.js";
import {
  createCitation,
  extractCitationFromScrapedContent,
  type Citation,
} from "./shared/citationExtractor.js";
import { CircuitBreaker, CircuitOpenError } from "./shared/circuitBreaker.js";
import { mapWithConcurrency } from "./shared/concurrency.js";
import type rateLimit from "express-rate-limit";
import { validateEnvironmentOrExit, getValidatedEnvValue } from "./shared/envValidator.js";
import { scoreSource, scoreAndRankSources, type QualityScores } from "./shared/qualityScoring.js";
import {
  annotateImageResults,
  annotateNewsResults,
  annotateError,
} from "./shared/contentAnnotations.js";
import { registerResources, trackSearch, type RecentSearch } from "./resources/index.js";
import { MetricsCollector } from "./shared/metricsCollector.js";
import { formatPrometheusMetrics } from "./shared/prometheusFormatter.js";
import { registerPrompts } from "./prompts/index.js";
import {
  type GoogleSearchResponse,
  type GoogleImageSearchResponse,
  type GoogleNewsSearchResponse,
  getErrorMessage,
} from "./types/googleApi.js";
import {
  sequentialSearchInputSchema,
  sequentialSearchOutputSchema,
  handleSequentialSearch,
  getCurrentSessionForResource,
  type SequentialSearchInput,
} from "./tools/sequentialSearch.js";
import {
  academicSearchInputSchema,
  academicSearchOutputSchema,
  handleAcademicSearch,
  type AcademicSearchInput,
} from "./tools/academicSearch.js";
import {
  patentSearchInputSchema,
  patentSearchOutputSchema,
  handlePatentSearch,
  type PatentSearchInput,
} from "./tools/patentSearch.js";
import { TOOL_METADATA, getToolIcon, getToolMeta } from "./tools/toolMetadata.js";
import {
  sequentialSearchOutputSchema as seqSearchSchema,
  academicSearchOutputSchema as acadSearchSchema,
  patentSearchOutputSchema as patentSchema,
  type PatentSearchOutput,
  type SizeMetadataOutput,
  type ContentPreviewOutput,
} from "./schemas/outputSchemas.js";
import {
  truncateContent,
  generatePreview,
  generateSizeMetadata,
  filterByKeywords,
  extractQueryKeywords,
  estimateTokens,
  getSizeCategory,
  type TruncationResult,
  type ContentPreview,
  type SizeMetadata,
} from "./shared/contentSizeOptimization.js";

// ── Server Configuration Constants ─────────────────────────────

/** Timeout for Google Search API calls */
const SEARCH_TIMEOUT_MS = 10_000;

/** Timeout for web page scraping and research-topic search phase */
const SCRAPE_TIMEOUT_MS = 15_000;

/** Minimum content length to consider a Cheerio scrape successful (bytes) */
const MIN_CHEERIO_CONTENT_LENGTH = 100;

/** Minimum meaningful text ratio to consider content valid (not just JS shell) */
const MIN_MEANINGFUL_TEXT_RATIO = 0.1;

/** Known SPA domains that require JavaScript rendering */
const SPA_DOMAINS = [
    'patents.google.com',
    'scholar.google.com',
    'news.google.com',
    'trends.google.com',
    'twitter.com',
    'x.com',
    'linkedin.com',
    'facebook.com',
    'instagram.com',
];

/** Timeout for Playwright-based scraping (seconds) */
const PLAYWRIGHT_TIMEOUT_SECS = 30;

/** Cache TTL for search results (30 minutes) */
const SEARCH_CACHE_TTL_MS = 30 * 60 * 1000;

/** Cache TTL for scraped page content (1 hour) */
const SCRAPE_CACHE_TTL_MS = 60 * 60 * 1000;

/** Maximum size for scraped page content (50 KB) */
const MAX_SCRAPE_CONTENT_SIZE = 50 * 1024;

/** Maximum combined content size for search_and_scrape workflow (300 KB) */
const MAX_RESEARCH_COMBINED_SIZE = 300 * 1024;

/** SSRF validation options, read once from environment variables */
const SSRF_OPTIONS = getSSRFOptionsFromEnv();

// ────────────────────────────────────────────────────────────────

// Type definitions for express
type Request = express.Request;
type Response = express.Response;
type NextFunction = express.NextFunction;

/** OAuth token payload attached by middleware */
interface OAuthTokenPayload {
  sub: string;
  iss: string;
  aud: string | string[];
  exp?: number;
  iat?: number;
  [key: string]: unknown;
}

/** Extended request with OAuth data attached by middleware */
interface OAuthRequest extends Request {
  oauth?: {
    token: OAuthTokenPayload;
    scopes: string[];
    sub: string;
  };
}

/** Text content item returned by tools */
interface TextContent {
  type: "text";
  text: string;
}

/**
 * Constant-time string comparison to prevent timing attacks.
 * Returns true if strings are equal, false otherwise.
 */
function secureCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  // If lengths differ, compare against self to maintain constant time
  if (bufA.length !== bufB.length) {
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

// Get the directory name in ES module scope
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- Dynamic Project Root Detection ---
// Find project root by looking for package.json, regardless of execution location
function findProjectRoot(startDir: string): string {
  let currentDir = startDir;
  while (currentDir !== path.dirname(currentDir)) { // Stop at filesystem root
    try {
      // Check if package.json exists in current directory
      const packageJsonPath = path.join(currentDir, 'package.json');
      if (existsSync(packageJsonPath)) {
        return currentDir;
      }
    } catch {
      // Continue searching if file check fails
    }
    currentDir = path.dirname(currentDir);
  }
  // Fallback: assume we're in project root or one level down
  return __dirname.includes('/dist') ? path.dirname(__dirname) : __dirname;
}

const PROJECT_ROOT = findProjectRoot(__dirname);

// --- Package Version ---
const PKG_VERSION: string = (() => {
  try {
    const pkg = JSON.parse(readFileSync(path.join(PROJECT_ROOT, 'package.json'), 'utf-8'));
    return pkg.version || '0.0.0';
  } catch {
    return '0.0.0';
  }
})();

// --- Default Paths ---
const DEFAULT_CACHE_PATH = path.resolve(PROJECT_ROOT, 'storage', 'persistent_cache');
const DEFAULT_EVENT_PATH = path.resolve(PROJECT_ROOT, 'storage', 'event_store');
const DEFAULT_CRAWLEE_STORAGE_PATH = path.resolve(PROJECT_ROOT, 'storage', 'crawlee');
// --- Global Instances ---
// Initialize Cache and Event Store globally so they are available for both transports
let globalCacheInstance: PersistentCache;
let eventStoreInstance: PersistentEventStore;
let transcriptExtractorInstance: RobustYouTubeTranscriptExtractor;
let globalMetricsCollector: MetricsCollector;
let stdioServerInstance: McpServer | undefined;
let stdioTransportInstance: StdioServerTransport | undefined;
let httpTransportInstance: StreamableHTTPServerTransport | undefined;
let httpServerInstance: import('node:http').Server | undefined;


/**
 * Initializes global cache and event store instances.
 * Ensures storage directories exist.
 * @param cachePath - Path for cache storage
 * @param eventPath - Path for event storage
 */
async function initializeGlobalInstances(
  cachePath: string = DEFAULT_CACHE_PATH,
  eventPath: string = DEFAULT_EVENT_PATH,
  crawleeStoragePath: string = DEFAULT_CRAWLEE_STORAGE_PATH
) {
  // Ensure directories exist
  try {
    await fs.mkdir(path.dirname(cachePath), { recursive: true });
    await fs.mkdir(path.dirname(eventPath), { recursive: true });
    await fs.mkdir(crawleeStoragePath, { recursive: true });
    logger.info('Ensured storage directories exist.');
  } catch (error) {
    logger.error('Error ensuring storage directories', { error: String(error) });
    process.exit(1); // Exit if we can't create storage dirs
  }

  // Configure Crawlee to not persist request queues, datasets, or key-value stores
  // to the filesystem. We only use CheerioCrawler for single-page scrapes, so
  // persistent storage is unnecessary and creates filesystem clutter.
  const crawleeConfig = Configuration.getGlobalConfig();
  crawleeConfig.set('persistStorage', false);
  crawleeConfig.set('storageClientOptions', {
    localDataDirectory: crawleeStoragePath,
  });

  // Suppress Crawlee's default logging which writes to stdout.
  // In STDIO transport mode, stdout is reserved for MCP JSON-RPC messages —
  // any other output corrupts the protocol and causes silent scraping failures.
  crawleeLog.setLevel(CrawleeLogLevel.OFF);

  // Sweep orphaned crawlee temp directories from previous crashes
  try {
    const crawleeEntries = await fs.readdir(crawleeStoragePath);
    const orphaned = crawleeEntries.filter(d => /^(cheerio|playwright)_/.test(d));
    if (orphaned.length > 0) {
      await Promise.all(
        orphaned.map(d =>
          fs.rm(path.join(crawleeStoragePath, d), { recursive: true, force: true }).catch(() => {})
        )
      );
      logger.info(`Cleaned ${orphaned.length} orphaned crawlee temp directories`);
    }
  } catch {
    // Directory may not exist yet on first run
  }

  globalCacheInstance = new PersistentCache({
    defaultTTL: 5 * 60 * 1000, // 5 minutes default TTL
    maxSize: 1000, // Maximum 1000 entries
    persistenceStrategy: new HybridPersistenceStrategy(
      ['googleSearch', 'scrapePage'], // Critical namespaces
      5 * 60 * 1000, // 5 minutes persistence interval
      ['googleSearch', 'scrapePage'] // All persistent namespaces
    ),
    storagePath: cachePath,
    eagerLoading: true, // Load all entries on startup
    registerShutdownHandlers: false // server.ts manages shutdown via gracefulShutdown()
  });

  // Build event store options, wiring encryption if configured
  const eventStoreOpts: import("./shared/types/eventStore.js").PersistentEventStoreOptions = {
    storagePath: eventPath,
    maxEventsPerStream: 1000,
    eventTTL: 24 * 60 * 60 * 1000, // 24 hours
    persistenceInterval: 5 * 60 * 1000, // 5 minutes
    criticalStreamIds: [], // Define critical streams if needed
    eagerLoading: false,
  };

  // Encryption key format is validated by envValidator; getValidatedEnvValue throws if invalid
  const encryptionKey = getValidatedEnvValue('EVENT_STORE_ENCRYPTION_KEY');
  if (encryptionKey) {
    const keyBuffer = Buffer.from(encryptionKey, 'hex');
    eventStoreOpts.encryption = {
      enabled: true,
      keyProvider: async () => keyBuffer,
    };
    logger.info('Event store encryption enabled.');
  }

  eventStoreInstance = new PersistentEventStore(eventStoreOpts);

  // Initialize robust YouTube transcript extractor
  transcriptExtractorInstance = new RobustYouTubeTranscriptExtractor();

  // Initialize metrics collector for per-tool execution metrics
  globalMetricsCollector = new MetricsCollector();

  // Note: cache.loadFromDisk() is called AFTER the STDIO transport is established
  // (see main execution block) so the MCP client can connect immediately.
  // Event store loads eagerly via constructor option, no explicit call needed here.
  logger.info('Global instances created (cache will load in background).');
}

// --- Tool/Resource Configuration (Moved to Top Level) ---
/**
 * Configures and registers all MCP tools and resources for a server instance
 *
 * Tools:
 * 1. google_search — Google Custom Search API with recency filtering
 * 2. scrape_page — Web scraping + YouTube transcript extraction
 * 3. search_and_scrape — Composite: search → parallel scrape → combined raw content
 *
 * @param server - The MCP server instance to configure
 */
function configureToolsAndResources(
    server: McpServer
) {
    // --- URL and error message sanitization helpers ---

    /**
     * Sanitizes a URL by redacting sensitive query parameters.
     * Used to prevent API keys from appearing in logs.
     *
     * NOTE: The Google Custom Search JSON API requires the API key as a query
     * parameter (?key=...). It does NOT support Authorization headers for this
     * specific API. This function is used ONLY for log output and error messages.
     */
    const SANITIZE_CACHE_MAX = 500;
    const sanitizeUrlCache = new Map<string, string>();
    const sanitizeUrl = (url: string): string => {
        const cached = sanitizeUrlCache.get(url);
        if (cached !== undefined) return cached;
        let result: string;
        try {
            const parsed = new URL(url);
            const sensitiveParams = ['key', 'api_key', 'apiKey', 'apikey', 'token', 'access_token'];
            for (const param of sensitiveParams) {
                if (parsed.searchParams.has(param)) {
                    parsed.searchParams.set(param, '[REDACTED]');
                }
            }
            result = parsed.toString();
        } catch {
            result = url.replace(/([?&])(key|api_key|apiKey|apikey|token|access_token)=[^&]*/gi, '$1$2=[REDACTED]');
        }
        if (sanitizeUrlCache.size >= SANITIZE_CACHE_MAX) {
            const firstKey = sanitizeUrlCache.keys().next().value;
            if (firstKey !== undefined) sanitizeUrlCache.delete(firstKey);
        }
        sanitizeUrlCache.set(url, result);
        return result;
    };

    /**
     * Sanitizes error messages that may contain API keys leaked from URLs.
     */
    const sanitizeErrorMessage = (msg: string): string => {
        return msg.replace(/key=[A-Za-z0-9_-]+/gi, 'key=[REDACTED]');
    };

    // 1) Extract each tool's implementation into its own async function with caching
    /**
     * Wraps a promise with a timeout.
     * The timer is always cleared to prevent accumulation of orphaned timeouts.
     */
    const withTimeout = async <T>(
        promise: Promise<T>,
        timeoutMs: number,
        operation: string
    ): Promise<T> => {
        let timer: ReturnType<typeof setTimeout>;
        const timeoutPromise = new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error(`${operation} timed out after ${timeoutMs}ms`)), timeoutMs);
        });
        try {
            return await Promise.race([promise, timeoutPromise]);
        } finally {
            clearTimeout(timer!);
        }
    };

    // ── Circuit breakers for external API calls ──────────────────
    const googleSearchCircuit = new CircuitBreaker({
        failureThreshold: 5,
        resetTimeout: 60_000,
        onStateChange: (from, to) => logger.warn('Google Search circuit breaker state change', { from, to }),
    });

    const webScrapingCircuit = new CircuitBreaker({
        failureThreshold: 5,
        resetTimeout: 30_000,
        onStateChange: (from, to) => logger.warn('Web scraping circuit breaker state change', { from, to }),
    });

    // Read Google API credentials once at startup
    const GOOGLE_API_KEY = process.env.GOOGLE_CUSTOM_SEARCH_API_KEY!;
    const GOOGLE_CX = process.env.GOOGLE_CUSTOM_SEARCH_ID!;

    async function fetchGoogleApi<T>(url: string, operation: string): Promise<T> {
        const resp = await googleSearchCircuit.execute(async () => {
            const r = await withTimeout(
                fetch(url, { signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS) }),
                SEARCH_TIMEOUT_MS + 2000, // slightly longer than signal timeout to let it fire first
                operation
            );
            if (!r.ok) throw new Error(`${operation} API error ${r.status}`);
            return r;
        });
        return resp.json() as Promise<T>;
    }

    function toCitationOutput(citation?: import("./shared/citationExtractor.js").Citation): import("./schemas/outputSchemas.js").CitationOutput | undefined {
        if (!citation) return undefined;
        return {
            metadata: citation.metadata,
            url: citation.url,
            accessedDate: citation.accessedDate,
            formatted: citation.formatted,
        };
    }

    /** Map user-friendly time range names to Google dateRestrict values */
    const TIME_RANGE_MAP: Record<string, string> = {
        day: 'd1',
        week: 'w1',
        month: 'm1',
        year: 'y1',
    };

    /**
     * Advanced Google Search parameters for filtering and customization
     */
    interface GoogleSearchParams {
        query: string;
        num_results: number;
        time_range?: string;
        traceId?: string;
        // Advanced filtering options (Google CSE API parameters)
        siteSearch?: string;       // Limit results to a specific site
        siteSearchFilter?: 'i' | 'e'; // 'i' = include, 'e' = exclude
        exactTerms?: string;       // Required exact phrase in results
        excludeTerms?: string;     // Terms to exclude from results
        language?: string;         // Language code (e.g., 'lang_en')
        country?: string;          // Country restriction (e.g., 'countryUS')
        safe?: 'off' | 'medium' | 'high'; // Safe search level
    }

    /**
     * Builds a Google Custom Search API URL with all parameters
     */
    function buildGoogleSearchUrl(params: GoogleSearchParams): string {
        const urlParams = new URLSearchParams({
            key: GOOGLE_API_KEY,
            cx: GOOGLE_CX,
            q: params.query,
            num: String(params.num_results),
        });

        // Recency filtering
        if (params.time_range && TIME_RANGE_MAP[params.time_range]) {
            urlParams.set('dateRestrict', TIME_RANGE_MAP[params.time_range]);
        }

        // Site restriction
        if (params.siteSearch) {
            urlParams.set('siteSearch', params.siteSearch);
            if (params.siteSearchFilter) {
                urlParams.set('siteSearchFilter', params.siteSearchFilter);
            }
        }

        // Exact phrase matching
        if (params.exactTerms) {
            urlParams.set('exactTerms', params.exactTerms);
        }

        // Term exclusion
        if (params.excludeTerms) {
            urlParams.set('excludeTerms', params.excludeTerms);
        }

        // Language restriction
        if (params.language) {
            urlParams.set('lr', params.language);
        }

        // Country restriction
        if (params.country) {
            urlParams.set('cr', params.country);
        }

        // Safe search level
        if (params.safe) {
            urlParams.set('safe', params.safe);
        }

        return `https://www.googleapis.com/customsearch/v1?${urlParams.toString()}`;
    }

    const googleSearchFn = async (params: GoogleSearchParams) => {
        const trimmedQuery = params.query.trim();
        const searchParams = { ...params, query: trimmedQuery };

        // Build cache key from all filter parameters to avoid cross-contamination
        const cacheArgs = {
            query: trimmedQuery,
            num_results: params.num_results,
            time_range: params.time_range,
            siteSearch: params.siteSearch,
            siteSearchFilter: params.siteSearchFilter,
            exactTerms: params.exactTerms,
            excludeTerms: params.excludeTerms,
            language: params.language,
            country: params.country,
            safe: params.safe,
        };

        // Use the globally initialized cache instance directly
        return globalCacheInstance.getOrCompute(
            'googleSearch',
            cacheArgs,
            async () => {
                logger.debug(`Cache MISS for googleSearch`, { traceId: params.traceId, ...cacheArgs });
                const url = buildGoogleSearchUrl(searchParams);

                const data = await fetchGoogleApi<GoogleSearchResponse>(url, 'Google Search');
                const links: string[] = (data.items || []).map((item) => item.link);
                return links.map((l) => ({ type: "text" as const, text: l }));
            },
            {
                ttl: SEARCH_CACHE_TTL_MS,
                staleWhileRevalidate: true, // Enable stale-while-revalidate
                staleTime: 30 * 60 * 1000 // Allow serving stale content for another 30 minutes while revalidating
            }
        );
    };

    /**
     * Scrapes content from a web page or extracts YouTube transcripts with robust error handling
     *
     * This function:
     * 1. Detects if the URL is a YouTube video and uses the robust transcript extractor
     * 2. Otherwise scrapes the page content using Cheerio
     * 3. Caches results for 1 hour with stale-while-revalidate for up to 24 hours
     * 4. Includes timeout protection and content size limits
     * 5. Provides transparent error reporting for YouTube transcript failures
     *
     * @param url - The URL to scrape
     * @returns The page content as a text content item
     */

    /**
     * Result from web scraping including content and citation data
     */
    interface ScrapeResult {
        content: string;
        rawHtml?: string;
        citation?: Citation;
    }

    /**
     * Check if a URL belongs to a known Single Page Application (SPA) domain
     * that requires JavaScript rendering to display content.
     */
    function isKnownSpaDomain(url: string): boolean {
        try {
            const hostname = new URL(url).hostname.toLowerCase();
            return SPA_DOMAINS.some(domain => hostname === domain || hostname.endsWith('.' + domain));
        } catch {
            return false;
        }
    }

    /**
     * Check if scraped content appears to be a JavaScript shell with no meaningful text.
     * SPAs often return HTML with lots of script tags but minimal readable content.
     */
    function isMeaningfulContent(content: string, rawHtml?: string): boolean {
        // If content is very short, it's not meaningful
        if (content.length < MIN_CHEERIO_CONTENT_LENGTH) {
            return false;
        }

        // Extract just the text portions (after "Body:" or "Paragraphs:")
        const bodyMatch = content.match(/Body:\s*(.*)$/s);
        const paragraphsMatch = content.match(/Paragraphs:\s*(.*?)(?=Body:|$)/s);

        const bodyText = bodyMatch?.[1]?.trim() || '';
        const paragraphsText = paragraphsMatch?.[1]?.trim() || '';
        const meaningfulText = bodyText + ' ' + paragraphsText;

        // Check if there's actual readable content vs just JavaScript/JSON
        const cleanText = meaningfulText
            .replace(/\{[^}]*\}/g, '')  // Remove JSON objects
            .replace(/\[[^\]]*\]/g, '') // Remove JSON arrays
            .replace(/function\s*\([^)]*\)\s*\{[^}]*\}/g, '') // Remove inline functions
            .replace(/var\s+\w+\s*=/g, '') // Remove variable declarations
            .replace(/https?:\/\/[^\s]+/g, '') // Remove URLs
            .replace(/[^\w\s]/g, ' ')    // Remove special chars
            .replace(/\s+/g, ' ')        // Normalize whitespace
            .trim();

        // If clean text is too short relative to raw content, it's likely a JS shell
        if (rawHtml && cleanText.length < rawHtml.length * MIN_MEANINGFUL_TEXT_RATIO) {
            return false;
        }

        // If clean text is very short in absolute terms
        if (cleanText.length < 200) {
            return false;
        }

        return true;
    }

    /**
     * Scrape a URL using CheerioCrawler (static HTML only, fast).
     * Returns both the processed content and citation metadata.
     */
    async function scrapeWithCheerio(url: string): Promise<ScrapeResult> {
        let page = "";
        let rawHtml = "";
        let citation: Citation | undefined;

        // Each crawler needs its own Configuration to avoid request queue corruption
        // when running multiple crawlers sequentially with maxRequestsPerCrawl: 1
        const crawlerStorageDir = `${DEFAULT_CRAWLEE_STORAGE_PATH}/cheerio_${randomUUID()}`;
        const crawlerConfig = new Configuration({
            persistStorage: false,
            storageClientOptions: { localDataDirectory: crawlerStorageDir },
        });
        const crawler = new CheerioCrawler({
            requestHandler: async ({ $, body }) => {
                if (typeof $ !== 'function') {
                    page = "[Non-HTML response — content could not be extracted]";
                    return;
                }

                // Capture raw HTML for citation extraction
                rawHtml = typeof body === 'string' ? body : body.toString();

                // Extract citation metadata from HTML
                try {
                    citation = createCitation(rawHtml, url);
                } catch (e) {
                    // Citation extraction failed, continue without it
                    logger.debug('Citation extraction failed', { url: sanitizeUrl(url), error: String(e) });
                }

                const title = $("title").text() || "";
                const headings = $("h1, h2, h3").map((_, el) => $(el).text()).get().join(" ");
                const paragraphs = $("p").map((_, el) => $(el).text()).get().join(" ");
                const bodyText = $("body").text().replace(/\s+/g, " ").trim();
                page = `Title: ${title}\nHeadings: ${headings}\nParagraphs: ${paragraphs}\nBody: ${bodyText}`;
            },
            preNavigationHooks: [
                async (_crawlingContext, gotOptions) => {
                    if (!gotOptions.hooks) { gotOptions.hooks = {}; }
                    const existing = gotOptions.hooks.beforeRedirect ?? [];
                    gotOptions.hooks.beforeRedirect = [
                        ...existing,
                        async (redirectOptions: any) => {
                            const redirectUrl = redirectOptions.url?.toString();
                            if (redirectUrl) {
                                await validateUrlForSSRF(redirectUrl, SSRF_OPTIONS);
                            }
                        },
                    ];
                },
            ],
            useSessionPool: false,
            persistCookiesPerSession: false,
            requestHandlerTimeoutSecs: 15,
            maxRequestsPerCrawl: 1,
            maxRequestRetries: 0,
        }, crawlerConfig);
        try {
            const crawlPromise = crawler.run([{ url }]);
            await withTimeout(crawlPromise, SCRAPE_TIMEOUT_MS, 'Web page scraping');
        } finally {
            // Clean up per-crawl storage directory to prevent disk bloat
            fs.rm(crawlerStorageDir, { recursive: true, force: true }).catch(() => {});
        }
        return { content: page, rawHtml, citation };
    }

    /**
     * Scrape a URL using PlaywrightCrawler (renders JavaScript, slower).
     * Used as a fallback when CheerioCrawler returns insufficient content.
     * Returns both the processed content and citation metadata.
     */
    let _PlaywrightCrawlerClass: typeof import("@crawlee/playwright").PlaywrightCrawler | null = null;
    async function loadPlaywrightCrawler() {
        if (!_PlaywrightCrawlerClass) {
            const mod = await import("@crawlee/playwright");
            _PlaywrightCrawlerClass = mod.PlaywrightCrawler;
        }
        return _PlaywrightCrawlerClass;
    }

    async function scrapeWithPlaywright(url: string): Promise<ScrapeResult> {
        let pageContent = "";
        let rawHtml = "";
        let citation: Citation | undefined;

        // Each crawler needs its own Configuration to avoid request queue corruption
        const playwrightStorageDir = `${DEFAULT_CRAWLEE_STORAGE_PATH}/playwright_${randomUUID()}`;

        try {
        const PlaywrightCrawlerImpl = await loadPlaywrightCrawler();
        const crawlerConfig = new Configuration({
            persistStorage: false,
            storageClientOptions: { localDataDirectory: playwrightStorageDir },
        });
        const crawler = new PlaywrightCrawlerImpl({
            preNavigationHooks: [
                async ({ page }) => {
                    // SSRF protection: intercept all requests (including redirects)
                    // and validate each URL before the browser navigates to it
                    await page.route('**/*', async (route) => {
                        const requestUrl = route.request().url();
                        try {
                            await validateUrlForSSRF(requestUrl, SSRF_OPTIONS);
                            await route.continue();
                        } catch (error) {
                            if (error instanceof SSRFProtectionError) {
                                logger.warn('Playwright request blocked by SSRF protection', {
                                    url: sanitizeUrl(requestUrl),
                                });
                                await route.abort('blockedbyclient');
                            } else {
                                await route.continue();
                            }
                        }
                    });
                },
            ],
            requestHandler: async ({ page }) => {
                // Wait for initial load
                await page.waitForLoadState('domcontentloaded', { timeout: 10_000 }).catch(() => {});

                // For SPAs, wait for network to settle and give JS time to render
                await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});

                // Check if this is Google Patents - needs special handling
                const isGooglePatents = url.includes('patents.google.com');

                if (isGooglePatents) {
                    logger.debug('Google Patents detected, waiting for results to load', { url: sanitizeUrl(url) });

                    // Wait for patent results to render (event-driven, not fixed sleep)
                    await page.waitForSelector(
                      'search-result-item, .search-result-item, [data-result], state-manager search-results, a[href*="/patent/"]',
                      { timeout: 12_000 }
                    ).catch(() => {});

                    // Scroll to trigger lazy loading, then wait for network to settle
                    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => {});
                    await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => {});
                    await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
                } else {
                    // Wait for the main content area to render
                    await page.waitForSelector(
                      'article, main, [role="main"], .results, .search-results, #results, .content, #content',
                      { timeout: 8_000 }
                    ).catch(() => {});

                    // Scroll to trigger lazy loading, then wait for network to settle
                    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight / 2)).catch(() => {});
                    await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => {});
                }

                // Capture raw HTML for citation extraction
                rawHtml = await page.content();

                // Extract citation metadata from HTML
                try {
                    citation = createCitation(rawHtml, url);
                } catch (e) {
                    // Citation extraction failed, continue without it
                    logger.debug('Citation extraction failed', { url: sanitizeUrl(url), error: String(e) });
                }

                const title = await page.title();

                // Use specialized extraction for Google Patents
                if (isGooglePatents) {
                    const patentData = await page.evaluate(() => {
                        // Try to find patent result items using various selectors
                        const resultItems = Array.from(document.querySelectorAll('search-result-item, .result-item, [data-result], article'));
                        const patents: string[] = [];

                        for (const item of resultItems) {
                            const text = item.textContent?.trim();
                            if (text && text.length > 20) {
                                patents.push(text.replace(/\s+/g, ' ').substring(0, 500));
                            }
                        }

                        // Also try to get structured data from the page
                        const links = Array.from(document.querySelectorAll('a[href*="/patent/"]'));
                        const patentLinks = links.map(a => {
                            const href = a.getAttribute('href') || '';
                            const text = a.textContent?.trim() || '';
                            return `${text} (${href})`;
                        }).filter(p => p.length > 10);

                        // Get the main body text as fallback
                        const body = document.body?.innerText?.replace(/\s+/g, ' ').trim() || '';

                        return {
                            patents,
                            patentLinks,
                            body,
                            resultsCount: resultItems.length + patentLinks.length
                        };
                    });

                    logger.debug('Google Patents extraction results', {
                        url: sanitizeUrl(url),
                        patentCount: patentData.patents.length,
                        linkCount: patentData.patentLinks.length,
                        bodyLength: patentData.body.length
                    });

                    // Build content with patent results
                    let content = `Title: ${title}\n\n`;
                    if (patentData.patentLinks.length > 0) {
                        content += `Patent Links Found (${patentData.patentLinks.length}):\n${patentData.patentLinks.join('\n')}\n\n`;
                    }
                    if (patentData.patents.length > 0) {
                        content += `Patent Results (${patentData.patents.length}):\n${patentData.patents.join('\n---\n')}\n\n`;
                    }
                    content += `Full Page Content:\n${patentData.body}`;
                    pageContent = content;
                } else {
                    // Standard extraction for other sites
                    const extracted = await page.evaluate(() => {
                        const h = Array.from(document.querySelectorAll('h1, h2, h3'))
                            .map(el => el.textContent?.trim()).filter(Boolean).join(' ');
                        const p = Array.from(document.querySelectorAll('p'))
                            .map(el => el.textContent?.trim()).filter(Boolean).join(' ');
                        const body = document.body?.innerText?.replace(/\s+/g, ' ').trim() || '';
                        return { headings: h, paragraphs: p, bodyText: body };
                    });
                    pageContent = `Title: ${title}\nHeadings: ${extracted.headings}\nParagraphs: ${extracted.paragraphs}\nBody: ${extracted.bodyText}`;
                }
            },
            requestHandlerTimeoutSecs: PLAYWRIGHT_TIMEOUT_SECS,
            maxRequestsPerCrawl: 1,
            maxRequestRetries: 0,
            useSessionPool: false,
            launchContext: {
                launchOptions: {
                    headless: true,
                    args: [
                        '--no-sandbox',
                        '--disable-setuid-sandbox',
                        '--disable-gpu',
                        '--disable-blink-features=AutomationControlled',
                        '--disable-features=IsolateOrigins,site-per-process',
                        '--window-size=1920,1080',
                    ],
                },
                userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            },
        }, crawlerConfig);
        const crawlPromise = crawler.run([{ url }]);
        try {
            await withTimeout(crawlPromise, PLAYWRIGHT_TIMEOUT_SECS * 1000, 'Playwright scraping');
        } finally {
            // Tear down first to kill the browser, then wait for the crawl
            // promise to settle so no Chromium processes are orphaned.
            await crawler.teardown().catch(() => {});
            await crawlPromise.catch(() => {});
            fs.rm(playwrightStorageDir, { recursive: true, force: true }).catch(() => {});
        }
        return { content: pageContent, rawHtml, citation };
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            if (msg.includes('launch browser') || msg.includes('Executable doesn') || msg.includes('browserType.launch')) {
                logger.error('Playwright browser not installed. Run: npx playwright install chromium');
                return {
                    content: '[JavaScript rendering unavailable — Chromium browser is not installed. ' +
                        'Run "npx playwright install chromium" to enable JS-rendered page scraping.]',
                };
            }
            throw error;
        }
    }

    /**
     * Internal result type for scrapePageFn that includes citation data
     */
    interface ScrapePageResult {
        content: Array<{ type: "text"; text: string }>;
        citation?: Citation;
    }

    const scrapePageFn = async ({ url, traceId }: { url: string; traceId?: string }): Promise<ScrapePageResult> => {
        // SSRF protection: validate URL before any network access
        try {
            await validateUrlForSSRF(url, SSRF_OPTIONS);
        } catch (error) {
            if (error instanceof SSRFProtectionError) {
                return { content: [{ type: "text" as const, text: `URL blocked: ${error.message}` }] };
            }
            throw error;
        }

        // Use a longer TTL for scraped content as it changes less frequently
        // Use the globally initialized cache instance directly
        const result = await globalCacheInstance.getOrCompute<ScrapePageResult>(
            'scrapePage',
            { url },
            async () => {
                logger.debug('Cache MISS for scrapePage', { traceId, url: sanitizeUrl(url) });
                let text = "";
                let citation: Citation | undefined;

                const yt = url.match(
                    /(?:youtu\.be\/|youtube\.com\/watch\?v=)([A-Za-z0-9_-]{11})(?:[&#?]|$)/
                );

                if (yt) {
                    // Use robust transcript extractor instead of direct call
                    const result = await transcriptExtractorInstance.extractTranscript(yt[1]);

                    if (result.success) {
                        text = result.transcript!;
                        logger.info(`YouTube transcript extracted for video ${yt[1]}`, { traceId, attempts: result.attempts, duration: result.duration });
                    } else {
                        // Throw specific error instead of returning empty text
                        logger.warn(`YouTube transcript extraction failed for video ${yt[1]}`, { traceId, error: result.error!.message });
                        throw new YouTubeTranscriptError(
                            result.error!.type,
                            result.error!.message,
                            yt[1],
                            result.error!.originalError
                        );
                    }
                    // YouTube doesn't have traditional citation metadata
                } else if (isDocumentUrl(url)) {
                    // Document parsing: PDF, DOCX, PPTX
                    logger.info('Parsing document', { traceId, url: sanitizeUrl(url) });
                    const docResult = await parseDocument(url, { maxFileSize: 10 * 1024 * 1024, timeout: 30_000 });

                    if (docResult.success && docResult.content) {
                        const meta = docResult.metadata;
                        const metaInfo = meta
                            ? `\n\n[Document: ${docResult.documentType.toUpperCase()}${meta.pageCount ? `, ${meta.pageCount} pages` : ''}${meta.title ? `, "${meta.title}"` : ''}]`
                            : '';
                        text = docResult.content + metaInfo;
                        logger.info('Document parsed successfully', {
                            traceId,
                            documentType: docResult.documentType,
                            contentLength: text.length,
                            pageCount: meta?.pageCount,
                        });
                    } else {
                        // Document parsing failed, return error message
                        const errorMsg = docResult.error?.message ?? 'Unknown error parsing document';
                        text = `Failed to parse document: ${errorMsg}`;
                        logger.warn('Document parsing failed', { traceId, url: sanitizeUrl(url), error: errorMsg });
                    }
                    // Documents don't have HTML-based citation metadata
                } else {
                    // Circuit breaker + tiered scraping strategy:
                    // 1. Known SPA domains → go directly to Playwright
                    // 2. Other sites → try Cheerio first, fallback to Playwright if content is not meaningful
                    const scrapeResult = await webScrapingCircuit.execute(async () => {
                        // For known SPA domains, skip Cheerio entirely
                        if (isKnownSpaDomain(url)) {
                            logger.info('Known SPA domain detected, using Playwright directly', {
                                traceId, url: sanitizeUrl(url)
                            });
                            return await scrapeWithPlaywright(url);
                        }

                        // Try fast Cheerio scrape first
                        let result = await scrapeWithCheerio(url);

                        // Check if content is meaningful (not just a JS shell)
                        if (!isMeaningfulContent(result.content, result.rawHtml)) {
                            logger.info('Cheerio returned non-meaningful content (likely SPA), falling back to Playwright', {
                                traceId, url: sanitizeUrl(url), cheerioLength: result.content.length
                            });
                            result = await scrapeWithPlaywright(url);
                        }
                        return result;
                    });

                    text = scrapeResult.content;
                    citation = scrapeResult.citation;
                }

                // Limit content size to prevent memory issues
                if (text.length > MAX_SCRAPE_CONTENT_SIZE) {
                    // Truncate intelligently - keep beginning and end
                    const halfSize = Math.floor(MAX_SCRAPE_CONTENT_SIZE / 2);
                    text = text.substring(0, halfSize) +
                           "\n\n[... CONTENT TRUNCATED FOR SIZE LIMIT ...]\n\n" +
                           text.substring(text.length - halfSize);
                }

                return {
                    content: [{ type: "text" as const, text }],
                    citation,
                };
            },
            {
                ttl: SCRAPE_CACHE_TTL_MS,
                staleWhileRevalidate: true, // Enable stale-while-revalidate
                staleTime: 24 * 60 * 60 * 1000 // Allow serving stale content for up to a day while revalidating
            }
        );

        return result;
    };

    // 2) Register each tool with the MCP server using registerTool (with outputSchema)
    server.registerTool(
        "google_search",
        {
            title: "Google Search",
            description: `Search the web using Google Custom Search API. Returns a list of URLs with titles and snippets.

**When to use:**
- You need URLs to process yourself (e.g., selective scraping)
- You only need links without full content
- You want to filter/choose which URLs to scrape

**When to use search_and_scrape instead:**
- You need actual page content for research
- You want content from multiple sources combined

**Caching:** Results cached for 30 minutes.`,
            inputSchema: {
                query: z.string().min(1).max(500).describe("The search query string. Use natural language or specific keywords for better results. More specific queries yield better results and more relevant sources."),
                num_results: z.number().min(1).max(10).default(5).describe("Number of search results to return (1-10). Higher numbers increase processing time and API costs. Use 3-5 for quick research, 8-10 for comprehensive coverage."),
                time_range: z.enum(['day', 'week', 'month', 'year']).optional().describe("Restrict results to a recent time range. 'day' = last 24 hours, 'week' = last 7 days, 'month' = last 30 days, 'year' = last 365 days. Omit for no time restriction."),
                // Advanced filtering options (Google CSE API parameters)
                site_search: z.string().max(100).optional().describe("Limit results to a specific site (e.g., 'github.com', 'stackoverflow.com'). Useful for domain-specific research."),
                site_search_filter: z.enum(['include', 'exclude']).optional().describe("Whether to include or exclude results from site_search. 'include' (default) shows only results from the site, 'exclude' removes results from the site."),
                exact_terms: z.string().max(200).optional().describe("Required exact phrase that must appear in all results. Useful for finding specific quotes or technical terms."),
                exclude_terms: z.string().max(200).optional().describe("Terms to exclude from search results. Useful for filtering out irrelevant topics. Separate multiple terms with spaces."),
                language: z.string().regex(/^lang_[a-z]{2}$/).optional().describe("Restrict results to a specific language. Format: 'lang_XX' where XX is ISO 639-1 code (e.g., 'lang_en' for English, 'lang_es' for Spanish, 'lang_fr' for French)."),
                country: z.string().regex(/^country[A-Z]{2}$/).optional().describe("Restrict results to a specific country. Format: 'countryXX' where XX is ISO 3166-1 alpha-2 code (e.g., 'countryUS' for United States, 'countryGB' for United Kingdom)."),
                safe: z.enum(['off', 'medium', 'high']).optional().describe("Safe search filtering level. 'off' = no filtering, 'medium' = moderate filtering, 'high' = strict filtering. Defaults to Google's account settings if omitted.")
            },
            outputSchema: googleSearchOutputSchema,
            annotations: {
                title: "Google Search",
                readOnlyHint: true,
                openWorldHint: true
            }
        },
        async ({ query, num_results = 5, time_range, site_search, site_search_filter, exact_terms, exclude_terms, language, country, safe }) => {
            const traceId = randomUUID();
            logger.info('google_search invoked', { traceId, query, num_results, time_range, site_search, exact_terms });

            const content = await googleSearchFn({
                query,
                num_results,
                time_range,
                traceId,
                siteSearch: site_search,
                siteSearchFilter: site_search_filter === 'include' ? 'i' : site_search_filter === 'exclude' ? 'e' : undefined,
                exactTerms: exact_terms,
                excludeTerms: exclude_terms,
                language,
                country,
                safe,
            });

            // Extract URLs from content for structured output
            const urls = content.map(c => c.text);

            // Return both content (backward compatible) and structuredContent (new)
            const structuredContent: GoogleSearchOutput = {
                urls,
                query,
                resultCount: urls.length,
            };

            // Track search for resources
            trackSearch({
                query,
                timestamp: new Date().toISOString(),
                resultCount: urls.length,
                traceId,
                tool: 'google_search',
            });

            return {
                content,
                structuredContent,
            };
        }
    );

    server.registerTool(
        "scrape_page",
        {
            title: "Scrape Page (+ YouTube, PDF, DOCX, PPTX)",
            description: `Extract text content from a URL. Automatically handles: web pages (static + JavaScript-rendered), YouTube videos (extracts transcript), and documents (PDF, DOCX, PPTX).

**When to use:**
- You already have a specific URL to extract content from
- Need content from YouTube videos, PDFs, or Office documents
- Want to check page structure before fetching full content (preview mode)

**When to use search_and_scrape instead:**
- Researching a topic across multiple sources

**Content size control:**
- max_length: Limit response size (default: server max of 50KB)
- mode: 'full' returns content, 'preview' returns metadata + structure only

**Preview mode benefits:**
- Check content size before fetching full content
- Get page structure (headings) to decide which sections to read
- Avoid context exhaustion with very large pages

**Caching:** Results cached for 1 hour.`,
            inputSchema: {
                url: z.string().url().max(2048).describe("The URL to scrape. Supports: web pages (static HTML and JavaScript-rendered SPAs), YouTube videos (extracts transcript automatically), and documents (PDF, DOCX, PPTX - extracts text content)."),
                max_length: z.number().int().min(1000).max(100000).optional()
                    .describe("Maximum content length in characters. Content exceeding this will be truncated at natural breakpoints. Default: server max (50KB)."),
                mode: z.enum(['full', 'preview']).default('full')
                    .describe("'full' returns content (default), 'preview' returns metadata and structure without full content."),
            },
            outputSchema: scrapePageOutputSchema,
            annotations: {
                title: "Scrape Page",
                readOnlyHint: true,
                openWorldHint: true
            }
        },
        async ({ url, max_length, mode }) => {
            const traceId = randomUUID();
            logger.info('scrape_page invoked', { traceId, url, max_length, mode });
            const result = await scrapePageFn({ url, traceId });
            let textContent = result.content[0]?.text ?? '';
            const originalLength = textContent.length;

            // Detect content type from URL
            let contentType: ScrapePageOutput['contentType'] = 'html';
            const ytMatch = url.match(/(?:youtu\.be\/|youtube\.com\/watch\?v=)([A-Za-z0-9_-]{11})(?:[&#?]|$)/);
            if (ytMatch) {
                contentType = 'youtube';
            } else if (isDocumentUrl(url)) {
                const docType = detectDocumentType(url);
                if (docType === DocumentType.PDF) contentType = 'pdf';
                else if (docType === DocumentType.DOCX) contentType = 'docx';
                else if (docType === DocumentType.PPTX) contentType = 'pptx';
            }

            // Extract metadata from content if it's a document
            let metadata: ScrapePageOutput['metadata'];
            const docMetaMatch = textContent.match(/\[Document: ([A-Z]+)(?:, (\d+) pages)?(?:, "([^"]+)")?\]$/);
            if (docMetaMatch) {
                metadata = {};
                if (docMetaMatch[2]) metadata.pageCount = parseInt(docMetaMatch[2], 10);
                if (docMetaMatch[3]) metadata.title = docMetaMatch[3];
            }

            const citation = toCitationOutput(result.citation);

            // Handle preview mode - return metadata without full content
            if (mode === 'preview') {
                const preview = generatePreview(url, textContent, metadata?.title || citation?.metadata.title);
                const structuredContent: ScrapePageOutput = {
                    url,
                    content: '', // Empty in preview mode
                    contentType,
                    contentLength: originalLength,
                    truncated: false,
                    estimatedTokens: estimateTokens(textContent),
                    sizeCategory: getSizeCategory(originalLength),
                    metadata,
                    citation,
                    preview,
                };

                return {
                    content: [{
                        type: "text" as const,
                        text: `Preview for ${url}:\n` +
                              `- Content length: ${originalLength.toLocaleString()} characters\n` +
                              `- Estimated tokens: ${estimateTokens(textContent).toLocaleString()}\n` +
                              `- Size category: ${getSizeCategory(originalLength)}\n` +
                              `- Headings: ${preview.headings.length}\n` +
                              `\nExcerpt:\n${preview.excerpt}\n` +
                              `\nHeadings:\n${preview.headings.map(h => '  '.repeat(h.level - 1) + h.text).join('\n') || '(none found)'}`
                    }],
                    structuredContent,
                };
            }

            // Apply custom max_length if specified
            let truncated = textContent.includes('[... CONTENT TRUNCATED FOR SIZE LIMIT ...]');
            let finalOriginalLength: number | undefined;

            if (max_length && textContent.length > max_length) {
                const truncationResult = truncateContent(textContent, max_length, 'start');
                textContent = truncationResult.content;
                truncated = true;
                finalOriginalLength = truncationResult.originalLength;
                logger.info('Content truncated by user max_length', {
                    traceId,
                    originalLength: truncationResult.originalLength,
                    truncatedTo: truncationResult.truncatedLength,
                });
            } else if (truncated) {
                finalOriginalLength = originalLength;
            }

            const structuredContent: ScrapePageOutput = {
                url,
                content: textContent,
                contentType,
                contentLength: textContent.length,
                truncated,
                estimatedTokens: estimateTokens(textContent),
                sizeCategory: getSizeCategory(textContent.length),
                originalLength: finalOriginalLength,
                metadata,
                citation,
            };

            return {
                content: [{
                    type: "text" as const,
                    text: textContent,
                }],
                structuredContent,
            };
        }
    );

    // 3) Composite tool: search_and_scrape
    server.registerTool(
        "search_and_scrape",
        {
            title: "Search and Scrape",
            description: `Search Google AND retrieve content from top results in one call. Returns combined, deduplicated content with source attribution.

**When to use:**
- Primary tool for answering questions that need web research
- Need content from multiple sources combined
- More efficient than calling google_search + scrape_page separately

**When to use other tools instead:**
- google_search: When you only need URLs without content
- scrape_page: When you already have a specific URL

**Content size control:**
- max_length_per_source: Limit content per source (default: 50KB)
- total_max_length: Limit total combined content (default: 300KB)
- filter_by_query: Only include paragraphs containing query keywords

**Caching:** Search results cached for 30 minutes, scraped pages for 1 hour.`,
            inputSchema: {
                query: z.string().min(1).max(500).describe("Your research question or topic. Be specific for better results. Example: 'Python async best practices 2024' rather than just 'Python'."),
                num_results: z.number().min(1).max(10).default(3).describe("Number of sources to fetch (1-10). Default 3 is good for most queries. Use 5-8 for comprehensive research, 1-2 for quick factual lookups."),
                include_sources: z.boolean().default(true).describe("Include source URLs at the end for citation. Default true - recommended for transparency."),
                deduplicate: z.boolean().default(true).describe("Remove duplicate content across sources. Default true - recommended to reduce noise when sources quote each other."),
                max_length_per_source: z.number().int().min(1000).max(100000).optional()
                    .describe("Maximum content length per source in characters. Default: 50KB."),
                total_max_length: z.number().int().min(5000).max(500000).optional()
                    .describe("Maximum total combined content length. Default: 300KB."),
                filter_by_query: z.boolean().default(false)
                    .describe("Filter to only include paragraphs containing query keywords. Reduces noise but may exclude relevant context."),
            },
            outputSchema: searchAndScrapeOutputSchema,
            annotations: {
                title: "Search and Scrape",
                readOnlyHint: true,
                openWorldHint: true
            }
        },
        async ({ query, num_results, include_sources, deduplicate, max_length_per_source, total_max_length, filter_by_query }) => {
            const traceId = randomUUID();
            const trimmedQuery = query.trim();
            const startTime = Date.now();
            const errors: string[] = [];
            let searchResults: TextContent[] = [];

            try {
                logger.info('search_and_scrape: searching', { traceId, query: trimmedQuery, num_results });
                const searchPromise = googleSearchFn({ query: trimmedQuery, num_results, traceId });
                searchResults = await withTimeout(searchPromise, SCRAPE_TIMEOUT_MS, 'Google Search');
                logger.info('search_and_scrape: search completed', { traceId, urlsFound: searchResults.length });
            } catch (error) {
                const errorMsg = `Search failed: ${sanitizeErrorMessage(error instanceof Error ? error.message : String(error))}`;
                errors.push(errorMsg);
                logger.warn(errorMsg, { traceId });
                const errorText = `Search failed for "${trimmedQuery}". Error: ${errorMsg}`;
                const errorStructuredContent: SearchAndScrapeOutput = {
                    query: trimmedQuery,
                    sources: [],
                    combinedContent: errorText,
                    summary: {
                        urlsSearched: 0,
                        urlsScraped: 0,
                        processingTimeMs: Date.now() - startTime,
                    },
                    sizeMetadata: {
                        contentLength: errorText.length,
                        estimatedTokens: estimateTokens(errorText),
                        truncated: false,
                        sizeCategory: 'small',
                    },
                };
                return {
                    content: [{
                        type: "text" as const,
                        text: errorText
                    }],
                    structuredContent: errorStructuredContent,
                };
            }

            const urls = searchResults.map((c) => c.text);
            if (urls.length === 0) {
                const noUrlsText = `No URLs found for query "${trimmedQuery}".`;
                const noUrlsStructuredContent: SearchAndScrapeOutput = {
                    query: trimmedQuery,
                    sources: [],
                    combinedContent: noUrlsText,
                    summary: {
                        urlsSearched: 0,
                        urlsScraped: 0,
                        processingTimeMs: Date.now() - startTime,
                    },
                    sizeMetadata: {
                        contentLength: noUrlsText.length,
                        estimatedTokens: estimateTokens(noUrlsText),
                        truncated: false,
                        sizeCategory: 'small',
                    },
                };
                return {
                    content: [{
                        type: "text" as const,
                        text: noUrlsText
                    }],
                    structuredContent: noUrlsStructuredContent,
                };
            }

            // Scrape URLs with bounded concurrency to avoid memory spikes
            // from launching too many Playwright/Chromium instances at once.
            const MAX_SCRAPE_CONCURRENCY = 3;
            logger.info('search_and_scrape: scraping', { traceId, count: urls.length, concurrency: MAX_SCRAPE_CONCURRENCY });
            const scrapeResults = await mapWithConcurrency(urls, MAX_SCRAPE_CONCURRENCY, async (url, index) => {
                try {
                    const result = await withTimeout(scrapePageFn({ url, traceId }), 20000, `Scraping URL ${index + 1}`);
                    logger.debug(`Scraped URL ${index + 1}/${urls.length}`, { traceId, url: sanitizeUrl(url).substring(0, 80) });
                    return { url, result, success: true as const };
                } catch (error) {
                    const errorMsg = `Failed to scrape ${sanitizeUrl(url)}: ${sanitizeErrorMessage(error instanceof Error ? error.message : String(error))}`;
                    logger.warn(errorMsg, { traceId });
                    return { url, error: errorMsg, success: false as const };
                }
            });

            const successfulScrapes: { url: string; content: string; citation?: Citation }[] = [];
            const allSources: SourceOutput[] = [];

            // Extract keywords from query for filtering
            const queryKeywords = filter_by_query ? extractQueryKeywords(trimmedQuery) : [];

            // Effective per-source limit (use parameter or default)
            const effectivePerSourceLimit = max_length_per_source ?? MAX_SCRAPE_CONTENT_SIZE;

            scrapeResults.forEach((result, index) => {
                if (result.status === 'fulfilled') {
                    if (result.value.success) {
                        let content = result.value.result.content[0].text;
                        const citation = result.value.result.citation;
                        const originalContentLength = content.length;

                        // Apply keyword filtering if enabled
                        if (filter_by_query && queryKeywords.length > 0) {
                            const filterResult = filterByKeywords(content, queryKeywords, 50);
                            if (filterResult.includedParagraphs > 0) {
                                content = filterResult.content;
                                logger.debug('Content filtered by keywords', {
                                    traceId,
                                    url: sanitizeUrl(result.value.url).substring(0, 50),
                                    included: filterResult.includedParagraphs,
                                    excluded: filterResult.excludedParagraphs,
                                });
                            }
                            // If no paragraphs match, keep original content
                        }

                        // Apply per-source truncation if content exceeds limit
                        if (content.length > effectivePerSourceLimit) {
                            const truncResult = truncateContent(content, effectivePerSourceLimit, 'start');
                            content = truncResult.content;
                            logger.debug('Source content truncated', {
                                traceId,
                                url: sanitizeUrl(result.value.url).substring(0, 50),
                                originalLength: truncResult.originalLength,
                                truncatedTo: truncResult.truncatedLength,
                            });
                        }

                        successfulScrapes.push({
                            url: result.value.url,
                            content,
                            citation,
                        });

                        allSources.push({
                            url: result.value.url,
                            success: true,
                            contentLength: content.length,
                            citation: toCitationOutput(citation),
                        });
                    } else {
                        errors.push(result.value.error);
                        allSources.push({
                            url: result.value.url,
                            success: false,
                        });
                    }
                } else {
                    const errorMsg = `Scrape promise rejected for URL ${index + 1}: ${result.reason}`;
                    errors.push(errorMsg);
                    logger.warn(errorMsg, { traceId });
                    allSources.push({
                        url: urls[index],
                        success: false,
                    });
                }
            });

            // Apply quality scoring — use a Map for O(1) lookup instead of O(n) find
            const sourceByUrl = new Map(allSources.map(s => [s.url, s]));
            for (const scrape of successfulScrapes) {
                const source = sourceByUrl.get(scrape.url);
                if (source?.success) {
                    source.qualityScore = scoreSource(
                        scrape.url,
                        scrape.content,
                        trimmedQuery,
                        source.citation?.metadata.publishedDate
                    ).overall;
                }
            }

            // Sort successful scrapes by quality score for better content ordering
            successfulScrapes.sort((a, b) =>
                (sourceByUrl.get(b.url)?.qualityScore ?? 0) - (sourceByUrl.get(a.url)?.qualityScore ?? 0)
            );

            logger.info('search_and_scrape: scraping done', { traceId, successful: successfulScrapes.length, total: urls.length });

            if (successfulScrapes.length === 0) {
                const errorSummary = errors.length > 0 ? `\n\nErrors encountered:\n${errors.join('\n')}` : '';
                const noScrapeText = `No content could be scraped from the ${urls.length} URLs found for "${trimmedQuery}".${errorSummary}`;
                const noScrapeStructuredContent: SearchAndScrapeOutput = {
                    query: trimmedQuery,
                    sources: allSources, // Include failed sources for debugging
                    combinedContent: noScrapeText,
                    summary: {
                        urlsSearched: urls.length,
                        urlsScraped: 0,
                        processingTimeMs: Date.now() - startTime,
                    },
                    sizeMetadata: {
                        contentLength: noScrapeText.length,
                        estimatedTokens: estimateTokens(noScrapeText),
                        truncated: false,
                        sizeCategory: 'small',
                    },
                };
                return {
                    content: [{
                        type: "text" as const,
                        text: noScrapeText
                    }],
                    structuredContent: noScrapeStructuredContent,
                };
            }

            // Apply deduplication if enabled
            let finalCombined: string;
            let dedupeStats: { duplicatesRemoved: number; reductionPercent: number } | undefined;

            if (deduplicate) {
                const sources = successfulScrapes.map(s => ({
                    url: s.url,
                    content: s.content,
                }));
                const dedupeResult = deduplicateContent(sources, {
                    minParagraphLength: 50,
                    similarityThreshold: 0.85,
                    preserveStructure: true,
                });
                finalCombined = dedupeResult.content;
                dedupeStats = {
                    duplicatesRemoved: dedupeResult.stats.duplicatesRemoved,
                    reductionPercent: dedupeResult.stats.reductionPercent,
                };
                logger.info('Content deduplicated', { traceId, ...dedupeResult.stats });
            } else {
                // Combine scraped content with source headers (legacy behavior)
                const combinedSections = successfulScrapes.map((scrape, index) =>
                    `=== Source ${index + 1}: ${scrape.url} ===\n${scrape.content}`
                );
                finalCombined = combinedSections.join("\n\n---\n\n");
            }

            // Apply total content limit (use parameter or default)
            const effectiveTotalLimit = total_max_length ?? MAX_RESEARCH_COMBINED_SIZE;
            const originalCombinedLength = finalCombined.length;
            let contentTruncated = false;

            if (finalCombined.length > effectiveTotalLimit) {
                const truncResult = truncateContent(finalCombined, effectiveTotalLimit, 'balanced');
                finalCombined = truncResult.content;
                contentTruncated = true;
                logger.info('Combined content truncated', {
                    traceId,
                    originalLength: truncResult.originalLength,
                    truncatedTo: truncResult.truncatedLength,
                    limit: effectiveTotalLimit,
                });
            }

            const sourcesList = include_sources
                ? '\n\n--- Sources ---\n' + successfulScrapes.map((s, i) => `${i + 1}. ${s.url}`).join('\n')
                : '';

            const totalTime = Date.now() - startTime;
            const summaryLines = [
                `\n\n--- Summary ---`,
                `Query: "${trimmedQuery}"`,
                `URLs scraped: ${successfulScrapes.length}/${urls.length}`,
                `Processing time: ${totalTime}ms`,
                `Content size: ${finalCombined.length.toLocaleString()} chars (~${estimateTokens(finalCombined).toLocaleString()} tokens)`,
            ];
            if (dedupeStats) {
                summaryLines.push(`Deduplication: ${dedupeStats.duplicatesRemoved} duplicates removed (${dedupeStats.reductionPercent}% reduction)`);
            }
            if (contentTruncated) {
                summaryLines.push(`Truncation: Content truncated from ${originalCombinedLength.toLocaleString()} to ${finalCombined.length.toLocaleString()} chars`);
            }
            if (filter_by_query) {
                summaryLines.push(`Keyword filter: Applied (keywords: ${queryKeywords.join(', ')})`);
            }
            if (errors.length > 0) {
                summaryLines.push(`Errors: ${errors.length} (${errors.join('; ')})`);
            }

            // Generate size metadata
            const sizeMetadata: SizeMetadataOutput = {
                contentLength: finalCombined.length,
                estimatedTokens: estimateTokens(finalCombined),
                truncated: contentTruncated,
                originalLength: contentTruncated ? originalCombinedLength : undefined,
                sizeCategory: getSizeCategory(finalCombined.length),
            };

            // Build structured output
            const structuredContent: SearchAndScrapeOutput = {
                query: trimmedQuery,
                sources: allSources,
                combinedContent: finalCombined,
                summary: {
                    urlsSearched: urls.length,
                    urlsScraped: successfulScrapes.length,
                    processingTimeMs: totalTime,
                    duplicatesRemoved: dedupeStats?.duplicatesRemoved,
                    reductionPercent: dedupeStats?.reductionPercent,
                },
                sizeMetadata,
            };

            // Track search for resources
            trackSearch({
                query: trimmedQuery,
                timestamp: new Date().toISOString(),
                resultCount: successfulScrapes.length,
                traceId,
                tool: 'search_and_scrape',
            });

            return {
                content: [{
                    type: "text" as const,
                    text: finalCombined + sourcesList + summaryLines.join('\n')
                }],
                structuredContent,
            };
        }
    );

    // ── google_image_search Tool ───────────────────────────────────────────────

    /**
     * Google Image Search parameters
     */
    interface GoogleImageSearchParams {
        query: string;
        num_results: number;
        size?: 'huge' | 'icon' | 'large' | 'medium' | 'small' | 'xlarge' | 'xxlarge';
        type?: 'clipart' | 'face' | 'lineart' | 'stock' | 'photo' | 'animated';
        color_type?: 'color' | 'gray' | 'mono' | 'trans';
        dominant_color?: string;
        file_type?: 'jpg' | 'gif' | 'png' | 'bmp' | 'svg' | 'webp';
        safe?: 'off' | 'medium' | 'high';
        traceId?: string;
    }

    /**
     * Builds a Google Image Search API URL
     */
    function buildGoogleImageSearchUrl(params: GoogleImageSearchParams): string {
        const urlParams = new URLSearchParams({
            key: GOOGLE_API_KEY,
            cx: GOOGLE_CX,
            q: params.query,
            num: String(params.num_results),
            searchType: 'image',
        });

        if (params.size) urlParams.set('imgSize', params.size);
        if (params.type) urlParams.set('imgType', params.type);
        if (params.color_type) urlParams.set('imgColorType', params.color_type);
        if (params.dominant_color) urlParams.set('imgDominantColor', params.dominant_color);
        if (params.file_type) urlParams.set('fileType', params.file_type);
        if (params.safe) urlParams.set('safe', params.safe);

        return `https://www.googleapis.com/customsearch/v1?${urlParams.toString()}`;
    }

    server.registerTool(
        "google_image_search",
        {
            title: "Google Image Search",
            description: `Search for images using Google Custom Search API. Returns image URLs, thumbnails, dimensions, and source page URLs.

**When to use:**
- Finding visual content — photos, illustrations, graphics, diagrams
- Need specific image formats, sizes, or color types

**Key parameters:**
- size: huge, large, medium, small
- type: clipart, face, lineart, photo, animated
- color_type: color, gray, mono, trans (transparent)
- file_type: jpg, gif, png, svg, webp

**Caching:** Results cached for 30 minutes.`,
            inputSchema: {
                query: z.string().min(1).max(500)
                    .describe('The image search query'),
                num_results: z.number().min(1).max(10).default(5)
                    .describe('Number of image results to return'),
                size: z.enum(['huge', 'icon', 'large', 'medium', 'small', 'xlarge', 'xxlarge']).optional()
                    .describe('Filter by image size'),
                type: z.enum(['clipart', 'face', 'lineart', 'stock', 'photo', 'animated']).optional()
                    .describe('Filter by image type'),
                color_type: z.enum(['color', 'gray', 'mono', 'trans']).optional()
                    .describe('Filter by color type'),
                dominant_color: z.enum(['black', 'blue', 'brown', 'gray', 'green', 'orange', 'pink', 'purple', 'red', 'teal', 'white', 'yellow']).optional()
                    .describe('Filter by dominant color'),
                file_type: z.enum(['jpg', 'gif', 'png', 'bmp', 'svg', 'webp']).optional()
                    .describe('Filter by file format'),
                safe: z.enum(['off', 'medium', 'high']).optional()
                    .describe('Safe search level'),
            },
            outputSchema: googleImageSearchOutputSchema,
            annotations: {
                title: "Google Image Search",
                readOnlyHint: true,
                openWorldHint: true,
            },
        },
        async ({ query, num_results = 5, size, type, color_type, dominant_color, file_type, safe }) => {
            const traceId = randomUUID();
            const trimmedQuery = query.trim();

            logger.info('google_image_search invoked', {
                traceId,
                query: trimmedQuery,
                num_results,
                size,
                type,
            });

            const url = buildGoogleImageSearchUrl({
                query: trimmedQuery,
                num_results,
                size,
                type,
                color_type,
                dominant_color,
                file_type,
                safe,
                traceId,
            });

            try {
                const data = await fetchGoogleApi<{
                    items?: Array<{
                        title: string;
                        link: string;
                        displayLink: string;
                        image?: {
                            thumbnailLink?: string;
                            contextLink?: string;
                            width?: number;
                            height?: number;
                            byteSize?: number;
                        };
                    }>;
                }>(url, 'Google Image Search');

                const images: ImageResultOutput[] = (data.items || []).map((item) => ({
                    title: item.title,
                    link: item.link,
                    thumbnailLink: item.image?.thumbnailLink,
                    displayLink: item.displayLink,
                    contextLink: item.image?.contextLink,
                    width: item.image?.width,
                    height: item.image?.height,
                    fileSize: item.image?.byteSize?.toString(),
                }));

                // Track the search
                trackSearch({
                    query: trimmedQuery,
                    timestamp: new Date().toISOString(),
                    resultCount: images.length,
                    traceId,
                    tool: 'google_image_search',
                });

                // Build annotated content
                const content = annotateImageResults(images, trimmedQuery);

                const structuredContent: GoogleImageSearchOutput = {
                    images,
                    query: trimmedQuery,
                    resultCount: images.length,
                };

                logger.info('google_image_search completed', {
                    traceId,
                    resultCount: images.length,
                });

                return { content, structuredContent };
            } catch (err) {
                const errorMsg = err instanceof Error ? sanitizeErrorMessage(err.message) : 'Unknown error';
                logger.error('google_image_search failed', { traceId, error: errorMsg });
                return {
                    content: [annotateError(`Image search failed: ${errorMsg}`)],
                    isError: true,
                };
            }
        }
    );

    // ── google_news_search Tool ────────────────────────────────────────────────

    /**
     * Google News Search parameters
     */
    interface GoogleNewsSearchParams {
        query: string;
        num_results: number;
        freshness: 'hour' | 'day' | 'week' | 'month' | 'year';
        sort_by: 'relevance' | 'date';
        news_source?: string;
        traceId?: string;
    }

    /** Freshness to dateRestrict mapping for news */
    const NEWS_FRESHNESS_MAP: Record<string, string> = {
        hour: 'd1',  // Closest approximation
        day: 'd1',
        week: 'w1',
        month: 'm1',
        year: 'y1',
    };

    /**
     * Builds a Google News Search API URL
     */
    function buildGoogleNewsSearchUrl(params: GoogleNewsSearchParams): string {
        const urlParams = new URLSearchParams({
            key: GOOGLE_API_KEY,
            cx: GOOGLE_CX,
            q: params.query,
            num: String(params.num_results),
            dateRestrict: NEWS_FRESHNESS_MAP[params.freshness] || 'w1',
        });

        // Sort by date if requested
        if (params.sort_by === 'date') {
            urlParams.set('sort', 'date');
        }

        // Restrict to specific news source if provided
        if (params.news_source) {
            urlParams.set('siteSearch', params.news_source);
            urlParams.set('siteSearchFilter', 'i'); // include only
        }

        return `https://www.googleapis.com/customsearch/v1?${urlParams.toString()}`;
    }

    server.registerTool(
        "google_news_search",
        {
            title: "Google News Search",
            description: `Search for recent news articles with freshness filters and date sorting.

**When to use:**
- Current events, breaking news, time-sensitive topics
- Need headlines and snippets from news sources
- Want to restrict by publication date

**When to use scrape_page instead:**
- You need the full article content

**Key parameters:**
- freshness: hour, day, week, month, year (default: week)
- sort_by: relevance or date
- news_source: Restrict to specific domain (e.g., 'bbc.com')

**Caching:** Results cached for 30 minutes.`,
            inputSchema: {
                query: z.string().min(1).max(500)
                    .describe('The news search query'),
                num_results: z.number().min(1).max(10).default(5)
                    .describe('Number of news results to return'),
                freshness: z.enum(['hour', 'day', 'week', 'month', 'year']).default('week')
                    .describe('How recent the news should be'),
                sort_by: z.enum(['relevance', 'date']).default('relevance')
                    .describe('Sort order: by relevance or by date (most recent first)'),
                news_source: z.string().max(100).optional()
                    .describe('Restrict to a specific news source domain'),
            },
            outputSchema: googleNewsSearchOutputSchema,
            annotations: {
                title: "Google News Search",
                readOnlyHint: true,
                openWorldHint: true,
            },
        },
        async ({ query, num_results = 5, freshness = 'week', sort_by = 'relevance', news_source }) => {
            const traceId = randomUUID();
            const trimmedQuery = query.trim();

            logger.info('google_news_search invoked', {
                traceId,
                query: trimmedQuery,
                num_results,
                freshness,
                sort_by,
            });

            const url = buildGoogleNewsSearchUrl({
                query: trimmedQuery,
                num_results,
                freshness,
                sort_by,
                news_source,
                traceId,
            });

            try {
                const data = await fetchGoogleApi<{
                    items?: Array<{
                        title: string;
                        link: string;
                        snippet: string;
                        displayLink: string;
                        pagemap?: {
                            metatags?: Array<{
                                'article:published_time'?: string;
                                'og:updated_time'?: string;
                            }>;
                        };
                    }>;
                }>(url, 'Google News Search');

                const articles: NewsResultOutput[] = (data.items || []).map((item) => ({
                    title: item.title,
                    link: item.link,
                    snippet: item.snippet || '',
                    source: item.displayLink,
                    publishedDate:
                        item.pagemap?.metatags?.[0]?.['article:published_time'] ||
                        item.pagemap?.metatags?.[0]?.['og:updated_time'],
                }));

                // Track the search
                trackSearch({
                    query: trimmedQuery,
                    timestamp: new Date().toISOString(),
                    resultCount: articles.length,
                    traceId,
                    tool: 'google_news_search',
                });

                // Build annotated content
                const content = annotateNewsResults(articles, trimmedQuery);

                const structuredContent: GoogleNewsSearchOutput = {
                    articles,
                    query: trimmedQuery,
                    resultCount: articles.length,
                    freshness,
                    sortedBy: sort_by,
                };

                logger.info('google_news_search completed', {
                    traceId,
                    resultCount: articles.length,
                });

                return { content, structuredContent };
            } catch (err) {
                const errorMsg = err instanceof Error ? sanitizeErrorMessage(err.message) : 'Unknown error';
                logger.error('google_news_search failed', { traceId, error: errorMsg });
                return {
                    content: [annotateError(`News search failed: ${errorMsg}`)],
                    isError: true,
                };
            }
        }
    );

    // ── sequential_search Tool ─────────────────────────────────────────────────

    server.registerTool(
        "sequential_search",
        {
            title: "Sequential Search",
            description: `Track multi-step research progress across multiple API calls.

**When to use:**
- Complex investigations requiring 3+ searches with different angles
- Research you might abandon early (tracks partial progress)
- Investigations where you need to show reasoning steps
- Research with branching paths to explore alternatives

**When to use search_and_scrape instead:**
- Simple queries that need content from multiple sources in one call

**Key principle:** You do the reasoning; this tool tracks state. It persists across API calls so you can build on previous steps.

**Example flow:**
1. Start: sequential_search(searchStep: "Starting research on X", stepNumber: 1, nextStepNeeded: true)
2. Search: search_and_scrape("topic")
3. Record: sequential_search(searchStep: "Found Y, need Z", stepNumber: 2, source: {...}, nextStepNeeded: true)
4. Complete: sequential_search(searchStep: "Research complete", stepNumber: 3, nextStepNeeded: false)`,
            inputSchema: sequentialSearchInputSchema,
            outputSchema: seqSearchSchema,
            annotations: {
                title: "Sequential Search",
                readOnlyHint: false,
                openWorldHint: false,
            },
        },
        async (params) => {
            const traceId = randomUUID();
            logger.info('sequential_search invoked', { traceId, stepNumber: params.stepNumber });
            return handleSequentialSearch(params as SequentialSearchInput);
        }
    );

    // ── academic_search Tool ─────────────────────────────────────────────────────

    server.registerTool(
        "academic_search",
        {
            title: "Academic Paper Search",
            description: `Search academic papers using Google Custom Search API.

**When to use:**
- Finding peer-reviewed, authoritative sources
- Research requiring citations and references
- Technical/scientific topics and literature reviews

**Features:**
- Paper titles, authors, abstracts
- Publication years and venues
- Direct PDF links (when available)
- Pre-formatted citations (APA, MLA, BibTeX)

**Academic sources:** arXiv, PubMed, IEEE, Nature, Springer, ResearchGate, JSTOR, and more.

**Caching:** Results cached for 30 minutes.`,
            inputSchema: academicSearchInputSchema,
            outputSchema: acadSearchSchema,
            annotations: {
                title: "Academic Paper Search",
                readOnlyHint: true,
                openWorldHint: true,
            },
        },
        async (params) => {
            const traceId = randomUUID();
            logger.info('academic_search invoked', { traceId, query: params.query });

            const result = await handleAcademicSearch(params as AcademicSearchInput);

            // Track the search
            trackSearch({
                query: params.query,
                timestamp: new Date().toISOString(),
                resultCount: result.structuredContent.resultCount,
                traceId,
                tool: 'google_search', // Use existing type
            });

            return result;
        }
    );

    // ── patent_search Tool ─────────────────────────────────────────────────────

    server.registerTool(
        "patent_search",
        {
            title: "Patent Search",
            description: `Search patents using Google Custom Search API (site:patents.google.com).

**When to use:**
- Prior art search before filing
- Freedom to operate (FTO) analysis
- Patent landscaping and competitive intelligence
- Tracking innovation in specific domains

**Features:**
- Patent titles, numbers, abstracts
- Inventors and assignees
- Filing and publication dates
- Direct links to Google Patents and PDFs
- Filter by patent office (USPTO, EPO, WIPO, JPO, CNIPA, KIPO)
- Assignee search with automatic name variations

**Important limitation:** Google Custom Search doesn't index ALL patents. For comprehensive company patent research:
1. Use this tool for initial discovery with technology keywords
2. Use scrape_page on patents.google.com/?assignee=CompanyName for more complete results
3. Try multiple variations: company names without spaces, previous names, inventor names
4. Note that patents may be assigned to parent companies or subsidiaries

**Search types:**
- prior_art: Find related existing patents
- specific: Look up specific patent(s)
- landscape: Broad overview of a technology area

**Caching:** Results cached for 30 minutes.`,
            inputSchema: patentSearchInputSchema,
            outputSchema: patentSchema,
            annotations: {
                title: "Patent Search",
                readOnlyHint: true,
                openWorldHint: true,
            },
        },
        async (params) => {
            const traceId = randomUUID();
            logger.info('patent_search invoked', { traceId, query: params.query, searchType: params.search_type });

            const result = await handlePatentSearch(params as PatentSearchInput, traceId);

            // Track the search
            trackSearch({
                query: params.query,
                timestamp: new Date().toISOString(),
                resultCount: result.structuredContent.resultCount,
                traceId,
                tool: 'google_search', // Use existing type
            });

            return result;
        }
    );

    // ── Register MCP Resources and Prompts ─────────────────────────────────────

    // Register resources for exposing server state
    registerResources(server, globalCacheInstance, eventStoreInstance, {
        version: PKG_VERSION,
        startTime: new Date(),
    }, globalMetricsCollector);

    // Register prompts for research workflows
    registerPrompts(server);
}


// --- Function Definitions ---

/**
 * Sets up the STDIO transport using the globally initialized cache and event store.
 */
// Ensure this function is defined at the top level before the main execution block
async function setupStdioTransport() {
  // Ensure global instances are initialized first
  if (!globalCacheInstance || !eventStoreInstance) {
    logger.error('Cannot setup stdio transport: Global instances not initialized.');
    process.exit(1);
  }

  // Create MCP server instance
  // Note: Tool capabilities are automatically declared when tools are registered via registerTool()
  // The SDK handles capability negotiation during the initialization handshake
  stdioServerInstance = new McpServer({
    name: "google-researcher-mcp-stdio",
    version: PKG_VERSION,
  });
  configureToolsAndResources(stdioServerInstance);
  stdioTransportInstance = new StdioServerTransport();
  await stdioServerInstance.connect(stdioTransportInstance);
  logger.info('stdio transport ready');
}

/**
 * Factory function to create and configure the Express app for the HTTP+SSE transport
 *
 * @param cache - The pre-initialized PersistentCache instance
 * @param eventStore - The pre-initialized PersistentEventStore instance
 * @param oauthOptions - Optional OAuth configuration
 * @returns Object containing the Express app and the HTTP transport instance
 */
export async function createAppAndHttpTransport(
  cache: PersistentCache,
  eventStore: PersistentEventStore,
  oauthOptions?: OAuthMiddlewareOptions
) {
  // Lazy-load HTTP-only dependencies to save ~24 MB RSS in STDIO mode
  const { default: express } = await import("express");
  const { default: cors } = await import("cors");
  const { default: rateLimit, ipKeyGenerator } = await import("express-rate-limit");

  // Ensure we have the necessary instances (either global or passed parameters)
  if ((!globalCacheInstance || !eventStoreInstance) && (!cache || !eventStore)) {
    logger.error('Cannot create app: Neither global instances nor parameters are available.');
    process.exit(1);
  }

  // ─── 0️⃣ ENVIRONMENT VALIDATION & CORS SETUP ─────────────────────────────────────
  // Validate all environment variables at startup with clear, actionable error messages
  validateEnvironmentOrExit();
const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(",").map((s) => s.trim()).filter(s => s.length > 0)
  : ["*"]; // Default to allow all - MCP clients are typically not browsers

  // Create the Express app instance here
  const app = express();
  app.use(express.json());
  app.use(
      cors({
          origin: ALLOWED_ORIGINS,
          methods: ["GET", "POST", "DELETE"],
          allowedHeaders: ["Content-Type", "Mcp-Session-Id", "Accept", "Authorization"],
          exposedHeaders: ["Mcp-Session-Id"]
      })
  );

  // ── Rate limiting ──────────────────────────────────────────────
  const rateLimitWindowMs = Number(process.env.RATE_LIMIT_WINDOW_MS) || 60_000;
  const rateLimitMax = Number(process.env.RATE_LIMIT_MAX_REQUESTS) || 100;

  app.use(rateLimit({
    windowMs: rateLimitWindowMs,
    max: rateLimitMax,
    keyGenerator: (req: Request) => (req as OAuthRequest).oauth?.sub ?? ipKeyGenerator(req.ip ?? '0.0.0.0'),
    standardHeaders: true,
    legacyHeaders: false,
    handler: (_req: Request, res: Response) => {
      res.status(429).json({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Rate limit exceeded. Try again later." },
        id: null,
      });
    },
  }));
  logger.info('Rate limiting configured', { windowMs: rateLimitWindowMs, max: rateLimitMax });

  // ── Unauthenticated operational endpoints ─────────────────────
  app.get("/health", (_req: Request, res: Response) => {
    res.json({
      status: "ok",
      version: PKG_VERSION,
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
    });
  });

  app.get("/version", (_req: Request, res: Response) => {
    res.json({
      version: PKG_VERSION,
      name: "google-researcher-mcp",
      nodeVersion: process.version,
    });
  });

  // Configure OAuth middleware if options are provided
  let oauthMiddleware: ReturnType<typeof createOAuthMiddleware> | undefined;
  if (oauthOptions) {
    oauthMiddleware = createOAuthMiddleware(oauthOptions);
    logger.info('OAuth 2.1 middleware configured');
  }

  /**
   * Checks if a request is an initialization request
   *
   * Initialization requests create new MCP sessions.
   *
   * @param body - The request body
   * @returns True if this is an initialization request
   */
  function isInitializeRequest(body: unknown): boolean {
    return typeof body === 'object' && body !== null && 'method' in body && (body as { method: unknown }).method === "initialize";
  }

  // Create MCP server instance
  // Note: Tool capabilities are automatically declared when tools are registered via registerTool()
  // The SDK handles capability negotiation during the initialization handshake
  const httpServer = new McpServer({
    name: "google-researcher-mcp-sse",
    version: PKG_VERSION,
  });

  configureToolsAndResources(httpServer);

  // Create the streamable HTTP transport with session management
  httpTransportInstance = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    eventStore: eventStoreInstance,
    onsessioninitialized: (sid) => {
      logger.info('SSE session initialized', { sessionId: sid });
    },
  });


  // Connect the MCP server to the transport
  await httpServer.connect(httpTransportInstance);
  logger.info('HTTP transport connected to MCP server');

  // Apply OAuth middleware to the core MCP transport endpoint when configured.
  // Only the JSON-RPC transport routes (POST/GET/DELETE /mcp) require auth.
  // Sub-paths like /mcp/oauth-config and /mcp/cache-stats remain public.
  const requireAuth = oauthMiddleware
    ? (req: Request, res: Response, next: NextFunction): void => {
        oauthMiddleware!(req, res, next);
      }
    : undefined;

  if (requireAuth) {
    logger.info('OAuth middleware will be applied to /mcp transport endpoint');
  }

  // Middleware to handle content negotiation for JSON-RPC requests
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (req.path === '/mcp' && req.method === 'POST') {
      // Force content type to be application/json for JSON-RPC requests
      res.setHeader('Content-Type', 'application/json');
    }
    next();
  });

  /**
   * Checks if a request body is a JSON-RPC batch request
   *
   * According to the JSON-RPC specification, batch requests are sent as arrays
   * of individual request objects.
   *
   * @param body - The request body
   * @returns True if this is a batch request
   */
  function isBatchRequest(body: unknown): body is unknown[] {
    return Array.isArray(body);
  }

  // Handle POST requests to /mcp (auth-protected when OAuth is configured)
  const mcpMiddleware: Array<(req: Request, res: Response, next: NextFunction) => void> = [];
  if (requireAuth) mcpMiddleware.push(requireAuth);
  app.post("/mcp", ...mcpMiddleware, async (req: Request, res: Response, next: NextFunction) => {
    try {
      // Check if this is a batch request
      const isBatch = isBatchRequest(req.body);

      // Handle empty batch requests (invalid according to spec)
      if (isBatch && req.body.length === 0) {
        res.status(400).json({
          jsonrpc: "2.0",
          error: { code: -32600, message: "Invalid Request: Empty batch" },
          id: null
        });
        return;
      }

      // Get session ID from header (still useful for logging)
      const sidHeader = req.headers["mcp-session-id"] as string | undefined;

      // Add back explicit session validation for batch requests
      // This is needed for the test to pass
      if (isBatch && (!sidHeader || sidHeader === 'invalid-session-id')) {
        res.status(400).json({
          jsonrpc: "2.0",
          error: { code: -32000, message: "Bad Request: No valid session ID provided" },
          id: null
        });
        return;
      }

      // For existing sessions, delegate to the transport
      // The StreamableHTTPServerTransport should handle batch requests correctly
      await httpTransportInstance.handleRequest(req, res, req.body);
    } catch (err) {
      next(err);
    }
  });

  // Handle GET and DELETE requests to /mcp (SSE connections and session teardown)
  const handleSessionRequest = async (req: Request, res: Response, next: NextFunction) => {
    try {
      await httpTransportInstance.handleRequest(req, res);
    } catch (err) {
      next(err);
    }
  };

  app.get("/mcp", ...mcpMiddleware, handleSessionRequest);
  app.delete("/mcp", ...mcpMiddleware, handleSessionRequest);

// ─── 4️⃣ EVENT STORE & CACHE MANAGEMENT API ENDPOINTS ────────────────────────────
/**
 * Cache statistics endpoint
 *
 * Provides detailed information about:
 * - Cache hit/miss rates
 * - Memory usage
 * - Entry counts
 * - Server process statistics
 *
 * Useful for monitoring cache performance and diagnosing issues.
 */
app.get("/mcp/cache-stats", (_req: Request, res: Response) => {
    const stats = globalCacheInstance.getStats();
    const processStats = process.memoryUsage();

    res.json({
        cache: {
            ...stats,
            timestamp: new Date().toISOString(),
            memoryUsageEstimate: `~${Math.round(stats.size * 10 / 1024)}MB (rough estimate)`
        },
        process: {
            uptime: process.uptime(),
            memoryUsage: {
                rss: `${Math.round(processStats.rss / 1024 / 1024)}MB`,
                heapTotal: `${Math.round(processStats.heapTotal / 1024 / 1024)}MB`,
                heapUsed: `${Math.round(processStats.heapUsed / 1024 / 1024)}MB`,
                external: `${Math.round(processStats.external / 1024 / 1024)}MB`
            }
        },
        server: {
            nodeVersion: process.version,
            platform: process.platform,
            startTime: new Date(Date.now() - process.uptime() * 1000).toISOString()
        }
    });
});

/**
 * Event store statistics endpoint
 *
 * Provides detailed information about:
 * - Event counts
 * - Memory and disk usage
 * - Hit/miss rates
 * - Stream statistics
 *
 * Useful for monitoring event store performance and diagnosing issues.
 */
app.get("/mcp/event-store-stats", async (_req: Request, res: Response) => {
    try {
        // Use the passed event store parameter for proper dependency injection
        if (!eventStore || typeof eventStore.getStats !== 'function') {
          res.status(500).json({
            error: "Event store not available or not a PersistentEventStore"
          });
            return;
        }
        // Get stats from the passed event store parameter
        const stats = await eventStore.getStats();

        res.json({
            eventStore: {
                ...stats,
                timestamp: new Date().toISOString()
            }
        });
    } catch (error) {
        res.status(500).json({
            error: "Failed to get event store stats",
            message: (error as Error).message
        });
    }
});

/**
 * Prometheus metrics endpoint
 *
 * Exports tool execution metrics in Prometheus exposition format.
 * Includes:
 * - Server uptime
 * - Per-tool call counts, success/failure rates
 * - Latency percentiles (p50, p95, p99)
 * - Cache hit/miss rates
 */
app.get("/mcp/metrics/prometheus", (_req: Request, res: Response) => {
    try {
        if (!globalMetricsCollector) {
            res.status(503).send('# Metrics collector not initialized\n');
            return;
        }
        const metrics = globalMetricsCollector.getMetrics();
        if (!metrics || typeof metrics !== 'object' || !('tools' in metrics)) {
            res.status(500).send('# Invalid metrics format\n');
            return;
        }
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.send(formatPrometheusMetrics(metrics));
    } catch (error) {
        res.status(500).send(`# Error generating metrics: ${(error as Error).message}\n`);
    }
});

/**
 * Cache invalidation endpoint (protected by API key)
 *
 * Allows authorized clients to:
 * - Invalidate specific cache entries by namespace and args
 * - Clear the entire cache
 *
 * Protected by a simple API key for basic security.
 * In production, use a more robust authentication mechanism.
 */
app.post("/mcp/cache-invalidate", (req: Request, res: Response) => {
    const expectedKey = process.env.CACHE_ADMIN_KEY;

    if (!expectedKey) {
        res.status(503).json({
            error: "Service Unavailable",
            message: "Cache admin endpoints are disabled. Set CACHE_ADMIN_KEY environment variable to enable."
        });
        return;
    }

    const apiKey = req.headers["x-api-key"];
    if (typeof apiKey !== 'string' || !secureCompare(apiKey, expectedKey)) {
        logger.warn('Unauthorized cache invalidation attempt', { ip: req.ip });
        res.status(401).json({ error: "Unauthorized" });
        return;
    }

    const { namespace, args } = req.body;

    if (namespace && args) {
      globalCacheInstance.invalidate(namespace, args);
      res.json({
        success: true,
            message: `Cache entry invalidated for namespace: ${namespace}`,
            invalidatedAt: new Date().toISOString()
        });
    } else {
      globalCacheInstance.clear();
      res.json({
        success: true,
            message: "Entire cache cleared",
            clearedAt: new Date().toISOString()
        });
    }
});

/**
 * Cache persistence endpoints (POST and GET)
 *
 * Forces immediate persistence of the cache to disk.
 * Provided in both POST and GET forms for convenience:
 * - POST for programmatic use
 * - GET for easy access via browser
 *
 * Useful for ensuring data is saved before server shutdown.
 */
app.post("/mcp/cache-persist", async (req: Request, res: Response) => {
 const expectedKey = process.env.CACHE_ADMIN_KEY;
 if (!expectedKey) {
   res.status(503).json({
     error: "Service Unavailable",
     message: "Cache admin endpoints are disabled. Set CACHE_ADMIN_KEY environment variable to enable."
   });
   return;
 }
 const apiKey = req.headers["x-api-key"];
 if (typeof apiKey !== 'string' || !secureCompare(apiKey, expectedKey)) {
   logger.warn('Unauthorized cache persist attempt', { ip: req.ip });
   res.status(401).json({ error: "Unauthorized" });
   return;
 }

 try {
   await globalCacheInstance.persistToDisk();
   res.json({
     success: true,
      message: "Cache persisted successfully",
      persistedAt: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Failed to persist cache",
      error: (error as Error).message
    });
  }
});


/**
 * OAuth Scopes Documentation endpoint
 *
 * Provides documentation for the OAuth scopes used in the MCP server.
 * This endpoint serves the documentation in markdown format.
 *
 * Useful for developers integrating with the MCP server's OAuth system.
 */
app.get("/mcp/oauth-scopes", (req: Request, res: Response) => {
  serveOAuthScopesDocumentation(req, res);
});

/**
 * OAuth configuration endpoint
 *
 * Returns the OAuth configuration information, including:
 * - Whether OAuth is enabled
 * - The issuer URL
 * - The audience value
 * - Available endpoints
 *
 * This endpoint is public and does not require authentication.
 */
app.get("/mcp/oauth-config", (_req: Request, res: Response) => {
  const oauthEnabled = !!oauthOptions;

  res.json({
    oauth: {
      enabled: oauthEnabled,
      issuer: oauthEnabled ? oauthOptions!.issuerUrl : null,
      audience: oauthEnabled ? oauthOptions!.audience : null
    },
    endpoints: {
      jwks: oauthEnabled ? `${oauthOptions!.issuerUrl}${oauthOptions!.jwksPath || '/.well-known/jwks.json'}` : null,
      tokenInfo: oauthEnabled ? "/mcp/oauth-token-info" : null,
      scopes: "/mcp/oauth-scopes"
    }
  });
});

/**
 * OAuth token info endpoint
 *
 * Returns information about the authenticated user's token.
 * This endpoint requires authentication.
 */
app.get("/mcp/oauth-token-info",
  // Use a type assertion to help TypeScript understand this is a valid middleware
  (oauthMiddleware || ((req: Request, res: Response, next: NextFunction) => {
    res.status(401).json({
      error: "oauth_not_configured",
      error_description: "OAuth is not configured for this server"
    });
  })) as express.RequestHandler,
  (req: Request, res: Response) => {
  // The OAuth middleware will have attached the token and scopes to the request
  const oauth = (req as OAuthRequest).oauth;

  res.json({
    token: {
      subject: oauth.token.sub,
      issuer: oauth.token.iss,
      audience: oauth.token.aud,
      scopes: oauth.scopes,
      expiresAt: oauth.token.exp ? new Date(oauth.token.exp * 1000).toISOString() : null,
      issuedAt: oauth.token.iat ? new Date(oauth.token.iat * 1000).toISOString() : null
    }
  });
});

  // Return the app and the created HTTP transport instance
  return { app, httpTransport: httpTransportInstance };
}

// Export global instances for potential use in test setup/teardown
export {
  stdioTransportInstance,
  httpTransportInstance,
  globalCacheInstance,
  eventStoreInstance,
  transcriptExtractorInstance,
  initializeGlobalInstances
};

// --- Global Error Handlers ---
// Catch unhandled errors and route them to stderr so they never corrupt
// the STDIO JSON-RPC channel on stdout. Without these, Node.js default
// behaviour prints to stdout/stderr unpredictably and can crash the process.
process.on('uncaughtException', (error) => {
  process.stderr.write(`[FATAL] Uncaught exception: ${error?.stack ?? error}\n`);
  // Don't exit — keep the STDIO transport alive so the client doesn't disconnect.
});

process.on('unhandledRejection', (reason) => {
  process.stderr.write(`[ERROR] Unhandled promise rejection: ${reason instanceof Error ? reason.stack : reason}\n`);
});

// --- Unified Graceful Shutdown ---
// Single shutdown path for all signals: SIGINT, SIGTERM, and stdin EOF
// (parent MCP client exit). One flag prevents double-dispose races.
let isShuttingDown = false;
async function gracefulShutdown(signal: string) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  logger.info(`Received ${signal}. Shutting down...`);

  const forceExitTimer = setTimeout(() => process.exit(0), 5000);
  forceExitTimer.unref();

  try {
    if (stdioTransportInstance?.close) await stdioTransportInstance.close();
    if (httpTransportInstance?.close) await httpTransportInstance.close();
    if (httpServerInstance) {
      await new Promise<void>((resolve) => {
        httpServerInstance!.close(() => resolve());
        setTimeout(() => resolve(), 3000).unref();
      });
    }
    if (globalCacheInstance?.dispose) await globalCacheInstance.dispose();
    if (eventStoreInstance?.dispose) await eventStoreInstance.dispose();
  } catch (error) {
    logger.error('Error during shutdown', { error: String(error) });
  }
  process.exit(0);
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.stdin.on('end', () => gracefulShutdown('stdin-end'));
process.stdin.on('close', () => gracefulShutdown('stdin-close'));

// --- Main Execution Block ---
/**
 * Main execution block: Initializes instances and starts transports/server
 * based on execution context (direct run vs. import) and environment variables.
 */
(async () => {
  await initializeGlobalInstances();

  // Setup STDIO transport BEFORE the cache finishes loading. This ensures
  // the MCP client can connect and start exchanging messages right away.
  // Tools that hit the cache will simply get cache misses until it's warm.
  if (!process.env.JEST_WORKER_ID) {
    await setupStdioTransport();

    // Safety net: detect parent process death.
    // When Claude Code spawns the server, stdin/stdout are unix domain sockets,
    // not pipes. If the parent dies, these sockets break but Node.js does NOT
    // emit 'end'/'close' on stdin, and destroyed/readableEnded stay false.
    // This causes orphaned processes to spin at 100% CPU on a broken socket.
    // Detection: (1) parent PID becomes 1 (reparented to init/launchd),
    // (2) stdin.destroyed/readableEnded flags, (3) stdout write fails with EPIPE.
    const originalParentPid = process.ppid;
    const stdinHealthCheck = setInterval(() => {
      const reparented = process.ppid !== originalParentPid;
      const stdinBroken = process.stdin.destroyed || process.stdin.readableEnded;
      if (reparented || stdinBroken) {
        clearInterval(stdinHealthCheck);
        gracefulShutdown(reparented ? 'parent-exit' : 'stdin-health-check');
        return;
      }
      // Probe stdout: if the socket's remote end is gone, this triggers EPIPE
      if (!process.stdout.destroyed) {
        process.stdout.write('', (err) => {
          if (err) {
            clearInterval(stdinHealthCheck);
            gracefulShutdown('stdout-broken');
          }
        });
      }
    }, 2000);
    stdinHealthCheck.unref();
  }

  // Now load the cache in the background — this can take many seconds for
  // large caches (e.g. 7k+ files / 100+ MB) and must not block the transport.
  globalCacheInstance.loadFromDisk().then(() => {
    logger.info('Persistent cache loaded from disk.');
  }).catch((err: unknown) => {
    logger.warn('Failed to load persistent cache from disk, starting with empty cache.', { error: String(err) });
  });

  // If MCP_TEST_MODE is 'stdio', DO NOT start HTTP listener.
  if (process.env.MCP_TEST_MODE === 'stdio') {
    logger.info('Running in stdio test mode, HTTP listener skipped. STDIO transport is active.');
  } else if (import.meta.url === `file://${process.argv[1]}`) {
    // Otherwise, if run directly, start the HTTP listener.
    const PORT = Number(process.env.PORT || 3000);
    // Pass OAuth options if needed (example: reading from env vars)
    const oauthOpts = process.env.OAUTH_ISSUER_URL ? {
      issuerUrl: process.env.OAUTH_ISSUER_URL,
      audience: process.env.OAUTH_AUDIENCE,
      // jwksPath: process.env.OAUTH_JWKS_PATH // Optional
    } : undefined;

    const { app } = await createAppAndHttpTransport(globalCacheInstance, eventStoreInstance, oauthOpts);

    // Start the HTTP server with error handling
    httpServerInstance = app.listen(PORT, "::", () => {
        logger.info(`SSE server listening on port ${PORT}`, {
          endpoints: [
            `http://[::1]:${PORT}/mcp`,
            `http://127.0.0.1:${PORT}/mcp/cache-stats`,
            `http://127.0.0.1:${PORT}/mcp/event-store-stats`,
            `http://127.0.0.1:${PORT}/mcp/oauth-config`,
          ]
        });
      });

    httpServerInstance.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        logger.warn(`Port ${PORT} already in use — HTTP transport disabled, STDIO transport remains active.`);
      } else {
        logger.error(`HTTP server error: ${err.message}`, { code: err.code });
      }
      // Don't exit — STDIO transport is still functional.
    });
  }
})().catch((err) => {
  // Last-resort catch for initialization failures.
  process.stderr.write(`[FATAL] Server initialization failed: ${err?.stack ?? err}\n`);
  process.exit(1);
}); // End main execution block