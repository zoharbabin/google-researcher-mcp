import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import {
  RobustYouTubeTranscriptExtractor,
  YouTubeTranscriptErrorHandler,
  YouTubeTranscriptError,
  YouTubeTranscriptErrorType,
  DEFAULT_RETRY_CONFIG,
  ConsoleLogger,
  SimpleMetricsCollector,
  type RetryConfig,
  type Logger,
  type MetricsCollector,
  type TranscriptFetcher,
  type YtDlpFallback
} from './transcriptExtractor.js';

// Create a mock transcript fetcher using dependency injection
const mockFetchTranscript = jest.fn() as jest.MockedFunction<(videoId: string) => Promise<any>>;
const mockTranscriptFetcher: TranscriptFetcher = {
  fetchTranscript: mockFetchTranscript
};

// Disabled yt-dlp fallback for unit tests (so real yt-dlp on the system doesn't interfere)
const disabledYtDlpFallback: YtDlpFallback = {
  isAvailable: async () => false,
  extractTranscript: async () => { throw new Error('yt-dlp not available'); }
};

describe('YouTubeTranscriptErrorHandler', () => {
  let errorHandler: YouTubeTranscriptErrorHandler;
  let mockLogger: jest.Mocked<Logger>;

  beforeEach(() => {
    mockLogger = {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    };
    errorHandler = new YouTubeTranscriptErrorHandler(DEFAULT_RETRY_CONFIG, mockLogger);
  });

  describe('classifyError', () => {
    const testVideoId = 'test123';

    it('should classify transcript disabled errors', () => {
      const error = new Error('Transcript is disabled for this video');
      const result = errorHandler.classifyError(error, testVideoId);
      expect(result).toBe(YouTubeTranscriptErrorType.TRANSCRIPT_DISABLED);
    });

    it('should classify video unavailable errors', () => {
      const error = new Error('Video unavailable');
      const result = errorHandler.classifyError(error, testVideoId);
      expect(result).toBe(YouTubeTranscriptErrorType.VIDEO_UNAVAILABLE);
    });

    it('should classify video not found errors', () => {
      const error = new Error('Video not found - 404');
      const result = errorHandler.classifyError(error, testVideoId);
      expect(result).toBe(YouTubeTranscriptErrorType.VIDEO_NOT_FOUND);
    });

    it('should classify private video errors', () => {
      const error = new Error('Access denied - private video');
      const result = errorHandler.classifyError(error, testVideoId);
      expect(result).toBe(YouTubeTranscriptErrorType.PRIVATE_VIDEO);
    });

    it('should classify rate limit errors', () => {
      const error = new Error('Rate limit exceeded - too many requests');
      const result = errorHandler.classifyError(error, testVideoId);
      expect(result).toBe(YouTubeTranscriptErrorType.RATE_LIMITED);
    });

    it('should classify timeout errors', () => {
      const error = new Error('Request timed out');
      const result = errorHandler.classifyError(error, testVideoId);
      expect(result).toBe(YouTubeTranscriptErrorType.TIMEOUT);
    });

    it('should classify network errors', () => {
      const error = new Error('Network connection failed');
      const result = errorHandler.classifyError(error, testVideoId);
      expect(result).toBe(YouTubeTranscriptErrorType.NETWORK_ERROR);
    });

    it('should classify parsing errors', () => {
      const error = new Error('Failed to parse JSON response');
      const result = errorHandler.classifyError(error, testVideoId);
      expect(result).toBe(YouTubeTranscriptErrorType.PARSING_ERROR);
    });

    it('should classify region blocked errors', () => {
      const error = new Error('This video is region blocked');
      const result = errorHandler.classifyError(error, testVideoId);
      expect(result).toBe(YouTubeTranscriptErrorType.REGION_BLOCKED);
    });

    it('should classify unknown errors as default', () => {
      const error = new Error('Some unexpected error');
      const result = errorHandler.classifyError(error, testVideoId);
      expect(result).toBe(YouTubeTranscriptErrorType.UNKNOWN);
    });
  });

  describe('shouldRetry', () => {
    it('should not retry if max attempts reached', () => {
      const result = errorHandler.shouldRetry(YouTubeTranscriptErrorType.NETWORK_ERROR, 3);
      expect(result).toBe(false);
    });

    it('should retry retryable errors within attempt limit', () => {
      const result = errorHandler.shouldRetry(YouTubeTranscriptErrorType.NETWORK_ERROR, 1);
      expect(result).toBe(true);
    });

    it('should not retry non-retryable errors', () => {
      const result = errorHandler.shouldRetry(YouTubeTranscriptErrorType.TRANSCRIPT_DISABLED, 1);
      expect(result).toBe(false);
    });

    it('should not retry permanent errors', () => {
      const permanentErrors = [
        YouTubeTranscriptErrorType.TRANSCRIPT_DISABLED,
        YouTubeTranscriptErrorType.VIDEO_UNAVAILABLE,
        YouTubeTranscriptErrorType.VIDEO_NOT_FOUND,
        YouTubeTranscriptErrorType.PRIVATE_VIDEO,
        YouTubeTranscriptErrorType.REGION_BLOCKED,
        YouTubeTranscriptErrorType.PARSING_ERROR,
      ];

      permanentErrors.forEach(errorType => {
        const result = errorHandler.shouldRetry(errorType, 1);
        expect(result).toBe(false);
      });
    });

    it('should retry transient errors', () => {
      const transientErrors = [
        YouTubeTranscriptErrorType.NETWORK_ERROR,
        YouTubeTranscriptErrorType.TIMEOUT,
        YouTubeTranscriptErrorType.RATE_LIMITED,
        YouTubeTranscriptErrorType.UNKNOWN,
      ];

      transientErrors.forEach(errorType => {
        const result = errorHandler.shouldRetry(errorType, 1);
        expect(result).toBe(true);
      });
    });
  });

  describe('getRetryDelay', () => {
    it('should calculate exponential backoff delay', () => {
      const delay1 = errorHandler.getRetryDelay(1, YouTubeTranscriptErrorType.NETWORK_ERROR);
      const delay2 = errorHandler.getRetryDelay(2, YouTubeTranscriptErrorType.NETWORK_ERROR);
      
      expect(delay1).toBeGreaterThanOrEqual(1000); // Base delay
      expect(delay2).toBeGreaterThan(delay1); // Exponential increase
      expect(delay2).toBeLessThanOrEqual(30000); // Max delay cap
    });

    it('should apply longer delays for rate limiting', () => {
      const networkDelay = errorHandler.getRetryDelay(1, YouTubeTranscriptErrorType.NETWORK_ERROR);
      const rateLimitDelay = errorHandler.getRetryDelay(1, YouTubeTranscriptErrorType.RATE_LIMITED);
      
      expect(rateLimitDelay).toBeGreaterThan(networkDelay);
    });

    it('should respect maximum delay cap', () => {
      const delay = errorHandler.getRetryDelay(10, YouTubeTranscriptErrorType.NETWORK_ERROR);
      expect(delay).toBeLessThanOrEqual(30000);
    });
  });

  describe('formatUserError', () => {
    const testVideoId = 'test123';

    it('should format user-friendly error messages', () => {
      const errorTypes = [
        YouTubeTranscriptErrorType.TRANSCRIPT_DISABLED,
        YouTubeTranscriptErrorType.VIDEO_UNAVAILABLE,
        YouTubeTranscriptErrorType.VIDEO_NOT_FOUND,
        YouTubeTranscriptErrorType.PRIVATE_VIDEO,
        YouTubeTranscriptErrorType.REGION_BLOCKED,
        YouTubeTranscriptErrorType.NETWORK_ERROR,
        YouTubeTranscriptErrorType.RATE_LIMITED,
        YouTubeTranscriptErrorType.TIMEOUT,
        YouTubeTranscriptErrorType.PARSING_ERROR,
        YouTubeTranscriptErrorType.UNKNOWN,
      ];

      errorTypes.forEach(errorType => {
        const message = errorHandler.formatUserError(errorType, testVideoId, new Error('test'));
        expect(message).toContain(testVideoId);
        expect(message.length).toBeGreaterThan(20);
      });
    });
  });
});

