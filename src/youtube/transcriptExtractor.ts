/**
 * Robust YouTube Transcript Extraction System
 * 
 * This module implements a comprehensive error handling and retry system
 * for YouTube transcript extraction, addressing the silent failure pattern
 * in the original implementation.
 */

// The youtube-transcript package lacks "type": "module" in its package.json,
// so Node < 24 loads the ESM entry as CJS and fails. Use createRequire to
// load the CJS build directly, which works on all Node versions.
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { YoutubeTranscript } = require("@danielxceron/youtube-transcript");

import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const execFile = promisify(execFileCb);

// Interface for transcript fetcher to allow dependency injection
export interface TranscriptFetcher {
  fetchTranscript(videoId: string): Promise<Array<{ text: string }>>;
}

// Default implementation using the working YoutubeTranscript fork
export const defaultTranscriptFetcher: TranscriptFetcher = {
  fetchTranscript: async (videoId: string) => {
    // Use the fork's fetchTranscript method directly
    return await YoutubeTranscript.fetchTranscript(videoId);
  }
};

// Interface for yt-dlp fallback to allow dependency injection in tests
export interface YtDlpFallback {
  isAvailable(): Promise<boolean>;
  extractTranscript(videoId: string): Promise<string>;
}

/**
 * Default yt-dlp fallback implementation.
 * Uses the yt-dlp CLI to download auto-generated subtitles in JSON3 format,
 * then parses them into plain text. This works around YouTube API changes
 * (e.g. the exp=xpe experiment) that break library-based extraction.
 */
export class DefaultYtDlpFallback implements YtDlpFallback {
  private available: boolean | null = null;

  async isAvailable(): Promise<boolean> {
    if (this.available !== null) return this.available;
    try {
      await execFile('yt-dlp', ['--version'], { timeout: 5000 });
      this.available = true;
    } catch {
      this.available = false;
    }
    return this.available;
  }

