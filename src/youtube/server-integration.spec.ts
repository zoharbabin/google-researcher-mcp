import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { RobustYouTubeTranscriptExtractor, YouTubeTranscriptErrorType, TranscriptFetcher, YtDlpFallback } from './transcriptExtractor.js';

// Create a mock transcript fetcher
const mockFetchTranscript = jest.fn() as jest.MockedFunction<(videoId: string) => Promise<any>>;
const mockTranscriptFetcher: TranscriptFetcher = {
  fetchTranscript: mockFetchTranscript
};

// Disabled yt-dlp fallback for unit tests
const disabledYtDlpFallback: YtDlpFallback = {
  isAvailable: async () => false,
  extractTranscript: async () => { throw new Error('yt-dlp not available'); }
};

describe('YouTube Transcript Server Integration Tests', () => {
  let transcriptExtractor: RobustYouTubeTranscriptExtractor;

  // Increase timeout for integration tests
  jest.setTimeout(10000);

  beforeEach(() => {
    // Use real timers for YouTube transcript tests to avoid interference
    jest.useRealTimers();
    
    // Use zero delays for testing and inject the mock transcript fetcher
    transcriptExtractor = new RobustYouTubeTranscriptExtractor({
      maxAttempts: 3,
      baseDelay: 0,
      maxDelay: 0,
      exponentialBase: 1,
      retryableErrors: [
        YouTubeTranscriptErrorType.NETWORK_ERROR,
        YouTubeTranscriptErrorType.TIMEOUT,
        YouTubeTranscriptErrorType.RATE_LIMITED,
        YouTubeTranscriptErrorType.UNKNOWN
      ],
      jitterFactor: 0
    }, undefined, undefined, mockTranscriptFetcher, disabledYtDlpFallback);

    // Clear and reset all mocks
    jest.clearAllMocks();
    mockFetchTranscript.mockClear();
    mockFetchTranscript.mockReset();
  });

  afterEach(() => {
    // Clean up any timers or async operations
    jest.clearAllTimers();
    // Keep using real timers for these tests
  });

  describe('YouTube URL Detection and Processing', () => {
    it('should detect YouTube URLs correctly', () => {
      const testUrls = [
        'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
        'https://youtu.be/dQw4w9WgXcQ',
        'https://youtube.com/watch?v=dQw4w9WgXcQ&t=30s',
        'https://m.youtube.com/watch?v=dQw4w9WgXcQ'
      ];

      testUrls.forEach(url => {
        const match = url.match(/(?:youtu\.be\/|youtube\.com\/watch\?v=)([A-Za-z0-9_-]{11})/);
        expect(match).toBeTruthy();
        expect(match![1]).toBe('dQw4w9WgXcQ');
      });
    });

    it('should not detect non-YouTube URLs', () => {
      const testUrls = [
        'https://www.google.com',
        'https://example.com/video',
        'https://vimeo.com/123456789'
      ];

      testUrls.forEach(url => {
        const match = url.match(/(?:youtu\.be\/|youtube\.com\/watch\?v=)([A-Za-z0-9_-]{11})/);
        expect(match).toBeNull();
      });
    });

    it('should handle malformed YouTube URLs', () => {
      const malformedUrls = [
        'https://www.youtube.com/watch?v=invalid',
        'https://www.youtube.com/watch?v=',
        'https://youtu.be/',
        'https://youtube.com/watch?v=tooshort'
      ];

      malformedUrls.forEach(url => {
        const match = url.match(/(?:youtu\.be\/|youtube\.com\/watch\?v=)([A-Za-z0-9_-]{11})/);
        expect(match).toBeNull();
      });
    });
  });

  describe('Transcript Extraction Integration', () => {
    it('should successfully extract YouTube transcript', async () => {
      const mockSegments = [
        { text: 'Hello world' },
        { text: 'This is a test' },
        { text: 'YouTube video' }
      ];
      
      // Ensure the mock is properly set up
      mockFetchTranscript.mockResolvedValue(mockSegments);
      
      // Verify mock is set up
      expect(mockFetchTranscript).toBeDefined();
      
      // Add debugging to see if mock is being called
      console.log('Mock setup complete, calling extractor...');

      const result = await transcriptExtractor.extractTranscript('dQw4w9WgXcQ');
      
      // Debug the result
      console.log('Result:', JSON.stringify(result, null, 2));
      console.log('Mock call count:', mockFetchTranscript.mock.calls.length);
      console.log('Mock calls:', mockFetchTranscript.mock.calls);

      expect(result.success).toBe(true);
      expect(result.transcript).toBe('Hello world This is a test YouTube video');
      expect(result.videoId).toBe('dQw4w9WgXcQ');
      expect(mockFetchTranscript).toHaveBeenCalledWith('dQw4w9WgXcQ');
    });

    it('should handle YouTube transcript errors gracefully', async () => {
      mockFetchTranscript.mockRejectedValue(
        new Error('Transcript is disabled for this video')
      );

      const result = await transcriptExtractor.extractTranscript('dQw4w9WgXcQ');

      expect(result.success).toBe(false);
      expect(result.error?.type).toBe(YouTubeTranscriptErrorType.TRANSCRIPT_DISABLED);
      expect(result.error?.message).toContain('disabled automatic captions');
      expect(mockFetchTranscript).toHaveBeenCalledWith('dQw4w9WgXcQ');
    });

    it('should extract video ID from different YouTube URL formats', () => {
      const urlFormats = [
        { url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', expected: 'dQw4w9WgXcQ' },
        { url: 'https://youtu.be/dQw4w9WgXcQ', expected: 'dQw4w9WgXcQ' },
        { url: 'https://youtube.com/watch?v=dQw4w9WgXcQ&t=30s', expected: 'dQw4w9WgXcQ' },
        { url: 'https://m.youtube.com/watch?v=dQw4w9WgXcQ&feature=share', expected: 'dQw4w9WgXcQ' },
        { url: 'https://www.youtube.com/watch?v=abc123DEF45', expected: 'abc123DEF45' },
        { url: 'https://youtu.be/xyz789ABC12', expected: 'xyz789ABC12' }
      ];

      urlFormats.forEach(({ url, expected }) => {
        const match = url.match(/(?:youtu\.be\/|youtube\.com\/watch\?v=)([A-Za-z0-9_-]{11})/);
        expect(match).toBeTruthy();
        expect(match![1]).toBe(expected);
      });
    });
  });

  describe('Error Scenarios', () => {
    const errorScenarios = [
      {
        name: 'transcript disabled',
        error: 'Transcript is disabled for this video',
        expectedType: YouTubeTranscriptErrorType.TRANSCRIPT_DISABLED,
        expectedMessage: 'disabled automatic captions'
      },
      {
        name: 'video unavailable',
        error: 'Video unavailable',
        expectedType: YouTubeTranscriptErrorType.VIDEO_UNAVAILABLE,
        expectedMessage: 'unavailable'
      },
      {
        name: 'video not found',
        error: 'Video not found',
        expectedType: YouTubeTranscriptErrorType.VIDEO_NOT_FOUND,
        expectedMessage: 'not found'
      },
      {
        name: 'private video',
        error: 'Access denied - private video',
        expectedType: YouTubeTranscriptErrorType.PRIVATE_VIDEO,
        expectedMessage: 'private'
      },
      {
        name: 'region blocked',
        error: 'This video is region blocked',
        expectedType: YouTubeTranscriptErrorType.REGION_BLOCKED,
        expectedMessage: 'blocked in your region'
      },
      {
        name: 'rate limited',
        error: 'Rate limit exceeded',
        expectedType: YouTubeTranscriptErrorType.RATE_LIMITED,
        expectedMessage: 'Rate limit exceeded'
      },
      {
        name: 'network error',
        error: 'Network connection failed',
        expectedType: YouTubeTranscriptErrorType.NETWORK_ERROR,
        expectedMessage: 'Network error'
      },
      {
        name: 'timeout',
        error: 'Request timed out',
        expectedType: YouTubeTranscriptErrorType.TIMEOUT,
        expectedMessage: 'Timeout occurred'
      },
      {
        name: 'parsing error',
        error: 'Failed to parse JSON response',
        expectedType: YouTubeTranscriptErrorType.PARSING_ERROR,
        expectedMessage: 'Error parsing'
      }
    ];

    errorScenarios.forEach(scenario => {
      it(`should handle ${scenario.name} with user-friendly message`, async () => {
        mockFetchTranscript.mockRejectedValue(new Error(scenario.error));

        const result = await transcriptExtractor.extractTranscript('dQw4w9WgXcQ');

        expect(result.success).toBe(false);
        expect(result.error?.type).toBe(scenario.expectedType);
        expect(result.error?.message).toContain('dQw4w9WgXcQ');
        expect(result.error?.message.toLowerCase()).toContain(scenario.expectedMessage.toLowerCase());
      });
    });
  });

  describe('Performance and Reliability', () => {
    it('should handle empty transcript segments', async () => {
      mockFetchTranscript.mockResolvedValue([]);

      const result = await transcriptExtractor.extractTranscript('dQw4w9WgXcQ');

      expect(result.success).toBe(false);
      expect(result.error?.type).toBe(YouTubeTranscriptErrorType.TRANSCRIPT_DISABLED);
    });

    it('should handle null transcript response', async () => {
      mockFetchTranscript.mockResolvedValue(null);

      const result = await transcriptExtractor.extractTranscript('dQw4w9WgXcQ');

      expect(result.success).toBe(false);
      expect(result.error?.type).toBe(YouTubeTranscriptErrorType.LIBRARY_ERROR);
    });

    it('should retry transient errors and eventually fail', async () => {
      mockFetchTranscript.mockRejectedValue(
        new Error('Network connection failed')
      );

      const result = await transcriptExtractor.extractTranscript('dQw4w9WgXcQ');

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

      const result = await transcriptExtractor.extractTranscript('dQw4w9WgXcQ');

      expect(result.success).toBe(true);
      expect(result.transcript).toBe('Success after retry');
      expect(result.attempts).toBe(2);
      expect(mockFetchTranscript).toHaveBeenCalledTimes(2);
    });

    it('should not retry permanent errors', async () => {
      const permanentErrors = [
        'Transcript is disabled for this video',
        'Video unavailable',
        'Video not found',
        'Access denied - private video',
        'This video is region blocked',
        'Failed to parse JSON response'
      ];

      for (const error of permanentErrors) {
        mockFetchTranscript.mockClear();
        mockFetchTranscript.mockRejectedValue(new Error(error));

        const result = await transcriptExtractor.extractTranscript('test123');

        expect(result.success).toBe(false);
        expect(result.attempts).toBe(1); // Should not retry
        expect(mockFetchTranscript).toHaveBeenCalledTimes(1);
      }
    });

    it('should measure extraction duration', async () => {
      const mockSegments = [{ text: 'Duration test' }];
      mockFetchTranscript.mockResolvedValue(mockSegments);

      const result = await transcriptExtractor.extractTranscript('dQw4w9WgXcQ');

      expect(result.success).toBe(true);
      expect(result.duration).toBeGreaterThanOrEqual(0);
      expect(typeof result.duration).toBe('number');
    });
  });

  describe('Backward Compatibility', () => {
    it('should maintain consistent result structure', async () => {
      const mockSegments = [{ text: 'Compatibility test' }];
      mockFetchTranscript.mockResolvedValue(mockSegments);

      const result = await transcriptExtractor.extractTranscript('test123');

      // Check required properties for successful result
      expect(result).toHaveProperty('success');
      expect(result).toHaveProperty('videoId');
      expect(result).toHaveProperty('attempts');
      expect(result).toHaveProperty('duration');
      expect(result).toHaveProperty('transcript');
      
      expect(result.success).toBe(true);
      expect(result.videoId).toBe('test123');
      expect(typeof result.attempts).toBe('number');
      expect(typeof result.duration).toBe('number');
      expect(typeof result.transcript).toBe('string');
    });

    it('should maintain consistent error structure', async () => {
      mockFetchTranscript.mockRejectedValue(
        new Error('Transcript is disabled for this video')
      );

      const result = await transcriptExtractor.extractTranscript('test123');

      // Check required properties for error result
      expect(result).toHaveProperty('success');
      expect(result).toHaveProperty('videoId');
      expect(result).toHaveProperty('attempts');
      expect(result).toHaveProperty('duration');
      expect(result).toHaveProperty('error');
      
      expect(result.success).toBe(false);
      expect(result.videoId).toBe('test123');
      expect(typeof result.attempts).toBe('number');
      expect(typeof result.duration).toBe('number');
      
      // Check error structure
      expect(result.error).toHaveProperty('type');
      expect(result.error).toHaveProperty('message');
      expect(result.error).toHaveProperty('originalError');
      expect(result.error).toHaveProperty('videoId');
      expect(result.error).toHaveProperty('attempts');
      expect(result.error).toHaveProperty('duration');
    });
  });

  describe('Edge Cases and Malformed URLs', () => {
    it('should handle various video ID formats', () => {
      const validVideoIds = [
        'dQw4w9WgXcQ',  // Standard 11-character ID
        'abc123DEF45',  // Mixed case
        'xyz789ABC12',  // Different pattern
        '_-abcDEF123',  // With underscores and hyphens
        'a1b2c3d4e5f'   // Alternating numbers and letters
      ];

      validVideoIds.forEach(videoId => {
        const testUrl = `https://www.youtube.com/watch?v=${videoId}`;
        const match = testUrl.match(/(?:youtu\.be\/|youtube\.com\/watch\?v=)([A-Za-z0-9_-]{11})/);
        expect(match).toBeTruthy();
        expect(match![1]).toBe(videoId);
      });
    });

    it('should reject invalid video ID formats', () => {
      const invalidVideoIds = [
        'short',        // Too short
        'toolongvideoid123', // Too long
        'invalid@id',   // Invalid characters
        'spaces in id', // Spaces
        '',             // Empty
        '12345',        // Too short numbers only
      ];

      invalidVideoIds.forEach(videoId => {
        const testUrl = `https://www.youtube.com/watch?v=${videoId}`;
        // Use more precise regex that requires exactly 11 characters
        const match = testUrl.match(/(?:youtu\.be\/|youtube\.com\/watch\?v=)([A-Za-z0-9_-]{11})(?:[&#?]|$)/);
        expect(match).toBeNull();
      });
    });

    it('should handle URLs with additional parameters', () => {
      const urlsWithParams = [
        'https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=30s',
        'https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PLrAXtmRdnEQy8VfVGVvpXzpJuyYJkXqGn',
        'https://www.youtube.com/watch?v=dQw4w9WgXcQ&feature=share',
        'https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=1m30s&feature=youtu.be'
      ];

      urlsWithParams.forEach(url => {
        const match = url.match(/(?:youtu\.be\/|youtube\.com\/watch\?v=)([A-Za-z0-9_-]{11})/);
        expect(match).toBeTruthy();
        expect(match![1]).toBe('dQw4w9WgXcQ');
      });
    });
  });
});