describe('YouTubeTranscriptError', () => {
  it('should create error with correct properties', () => {
    const error = new YouTubeTranscriptError(
      YouTubeTranscriptErrorType.TRANSCRIPT_DISABLED,
      'Test message',
      'video123',
      'Original error'
    );

    expect(error.name).toBe('YouTubeTranscriptError');
    expect(error.type).toBe(YouTubeTranscriptErrorType.TRANSCRIPT_DISABLED);
    expect(error.message).toBe('Test message');
    expect(error.videoId).toBe('video123');
    expect(error.originalError).toBe('Original error');
  });
});

describe('ConsoleLogger', () => {
  let logger: ConsoleLogger;
  let stderrSpy: jest.SpyInstance;

  beforeEach(() => {
    logger = new ConsoleLogger();
    stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  it('should log info messages', () => {
    // Set environment variable to enable verbose logging for this test
    process.env.YOUTUBE_TRANSCRIPT_VERBOSE = 'true';
    logger.info('test message', { key: 'value' });
    expect(stderrSpy).toHaveBeenCalledWith('[YouTube Transcript Info] test message {"key":"value"}\n');
    // Clean up
    delete process.env.YOUTUBE_TRANSCRIPT_VERBOSE;
  });

  it('should log debug messages when debug mode enabled', () => {
    process.env.YOUTUBE_TRANSCRIPT_DEBUG = 'true';

    logger.debug('test message', { key: 'value' });

    expect(stderrSpy).toHaveBeenCalledWith('[YouTube Transcript Debug] test message {"key":"value"}\n');

    delete process.env.YOUTUBE_TRANSCRIPT_DEBUG;
  });

  it('should not log debug messages when debug mode disabled', () => {
    logger.debug('test message');

    // stderr.write may be called by other things, so check no YouTube debug line was written
    const calls = stderrSpy.mock.calls.map((c: any[]) => c[0]);
    expect(calls.every((c: string) => !c.includes('[YouTube Transcript Debug]'))).toBe(true);
  });
});

describe('SimpleMetricsCollector', () => {
  let metrics: SimpleMetricsCollector;

  beforeEach(() => {
    metrics = new SimpleMetricsCollector();
  });

  it('should record successful operations', () => {
    metrics.recordSuccess('video123', 2, 1500);
    
    const stats = metrics.getStats();
    expect(stats.totalRequests).toBe(1);
    expect(stats.successful).toBe(1);
    expect(stats.failed).toBe(0);
    expect(stats.averageDuration).toBe(1500);
  });

  it('should record failed operations', () => {
    metrics.recordFailure('video123', 3, YouTubeTranscriptErrorType.NETWORK_ERROR, 2000);
    
    const stats = metrics.getStats();
    expect(stats.totalRequests).toBe(1);
    expect(stats.successful).toBe(0);
    expect(stats.failed).toBe(1);
    expect(stats.errorBreakdown[YouTubeTranscriptErrorType.NETWORK_ERROR]).toBe(1);
    expect(stats.averageDuration).toBe(2000);
  });

  it('should calculate average duration correctly', () => {
    metrics.recordSuccess('video1', 1, 1000);
    metrics.recordSuccess('video2', 1, 2000);
    
    const stats = metrics.getStats();
    expect(stats.averageDuration).toBe(1500);
  });
});

describe('RobustYouTubeTranscriptExtractor', () => {
  let extractor: RobustYouTubeTranscriptExtractor;
  let mockLogger: jest.Mocked<Logger>;
  let mockMetrics: jest.Mocked<MetricsCollector>;

  // Use a custom retry config with no delays for testing
  const testRetryConfig: RetryConfig = {
    maxAttempts: 3,
    baseDelay: 0, // No delay for tests
    maxDelay: 0,
    exponentialBase: 1,
    retryableErrors: [
      YouTubeTranscriptErrorType.NETWORK_ERROR,
      YouTubeTranscriptErrorType.TIMEOUT,
      YouTubeTranscriptErrorType.RATE_LIMITED,
      YouTubeTranscriptErrorType.UNKNOWN
    ],
    jitterFactor: 0
  };

  // Increase timeout for YouTube transcript tests
  jest.setTimeout(10000);

  beforeEach(() => {
    // Use real timers for YouTube transcript tests to avoid interference
    jest.useRealTimers();
    
    mockLogger = {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    };
    
    mockMetrics = {
      recordSuccess: jest.fn(),
      recordFailure: jest.fn(),
    };

    extractor = new RobustYouTubeTranscriptExtractor(
      testRetryConfig,
      mockLogger,
      mockMetrics,
      mockTranscriptFetcher,
      disabledYtDlpFallback
    );

    // Reset all mocks
    jest.clearAllMocks();
    mockFetchTranscript.mockClear();
  });

  afterEach(() => {
    // Clean up any timers or async operations
    jest.clearAllTimers();
    // Keep using real timers for these tests
  });

  describe('extractTranscript - Success Cases', () => {
    it('should successfully extract transcript on first attempt', async () => {
      const mockSegments = [
        { text: 'Hello world' },
        { text: 'This is a test' },
        { text: 'YouTube transcript' }
      ];
      
      mockFetchTranscript.mockResolvedValue(mockSegments);
      
      const result = await extractor.extractTranscript('test123');
      
      expect(result.success).toBe(true);
      expect(result.transcript).toBe('Hello world This is a test YouTube transcript');
      expect(result.videoId).toBe('test123');
      expect(result.attempts).toBe(1);
      expect(result.duration).toBeGreaterThanOrEqual(0);
      expect(mockMetrics.recordSuccess).toHaveBeenCalledWith('test123', 1, expect.any(Number));
      expect(mockLogger.info).toHaveBeenCalled();
    });

    it('should handle empty transcript segments', async () => {
      mockFetchTranscript.mockResolvedValue([]);
      
      const result = await extractor.extractTranscript('test123');
      
      expect(result.success).toBe(false);
      expect(result.error?.type).toBe(YouTubeTranscriptErrorType.TRANSCRIPT_DISABLED);
    });

    it('should handle null transcript response', async () => {
      mockFetchTranscript.mockResolvedValue(null);
      
      const result = await extractor.extractTranscript('test123');
      
      expect(result.success).toBe(false);
      expect(result.error?.type).toBe(YouTubeTranscriptErrorType.LIBRARY_ERROR);
    });
  });

  describe('extractTranscript - Error Handling', () => {
    it('should handle transcript disabled error', async () => {
      mockFetchTranscript.mockRejectedValue(
        new Error('Transcript is disabled for this video')
      );
      
      const result = await extractor.extractTranscript('test123');
      
      expect(result.success).toBe(false);
      expect(result.error?.type).toBe(YouTubeTranscriptErrorType.TRANSCRIPT_DISABLED);
      expect(result.attempts).toBe(1); // Should not retry permanent errors
      expect(mockFetchTranscript).toHaveBeenCalledTimes(1);
    });

    it('should retry transient errors', async () => {
      mockFetchTranscript.mockRejectedValue(
        new Error('Network connection failed')
      );
      
      const result = await extractor.extractTranscript('test123');
      
      expect(result.success).toBe(false);
      expect(result.error?.type).toBe(YouTubeTranscriptErrorType.NETWORK_ERROR);
      expect(result.attempts).toBe(3); // Should retry up to max attempts
      expect(mockFetchTranscript).toHaveBeenCalledTimes(3);
    });

    it('should succeed after retry', async () => {
      const mockSegments = [{ text: 'Success after retry' }];
      
      // Fail first, succeed on second
      mockFetchTranscript
        .mockRejectedValueOnce(new Error('Network connection failed'))
        .mockResolvedValueOnce(mockSegments);
      
      const result = await extractor.extractTranscript('test123');
      
      expect(result.success).toBe(true);
      expect(result.transcript).toBe('Success after retry');
      expect(result.attempts).toBe(2);
      expect(mockFetchTranscript).toHaveBeenCalledTimes(2);
    });

    const errorScenarios = [
      {
        name: 'video unavailable',
        errorMessage: 'Video unavailable',
        expectedType: YouTubeTranscriptErrorType.VIDEO_UNAVAILABLE,
        shouldRetry: false
      },
      {
        name: 'video not found',
        errorMessage: 'Video not found',
        expectedType: YouTubeTranscriptErrorType.VIDEO_NOT_FOUND,
        shouldRetry: false
      },
      {
        name: 'private video',
        errorMessage: 'Access denied - private video',
        expectedType: YouTubeTranscriptErrorType.PRIVATE_VIDEO,
        shouldRetry: false
      },
      {
        name: 'region blocked',
        errorMessage: 'This video is region blocked',
        expectedType: YouTubeTranscriptErrorType.REGION_BLOCKED,
        shouldRetry: false
      },
      {
        name: 'rate limited',
        errorMessage: 'Rate limit exceeded',
        expectedType: YouTubeTranscriptErrorType.RATE_LIMITED,
        shouldRetry: true
      },
      {
        name: 'timeout',
        errorMessage: 'Request timed out',
        expectedType: YouTubeTranscriptErrorType.TIMEOUT,
        shouldRetry: true
      },
      {
        name: 'parsing error',
        errorMessage: 'Failed to parse JSON response',
        expectedType: YouTubeTranscriptErrorType.PARSING_ERROR,
        shouldRetry: false
      }
    ];

    errorScenarios.forEach(scenario => {
      it(`should handle ${scenario.name} correctly`, async () => {
        mockFetchTranscript.mockRejectedValue(
          new Error(scenario.errorMessage)
        );
        
        const result = await extractor.extractTranscript('test123');
        
        expect(result.success).toBe(false);
        expect(result.error?.type).toBe(scenario.expectedType);
        expect(result.error?.message).toContain('test123');
        expect(result.error?.originalError).toBe(scenario.errorMessage);
        
        const expectedAttempts = scenario.shouldRetry ? 3 : 1;
        expect(result.attempts).toBe(expectedAttempts);
        expect(mockFetchTranscript).toHaveBeenCalledTimes(expectedAttempts);
      });
    });
  });

  describe('getMetrics', () => {
    it('should return null for custom metrics collector', () => {
      const metrics = extractor.getMetrics();
      expect(metrics).toBeNull();
    });

    it('should return metrics from SimpleMetricsCollector', () => {
      const extractorWithSimpleMetrics = new RobustYouTubeTranscriptExtractor();
      const metrics = extractorWithSimpleMetrics.getMetrics();
      
      expect(metrics).toBeDefined();
      expect(metrics).toHaveProperty('totalRequests');
      expect(metrics).toHaveProperty('successful');
      expect(metrics).toHaveProperty('failed');
    });
  });

  describe('Custom Configuration', () => {
    it('should use custom retry configuration', async () => {
      const customConfig: RetryConfig = {
        maxAttempts: 5,
        baseDelay: 0,
        maxDelay: 0,
        exponentialBase: 1,
        retryableErrors: [YouTubeTranscriptErrorType.NETWORK_ERROR],
        jitterFactor: 0
      };
      
      const customExtractor = new RobustYouTubeTranscriptExtractor(
        customConfig,
        mockLogger,
        mockMetrics,
        mockTranscriptFetcher,
        disabledYtDlpFallback
      );
      
      mockFetchTranscript.mockRejectedValue(
        new Error('Network connection failed')
      );
      
      const result = await customExtractor.extractTranscript('test123');
      
      expect(result.success).toBe(false);
      expect(result.attempts).toBe(5); // Custom max attempts
      expect(mockFetchTranscript).toHaveBeenCalledTimes(5);
    });

    it('should use default configuration when not specified', () => {
      const extractorWithDefaults = new RobustYouTubeTranscriptExtractor();
      expect(extractorWithDefaults).toBeInstanceOf(RobustYouTubeTranscriptExtractor);
      
      // Test that it uses default configuration by testing metrics
      const metrics = extractorWithDefaults.getMetrics();
      expect(metrics).toBeDefined(); // Should have SimpleMetricsCollector
    });
  });
});

describe('Integration Tests', () => {
  describe('Error Message Formatting', () => {
    it('should provide clear error messages for end users', async () => {
      const extractor = new RobustYouTubeTranscriptExtractor({
        ...DEFAULT_RETRY_CONFIG,
        baseDelay: 0, // No delay for test
        maxDelay: 0
      }, undefined, undefined, mockTranscriptFetcher, disabledYtDlpFallback);

      mockFetchTranscript.mockRejectedValue(
        new Error('Transcript is disabled for this video')
      );

      const result = await extractor.extractTranscript('dQw4w9WgXcQ');

      expect(result.success).toBe(false);
      expect(result.error?.message).toContain('dQw4w9WgXcQ');
      expect(result.error?.message).toContain('disabled automatic captions');
      expect(result.error?.message.length).toBeGreaterThan(50);
    });
  });
});

describe('yt-dlp Fallback', () => {
  let mockLogger: jest.Mocked<Logger>;
  let mockMetrics: jest.Mocked<MetricsCollector>;

  const testRetryConfig: RetryConfig = {
    maxAttempts: 1,
    baseDelay: 0,
    maxDelay: 0,
    exponentialBase: 1,
    retryableErrors: [],
    jitterFactor: 0
  };

  beforeEach(() => {
    jest.useRealTimers();
    mockLogger = {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    };
    mockMetrics = {
      recordSuccess: jest.fn(),
      recordFailure: jest.fn(),
    };
    jest.clearAllMocks();
    mockFetchTranscript.mockClear();
  });

  it('should fall back to yt-dlp when library fails and yt-dlp is available', async () => {
    const mockYtDlp: YtDlpFallback = {
      isAvailable: async () => true,
      extractTranscript: async () => 'Hello from yt-dlp transcript'
    };

    mockFetchTranscript.mockRejectedValue(new Error('Transcript is disabled on this video'));

    const extractor = new RobustYouTubeTranscriptExtractor(
      testRetryConfig, mockLogger, mockMetrics, mockTranscriptFetcher, mockYtDlp
    );

    const result = await extractor.extractTranscript('test123');

    expect(result.success).toBe(true);
    expect(result.transcript).toBe('Hello from yt-dlp transcript');
    expect(mockMetrics.recordSuccess).toHaveBeenCalled();
    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.stringContaining('yt-dlp fallback succeeded'),
      expect.any(Object)
    );
  });

  it('should skip yt-dlp when it is not available', async () => {
    const mockYtDlp: YtDlpFallback = {
      isAvailable: async () => false,
      extractTranscript: async () => { throw new Error('should not be called'); }
    };

    mockFetchTranscript.mockRejectedValue(new Error('Transcript is disabled on this video'));

    const extractor = new RobustYouTubeTranscriptExtractor(
      testRetryConfig, mockLogger, mockMetrics, mockTranscriptFetcher, mockYtDlp
    );

    const result = await extractor.extractTranscript('test123');

    expect(result.success).toBe(false);
    expect(mockLogger.warn).toHaveBeenCalledWith('yt-dlp not available on system, skipping fallback');
  });

  it('should return library error when yt-dlp also fails', async () => {
    const mockYtDlp: YtDlpFallback = {
      isAvailable: async () => true,
      extractTranscript: async () => { throw new Error('yt-dlp process exited with code 1'); }
    };

    mockFetchTranscript.mockRejectedValue(new Error('Transcript is disabled on this video'));

    const extractor = new RobustYouTubeTranscriptExtractor(
      testRetryConfig, mockLogger, mockMetrics, mockTranscriptFetcher, mockYtDlp
    );

    const result = await extractor.extractTranscript('test123');

    expect(result.success).toBe(false);
    expect(result.error?.type).toBe(YouTubeTranscriptErrorType.TRANSCRIPT_DISABLED);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('yt-dlp fallback also failed'),
      expect.any(Object)
    );
  });

  it('should not attempt yt-dlp when library succeeds', async () => {
    const ytDlpExtract = jest.fn() as jest.MockedFunction<(videoId: string) => Promise<string>>;
    const mockYtDlp: YtDlpFallback = {
      isAvailable: async () => true,
      extractTranscript: ytDlpExtract,
    };

    mockFetchTranscript.mockResolvedValue([{ text: 'Library worked' }]);

    const extractor = new RobustYouTubeTranscriptExtractor(
      testRetryConfig, mockLogger, mockMetrics, mockTranscriptFetcher, mockYtDlp
    );

    const result = await extractor.extractTranscript('test123');

    expect(result.success).toBe(true);
    expect(result.transcript).toBe('Library worked');
    expect(ytDlpExtract).not.toHaveBeenCalled();
  });

  it('should try yt-dlp after all library retries are exhausted', async () => {
    const retryConfig: RetryConfig = {
      maxAttempts: 3,
      baseDelay: 0,
      maxDelay: 0,
      exponentialBase: 1,
      retryableErrors: [YouTubeTranscriptErrorType.NETWORK_ERROR],
      jitterFactor: 0
    };

    const mockYtDlp: YtDlpFallback = {
      isAvailable: async () => true,
      extractTranscript: async () => 'Recovered via yt-dlp'
    };

    mockFetchTranscript.mockRejectedValue(new Error('Network connection failed'));

    const extractor = new RobustYouTubeTranscriptExtractor(
      retryConfig, mockLogger, mockMetrics, mockTranscriptFetcher, mockYtDlp
    );

    const result = await extractor.extractTranscript('test123');

    expect(result.success).toBe(true);
    expect(result.transcript).toBe('Recovered via yt-dlp');
    expect(mockFetchTranscript).toHaveBeenCalledTimes(3); // All retries exhausted first
    expect(result.attempts).toBe(4); // 3 library + 1 yt-dlp
  });
});