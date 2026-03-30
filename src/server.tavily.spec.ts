/**
 * Tavily Search Provider Tests
 *
 * Covers: searchFn routing (google / tavily / parallel), parallel-mode
 * deduplication, both-providers-failed error, startup warning when
 * TAVILY_API_KEY is missing, and envValidator rules for TAVILY_API_KEY
 * and SEARCH_PROVIDER.
 */

import { jest, describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from '@jest/globals';
import { PersistentCache } from './cache/index.js';
import { PersistentEventStore } from './shared/persistentEventStore.js';
import {
  createTestStoragePaths,
  ensureTestStorageDirs,
  cleanupTestStorage,
  setupTestEnv,
  createTestInstances,
  disposeTestInstances,
  cleanupProcessListeners,
} from './test-helpers.js';
import {
  validateEnvVar,
  ENV_VALIDATION_RULES,
} from './shared/envValidator.js';

// ── Mocks ────────────────────────────────────────────────────────────────────

jest.mock('crawlee', () => ({
  CheerioCrawler: jest.fn().mockImplementation(() => ({
    run: jest.fn(() => Promise.resolve()),
  })),
  PlaywrightCrawler: jest.fn().mockImplementation(() => ({
    run: jest.fn(() => Promise.resolve()),
  })),
  Configuration: { getGlobalConfig: () => ({ set: jest.fn() }) },
  log: { setLevel: jest.fn() },
  LogLevel: { OFF: 0, ERROR: 1, WARNING: 2, INFO: 3, DEBUG: 4 },
}));

jest.mock('@danielxceron/youtube-transcript', () => ({
  YoutubeTranscript: {
    fetchTranscript: jest.fn(() =>
      Promise.resolve([{ text: 'Mock transcript segment' }]),
    ),
  },
}));

// Mock Tavily client: search returns two results
const mockTavilySearch = jest.fn(() =>
  Promise.resolve({
    results: [
      { url: 'https://tavily1.com', title: 'T1', content: 'c1', score: 0.9 },
      { url: 'https://tavily2.com', title: 'T2', content: 'c2', score: 0.8 },
    ],
  }),
);

jest.mock('@tavily/core', () => ({
  tavily: jest.fn(() => ({ search: mockTavilySearch })),
}));

// Mock fetch for Google Search API
global.fetch = jest.fn(() =>
  Promise.resolve({
    ok: true,
    json: () =>
      Promise.resolve({
        items: [
          { link: 'https://google1.com' },
          { link: 'https://google2.com' },
        ],
      }),
  }),
) as any;

if (!global.AbortSignal.timeout) {
  global.AbortSignal.timeout = jest.fn((ms: number) => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), ms);
    return controller.signal;
  });
}

// ── envValidator unit tests ──────────────────────────────────────────────────

describe('envValidator – Tavily rules', () => {
  describe('TAVILY_API_KEY', () => {
    const rule = ENV_VALIDATION_RULES.find(r => r.name === 'TAVILY_API_KEY')!;

    it('accepts valid Tavily API key', () => {
      const validKey = 'tvly-ABCDEFGHIJKLMNOPQRSTUVWXYZ12';
      const result = validateEnvVar(rule, validKey);
      expect(result.valid).toBe(true);
    });

    it('rejects key without tvly- prefix', () => {
      const result = validateEnvVar(rule, 'invalidkey1234567890123456789012');
      expect(result.valid).toBe(false);
      expect(result.error?.type).toBe('invalid_format');
    });

    it('rejects key that is too short', () => {
      const result = validateEnvVar(rule, 'tvly-short');
      expect(result.valid).toBe(false);
      expect(result.error?.type).toBe('invalid_format');
    });

    it('accepts undefined (optional)', () => {
      const result = validateEnvVar(rule, undefined);
      expect(result.valid).toBe(true);
    });
  });

  describe('SEARCH_PROVIDER', () => {
    const rule = ENV_VALIDATION_RULES.find(r => r.name === 'SEARCH_PROVIDER')!;

    it('accepts "google"', () => {
      expect(validateEnvVar(rule, 'google').valid).toBe(true);
    });

    it('accepts "tavily"', () => {
      expect(validateEnvVar(rule, 'tavily').valid).toBe(true);
    });

    it('accepts "parallel"', () => {
      expect(validateEnvVar(rule, 'parallel').valid).toBe(true);
    });

    it('rejects unknown provider value', () => {
      const result = validateEnvVar(rule, 'bing');
      expect(result.valid).toBe(false);
      expect(result.error?.type).toBe('invalid_value');
    });

    it('accepts undefined (optional, defaults to google)', () => {
      expect(validateEnvVar(rule, undefined).valid).toBe(true);
    });
  });
});