  async extractTranscript(videoId: string): Promise<string> {
    const tmpDir = await mkdtemp(join(tmpdir(), 'yt-transcript-'));
    const outTemplate = join(tmpDir, 'sub');

    try {
      await execFile('yt-dlp', [
        '--write-auto-sub',
        '--sub-lang', 'en',
        '--sub-format', 'json3',
        '--skip-download',
        '--no-warnings',
        '--no-check-certificates',
        '-o', outTemplate,
        `https://www.youtube.com/watch?v=${videoId}`,
      ], { timeout: 30000 });

      // yt-dlp writes to <outTemplate>.en.json3
      const filePath = `${outTemplate}.en.json3`;
      const raw = await readFile(filePath, 'utf-8');
      const data = JSON.parse(raw);

      const events: Array<{ segs?: Array<{ utf8?: string }> }> = data.events || [];
      const text = events
        .filter(e => e.segs)
        .map(e => (e.segs ?? []).map(s => s.utf8 ?? '').join(''))
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();

      if (!text) {
        throw new Error('yt-dlp returned empty transcript content');
      }

      return text;
    } finally {
      await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

/**
 * YouTube transcript error types for classification
 */
export enum YouTubeTranscriptErrorType {
  TRANSCRIPT_DISABLED = 'transcript_disabled',
  VIDEO_UNAVAILABLE = 'video_unavailable',
  VIDEO_NOT_FOUND = 'video_not_found',
  NETWORK_ERROR = 'network_error',
  RATE_LIMITED = 'rate_limited',
  TIMEOUT = 'timeout',
  PARSING_ERROR = 'parsing_error',
  REGION_BLOCKED = 'region_blocked',
  PRIVATE_VIDEO = 'private_video',
  LIBRARY_ERROR = 'library_error',
  UNKNOWN = 'unknown'
}

/**
 * Retry configuration interface
 */
export interface RetryConfig {
  maxAttempts: number;
  baseDelay: number;
  maxDelay: number;
  exponentialBase: number;
  retryableErrors: YouTubeTranscriptErrorType[];
  jitterFactor: number;
}

/**
 * Default retry configuration
 */
export const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxAttempts: 3,
  baseDelay: 1000,      // 1 second
  maxDelay: 30000,      // 30 seconds
  exponentialBase: 2,
  retryableErrors: [
    YouTubeTranscriptErrorType.NETWORK_ERROR,
    YouTubeTranscriptErrorType.TIMEOUT,
    YouTubeTranscriptErrorType.RATE_LIMITED,
    YouTubeTranscriptErrorType.LIBRARY_ERROR,
    YouTubeTranscriptErrorType.UNKNOWN
  ],
  jitterFactor: 0.1
};

/**
 * Transcript extraction result interface
 */
export interface TranscriptResult {
  success: boolean;
  transcript?: string;
  videoId: string;
  attempts: number;
  duration: number;
  error?: {
    type: YouTubeTranscriptErrorType;
    message: string;
    originalError: string;
    videoId: string;
    attempts: number;
    duration: number;
  };
}

/**
 * Logger interface for structured logging
 */
export interface Logger {
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

/**
 * Simple console logger implementation
 */
export class ConsoleLogger implements Logger {
  /**
   * Write to stderr only — stdout is the STDIO JSON-RPC channel and
   * any stray output there corrupts the protocol and disconnects clients.
   */
  private write(line: string): void {
    process.stderr.write(line + '\n');
  }

  debug(message: string, meta?: Record<string, unknown>): void {
    if (process.env.YOUTUBE_TRANSCRIPT_DEBUG === 'true') {
      this.write(`[YouTube Transcript Debug] ${message} ${meta ? JSON.stringify(meta) : ''}`);
    }
  }

  info(message: string, meta?: Record<string, unknown>): void {
    if (process.env.YOUTUBE_TRANSCRIPT_VERBOSE === 'true') {
      this.write(`[YouTube Transcript Info] ${message} ${meta ? JSON.stringify(meta) : ''}`);
    }
  }

  warn(message: string, meta?: Record<string, unknown>): void {
    if (process.env.NODE_ENV !== 'production' && process.env.NODE_ENV !== 'test') {
      this.write(`[YouTube Transcript Warning] ${message} ${meta ? JSON.stringify(meta) : ''}`);
    }
  }

  error(message: string, meta?: Record<string, unknown>): void {
    if (process.env.NODE_ENV !== 'test') {
      this.write(`[YouTube Transcript Error] ${message} ${meta ? JSON.stringify(meta) : ''}`);
    }
  }
}

/**
 * Metrics collector interface
 */
export interface MetricsCollector {
  recordSuccess(videoId: string, attempts: number, duration: number): void;
  recordFailure(videoId: string, attempts: number, errorType: YouTubeTranscriptErrorType, duration: number): void;
}

/**
 * Simple metrics collector implementation
 */
export class SimpleMetricsCollector implements MetricsCollector {
  private stats = {
    totalRequests: 0,
    successful: 0,
    failed: 0,
    errorBreakdown: {} as Record<YouTubeTranscriptErrorType, number>,
    averageDuration: 0,
    totalDuration: 0
  };

  recordSuccess(videoId: string, attempts: number, duration: number): void {
    this.stats.totalRequests++;
    this.stats.successful++;
    this.stats.totalDuration += duration;
    this.stats.averageDuration = this.stats.totalDuration / this.stats.totalRequests;
  }

  recordFailure(videoId: string, attempts: number, errorType: YouTubeTranscriptErrorType, duration: number): void {
    this.stats.totalRequests++;
    this.stats.failed++;
    this.stats.totalDuration += duration;
    this.stats.averageDuration = this.stats.totalDuration / this.stats.totalRequests;
    this.stats.errorBreakdown[errorType] = (this.stats.errorBreakdown[errorType] || 0) + 1;
  }

  getStats() {
    return { ...this.stats };
  }
}

/**
 * YouTube transcript error handler
 */
export class YouTubeTranscriptErrorHandler {
  constructor(
    private retryConfig: RetryConfig = DEFAULT_RETRY_CONFIG,
    private logger: Logger = new ConsoleLogger()
  ) {}

  /**
   * Classifies an error based on its message and properties
   */
  classifyError(error: Error, videoId: string): YouTubeTranscriptErrorType {
    const message = error.message.toLowerCase();

    // Check for specific error patterns
    if (message.includes('transcript') && (message.includes('disabled') || message.includes('not available'))) {
      return YouTubeTranscriptErrorType.TRANSCRIPT_DISABLED;
    }

    if (message.includes('video unavailable') || message.includes('unavailable')) {
      return YouTubeTranscriptErrorType.VIDEO_UNAVAILABLE;
    }

    if (message.includes('video not found') || message.includes('not found') || message.includes('404')) {
      return YouTubeTranscriptErrorType.VIDEO_NOT_FOUND;
    }

    if (message.includes('private') || message.includes('access denied')) {
      return YouTubeTranscriptErrorType.PRIVATE_VIDEO;
    }

    if (message.includes('region') && message.includes('block')) {
      return YouTubeTranscriptErrorType.REGION_BLOCKED;
    }

    if (message.includes('rate limit') || message.includes('too many requests') || message.includes('429')) {
      return YouTubeTranscriptErrorType.RATE_LIMITED;
    }

    if (message.includes('timeout') || message.includes('timed out')) {
      return YouTubeTranscriptErrorType.TIMEOUT;
    }

    if (message.includes('network') || message.includes('connection') || message.includes('fetch')) {
      return YouTubeTranscriptErrorType.NETWORK_ERROR;
    }

    if (message.includes('parse') || message.includes('json') || message.includes('xml')) {
      return YouTubeTranscriptErrorType.PARSING_ERROR;
    }

    // Check for library/internal JavaScript errors
    if (message.includes('is not a function') ||
        message.includes('cannot read property') ||
        message.includes('cannot read properties') ||
        message.includes('undefined is not a function') ||
        message.includes('null is not a function') ||
        message.includes('typeerror') ||
        message.includes('library returned null/undefined') ||
        message.includes('library compatibility issue')) {
      return YouTubeTranscriptErrorType.LIBRARY_ERROR;
    }

    // Check for specific transcript unavailable cases
    if (message.includes('no transcript available') ||
        message.includes('transcript may be disabled') ||
        message.includes('not generated')) {
      return YouTubeTranscriptErrorType.TRANSCRIPT_DISABLED;
    }

    // Default to unknown for unclassified errors
    return YouTubeTranscriptErrorType.UNKNOWN;
  }

  /**
   * Determines if an error should be retried
   */
  shouldRetry(errorType: YouTubeTranscriptErrorType, attempt: number): boolean {
    if (attempt >= this.retryConfig.maxAttempts) {
      return false;
    }

    return this.retryConfig.retryableErrors.includes(errorType);
  }

  /**
   * Calculates retry delay with exponential backoff and jitter
   */
  getRetryDelay(attempt: number, errorType: YouTubeTranscriptErrorType): number {
    const exponentialDelay = this.retryConfig.baseDelay * 
      Math.pow(this.retryConfig.exponentialBase, attempt - 1);

    // Add jitter to prevent thundering herd
    const jitter = exponentialDelay * this.retryConfig.jitterFactor * Math.random();
    const delay = Math.min(exponentialDelay + jitter, this.retryConfig.maxDelay);

    // Special handling for rate limiting - longer delays
    if (errorType === YouTubeTranscriptErrorType.RATE_LIMITED) {
      return Math.min(delay * 2, this.retryConfig.maxDelay);
    }

    return delay;
  }

  /**
   * Formats user-friendly error messages
   */
  formatUserError(errorType: YouTubeTranscriptErrorType, videoId: string, originalError: Error): string {
    const errorMessages: Record<YouTubeTranscriptErrorType, (videoId: string) => string> = {
      [YouTubeTranscriptErrorType.TRANSCRIPT_DISABLED]: (videoId) =>
        `Transcript is not available for this YouTube video (${videoId}). This could be because: 1) The video owner has disabled automatic captions, 2) No manual transcript was provided, or 3) The transcript extraction library needs updating due to YouTube API changes.`,
        
      [YouTubeTranscriptErrorType.VIDEO_UNAVAILABLE]: (videoId) =>
        `The YouTube video (${videoId}) is unavailable. It may be private, deleted, or restricted in your region.`,
        
      [YouTubeTranscriptErrorType.VIDEO_NOT_FOUND]: (videoId) =>
        `YouTube video not found (${videoId}). Please verify the video ID is correct and the video exists.`,

      [YouTubeTranscriptErrorType.PRIVATE_VIDEO]: (videoId) =>
        `The YouTube video (${videoId}) is private and transcripts cannot be accessed.`,

      [YouTubeTranscriptErrorType.REGION_BLOCKED]: (videoId) =>
        `The YouTube video (${videoId}) is blocked in your region and transcripts cannot be accessed.`,
        
      [YouTubeTranscriptErrorType.NETWORK_ERROR]: (videoId) =>
        `Network error occurred while fetching transcript for video ${videoId}. Please check your internet connection and try again.`,
        
      [YouTubeTranscriptErrorType.RATE_LIMITED]: (videoId) =>
        `Rate limit exceeded while fetching transcript for video ${videoId}. Please wait a few minutes before trying again.`,
        
      [YouTubeTranscriptErrorType.TIMEOUT]: (videoId) =>
        `Timeout occurred while fetching transcript for video ${videoId}. The video may be very long or the service may be slow.`,
        
      [YouTubeTranscriptErrorType.PARSING_ERROR]: (videoId) =>
        `Error parsing transcript data for video ${videoId}. The transcript format may be unsupported.`,
        
      [YouTubeTranscriptErrorType.LIBRARY_ERROR]: (videoId) =>
        `Internal library error occurred while fetching transcript for video ${videoId}. This may be due to a compatibility issue or library bug. Please try again or contact support.`,
        
      [YouTubeTranscriptErrorType.UNKNOWN]: (videoId) =>
        `An unexpected error occurred while fetching transcript for video ${videoId}. Please try again or contact support if the issue persists.`
    };

    return errorMessages[errorType](videoId);
  }
}

/**
 * Custom error class for YouTube transcript errors
 */
export class YouTubeTranscriptError extends Error {
  constructor(
    public readonly type: YouTubeTranscriptErrorType,
    message: string,
    public readonly videoId: string,
    public readonly originalError: string
  ) {
    super(message);
    this.name = 'YouTubeTranscriptError';
  }
}

/**
 * Robust YouTube transcript extractor with comprehensive error handling and retry logic
 */
export class RobustYouTubeTranscriptExtractor {
  private errorHandler: YouTubeTranscriptErrorHandler;
  private metrics: MetricsCollector;
  private transcriptFetcher: TranscriptFetcher;
  private ytDlpFallback: YtDlpFallback;

  constructor(
    private retryConfig: RetryConfig = DEFAULT_RETRY_CONFIG,
    private logger: Logger = new ConsoleLogger(),
    metrics?: MetricsCollector,
    transcriptFetcher?: TranscriptFetcher,
    ytDlpFallback?: YtDlpFallback
  ) {
    this.errorHandler = new YouTubeTranscriptErrorHandler(retryConfig, logger);
    this.metrics = metrics || new SimpleMetricsCollector();
    this.transcriptFetcher = transcriptFetcher || defaultTranscriptFetcher;
    this.ytDlpFallback = ytDlpFallback || new DefaultYtDlpFallback();
  }

  /**
   * Extracts transcript for a YouTube video with comprehensive error handling
   */
  async extractTranscript(videoId: string): Promise<TranscriptResult> {
    const startTime = Date.now();
    let lastError: Error | null = null;
    let actualAttempts = 0;

    this.logger.debug(`Starting transcript extraction for video ${videoId}`);

    for (let attempt = 1; attempt <= this.retryConfig.maxAttempts; attempt++) {
      actualAttempts = attempt;
      
      try {
        this.logger.debug(`Extracting transcript for video ${videoId}, attempt ${attempt}`);

        const transcript = await this.attemptTranscriptExtraction(videoId);

        const duration = Date.now() - startTime;
        this.metrics.recordSuccess(videoId, attempt, duration);
        
        this.logger.info(`Successfully extracted transcript for video ${videoId}`, {
          attempts: attempt,
          duration,
          transcriptLength: transcript.length
        });

        return {
          success: true,
          transcript,
          videoId,
          attempts: attempt,
          duration
        };

      } catch (error) {
        lastError = error as Error;
        const errorType = this.errorHandler.classifyError(lastError, videoId);

        this.logger.warn(`Transcript extraction failed for video ${videoId}`, {
          attempt,
          errorType,
          error: lastError.message
        });

        // Check if we should retry this error type
        if (!this.errorHandler.shouldRetry(errorType, attempt)) {
          // Don't retry permanent errors
          break;
        }

        // Check if we've reached max attempts
        if (attempt >= this.retryConfig.maxAttempts) {
          // No more attempts left
          break;
        }

        const delay = this.errorHandler.getRetryDelay(attempt, errorType);
        this.logger.debug(`Retrying after ${delay}ms delay`);
        await this.sleep(delay);
      }
    }

    // All library attempts failed — try yt-dlp fallback
    const libraryErrorType = this.errorHandler.classifyError(lastError!, videoId);

    this.logger.info(`Library extraction failed for video ${videoId}, attempting yt-dlp fallback`, {
      libraryError: libraryErrorType,
      libraryAttempts: actualAttempts
    });

    try {
      if (await this.ytDlpFallback.isAvailable()) {
        const transcript = await this.ytDlpFallback.extractTranscript(videoId);

        const duration = Date.now() - startTime;
        this.metrics.recordSuccess(videoId, actualAttempts + 1, duration);

        this.logger.info(`yt-dlp fallback succeeded for video ${videoId}`, {
          duration,
          transcriptLength: transcript.length
        });

        return {
          success: true,
          transcript,
          videoId,
          attempts: actualAttempts + 1,
          duration
        };
      } else {
        this.logger.warn('yt-dlp not available on system, skipping fallback');
      }
    } catch (ytDlpError) {
      this.logger.warn(`yt-dlp fallback also failed for video ${videoId}`, {
        error: (ytDlpError as Error).message
      });
    }

    // Both library and yt-dlp failed
    const userMessage = this.errorHandler.formatUserError(libraryErrorType, videoId, lastError!);
    const duration = Date.now() - startTime;

    this.metrics.recordFailure(videoId, actualAttempts, libraryErrorType, duration);

    this.logger.error(`Failed to extract transcript for video ${videoId} after ${actualAttempts} library attempts and yt-dlp fallback`, {
      errorType: libraryErrorType,
      duration,
      originalError: lastError!.message
    });

    return {
      success: false,
      videoId,
      attempts: actualAttempts,
      duration,
      error: {
        type: libraryErrorType,
        message: userMessage,
        originalError: lastError!.message,
        videoId,
        attempts: actualAttempts,
        duration
      }
    };
  }

  /**
   * Attempts to extract transcript from YouTube
   */
  private async attemptTranscriptExtraction(videoId: string): Promise<string> {
    const segments = await this.transcriptFetcher.fetchTranscript(videoId);
    
    // Check if segments is null, undefined, or empty array
    if (!segments || segments.length === 0) {
      // Distinguish between library failure and no transcript available
      // If the library returns an empty array, it could mean:
      // 1. The video has no transcript available
      // 2. The library is broken/outdated
      // 3. YouTube has changed their API
      
      // Log the issue for debugging
      this.logger.warn(`Transcript extraction returned empty result for video ${videoId}`, {
        segmentsType: typeof segments,
        segmentsLength: segments ? segments.length : 'null/undefined',
        isArray: Array.isArray(segments)
      });
      
      // Throw a more specific error to help with classification
      if (segments === null || segments === undefined) {
        throw new Error('Library returned null/undefined - possible library compatibility issue');
      } else if (Array.isArray(segments) && segments.length === 0) {
        throw new Error('No transcript available for this video - transcript may be disabled or not generated');
      } else {
        throw new Error('Unexpected transcript response format');
      }
    }

    return segments.map((segment) => segment.text).join(' ');
  }

  /**
   * Sleep utility for retry delays
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Get metrics from the collector
   */
  getMetrics() {
    if (this.metrics instanceof SimpleMetricsCollector) {
      return this.metrics.getStats();
    }
    return null;
  }
}