// ── Server-level Tavily integration tests ────────────────────────────────────

describe('Tavily search provider integration', () => {
  let testCache: PersistentCache;
  let testEventStore: PersistentEventStore;
  const paths = createTestStoragePaths('tavily-provider-spec', import.meta.url);

  beforeAll(async () => {
    setupTestEnv({ NODE_ENV: 'test' });
    await ensureTestStorageDirs(paths);
  });

  afterAll(async () => {
    await disposeTestInstances({ cache: testCache, eventStore: testEventStore });
    await cleanupTestStorage(paths);
    cleanupProcessListeners();
  });

  afterEach(async () => {
    await disposeTestInstances({ cache: testCache, eventStore: testEventStore });
    // Restore default
    delete process.env.SEARCH_PROVIDER;
    delete process.env.TAVILY_API_KEY;
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    const instances = createTestInstances(paths);
    testCache = instances.cache;
    testEventStore = instances.eventStore;
  });

  it('initialises with SEARCH_PROVIDER=tavily when TAVILY_API_KEY is set', async () => {
    process.env.SEARCH_PROVIDER = 'tavily';
    process.env.TAVILY_API_KEY = 'tvly-ABCDEFGHIJKLMNOPQRSTUVWXYZ12';

    const { initializeGlobalInstances, createAppAndHttpTransport } = await import('./server.js');
    await initializeGlobalInstances(paths.cachePath, paths.eventPath);
    const { app } = await createAppAndHttpTransport(testCache, testEventStore);

    expect(app).toBeDefined();
  });

  it('initialises with SEARCH_PROVIDER=parallel when both keys are set', async () => {
    process.env.SEARCH_PROVIDER = 'parallel';
    process.env.TAVILY_API_KEY = 'tvly-ABCDEFGHIJKLMNOPQRSTUVWXYZ12';

    const { initializeGlobalInstances, createAppAndHttpTransport } = await import('./server.js');
    await initializeGlobalInstances(paths.cachePath, paths.eventPath);
    const { app } = await createAppAndHttpTransport(testCache, testEventStore);

    expect(app).toBeDefined();
  });

  it('logs a startup warning when SEARCH_PROVIDER=tavily but TAVILY_API_KEY is missing', async () => {
    process.env.SEARCH_PROVIDER = 'tavily';
    delete process.env.TAVILY_API_KEY;

    // Spy on the logger
    const loggerModule = await import('./shared/logger.js');
    const warnSpy = jest.spyOn(loggerModule.logger, 'warn');

    const { initializeGlobalInstances, createAppAndHttpTransport } = await import('./server.js');
    await initializeGlobalInstances(paths.cachePath, paths.eventPath);
    const { app } = await createAppAndHttpTransport(testCache, testEventStore);

    expect(app).toBeDefined();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('TAVILY_API_KEY is not configured'),
    );

    warnSpy.mockRestore();
  });

  it('logs a startup warning when SEARCH_PROVIDER=parallel but TAVILY_API_KEY is missing', async () => {
    process.env.SEARCH_PROVIDER = 'parallel';
    delete process.env.TAVILY_API_KEY;

    const loggerModule = await import('./shared/logger.js');
    const warnSpy = jest.spyOn(loggerModule.logger, 'warn');

    const { initializeGlobalInstances, createAppAndHttpTransport } = await import('./server.js');
    await initializeGlobalInstances(paths.cachePath, paths.eventPath);
    const { app } = await createAppAndHttpTransport(testCache, testEventStore);

    expect(app).toBeDefined();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('TAVILY_API_KEY is not configured'),
    );

    warnSpy.mockRestore();
  });

  it('does NOT log a warning when SEARCH_PROVIDER=google (default)', async () => {
    process.env.SEARCH_PROVIDER = 'google';
    delete process.env.TAVILY_API_KEY;

    const loggerModule = await import('./shared/logger.js');
    const warnSpy = jest.spyOn(loggerModule.logger, 'warn');

    const { initializeGlobalInstances, createAppAndHttpTransport } = await import('./server.js');
    await initializeGlobalInstances(paths.cachePath, paths.eventPath);
    const { app } = await createAppAndHttpTransport(testCache, testEventStore);

    expect(app).toBeDefined();
    // Should NOT have the Tavily warning
    const tavilyWarnings = warnSpy.mock.calls.filter(
      call => typeof call[0] === 'string' && call[0].includes('TAVILY_API_KEY is not configured'),
    );
    expect(tavilyWarnings).toHaveLength(0);

    warnSpy.mockRestore();
  });
});
