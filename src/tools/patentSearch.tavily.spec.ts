/**
 * Tests for Patent Search Tool — Tavily provider path
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';

// Mock @tavily/core before importing the module under test
const mockSearch = jest.fn();
jest.unstable_mockModule('@tavily/core', () => ({
  tavily: jest.fn(() => ({ search: mockSearch })),
}));

const {
  handlePatentSearch,
  useTavilyProvider,
  buildTavilyPatentQuery,
  parseTavilyPatentResult,
} = await import('./patentSearch.js');

// Save original env vars
const originalEnv = { ...process.env };

describe('patentSearch — Tavily provider', () => {
  beforeEach(() => {
    process.env.TAVILY_API_KEY = 'tvly-test-key-123';
    process.env.SEARCH_PROVIDER = 'tavily';
    delete process.env.GOOGLE_CUSTOM_SEARCH_API_KEY;
    delete process.env.GOOGLE_CUSTOM_SEARCH_ID;
    mockSearch.mockReset();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    jest.restoreAllMocks();
  });

  // ── Provider routing tests ──────────────────────────────────────────────

  describe('useTavilyProvider', () => {
    it('should return true when SEARCH_PROVIDER=tavily', () => {
      process.env.SEARCH_PROVIDER = 'tavily';
      expect(useTavilyProvider()).toBe(true);
    });

    it('should return true when SEARCH_PROVIDER=parallel', () => {
      process.env.SEARCH_PROVIDER = 'parallel';
      expect(useTavilyProvider()).toBe(true);
    });

    it('should return false when SEARCH_PROVIDER=google', () => {
      process.env.SEARCH_PROVIDER = 'google';
      expect(useTavilyProvider()).toBe(false);
    });

    it('should return true when only TAVILY_API_KEY is set (no Google creds)', () => {
      delete process.env.SEARCH_PROVIDER;
      delete process.env.GOOGLE_CUSTOM_SEARCH_API_KEY;
      delete process.env.GOOGLE_CUSTOM_SEARCH_ID;
      process.env.TAVILY_API_KEY = 'tvly-test';
      expect(useTavilyProvider()).toBe(true);
    });

    it('should return false when both Google and Tavily creds are set (no explicit provider)', () => {
      delete process.env.SEARCH_PROVIDER;
      process.env.GOOGLE_CUSTOM_SEARCH_API_KEY = 'google-key';
      process.env.GOOGLE_CUSTOM_SEARCH_ID = 'google-id';
      process.env.TAVILY_API_KEY = 'tvly-test';
      expect(useTavilyProvider()).toBe(false);
    });

    it('should return false when no credentials are set', () => {
      delete process.env.SEARCH_PROVIDER;
      delete process.env.GOOGLE_CUSTOM_SEARCH_API_KEY;
      delete process.env.GOOGLE_CUSTOM_SEARCH_ID;
      delete process.env.TAVILY_API_KEY;
      expect(useTavilyProvider()).toBe(false);
    });

    it('should be case-insensitive for SEARCH_PROVIDER', () => {
      process.env.SEARCH_PROVIDER = 'Tavily';
      expect(useTavilyProvider()).toBe(true);

      process.env.SEARCH_PROVIDER = 'PARALLEL';
      expect(useTavilyProvider()).toBe(true);
    });
  });

  // ── buildTavilyPatentQuery tests ────────────────────────────────────────

  describe('buildTavilyPatentQuery', () => {
    it('should include query text', () => {
      const query = buildTavilyPatentQuery({ query: 'machine learning' });
      expect(query).toContain('machine learning');
    });

    it('should include patent office when specified', () => {
      const query = buildTavilyPatentQuery({ query: 'test', patent_office: 'US' });
      expect(query).toContain('patent US');
    });

    it('should not include patent office for "all"', () => {
      const query = buildTavilyPatentQuery({ query: 'test', patent_office: 'all' });
      expect(query).not.toContain('patent all');
    });

    it('should include assignee with variations', () => {
      const query = buildTavilyPatentQuery({ query: 'test', assignee: 'Rapt Media' });
      expect(query).toContain('Rapt Media');
      expect(query).toContain('raptmedia');
    });

    it('should include inventor as quoted phrase', () => {
      const query = buildTavilyPatentQuery({ query: 'test', inventor: 'John Smith' });
      expect(query).toContain('"John Smith"');
    });

    it('should include CPC code as quoted phrase', () => {
      const query = buildTavilyPatentQuery({ query: 'test', cpc_code: 'G06F' });
      expect(query).toContain('"G06F"');
    });

    it('should include year range when both years specified', () => {
      const query = buildTavilyPatentQuery({ query: 'test', year_from: 2020, year_to: 2024 });
      expect(query).toContain('2020..2024');
    });

    it('should include year range with defaults when only year_from specified', () => {
      const query = buildTavilyPatentQuery({ query: 'test', year_from: 2020 });
      expect(query).toContain('2020..');
    });

    it('should combine all parameters', () => {
      const query = buildTavilyPatentQuery({
        query: 'neural network',
        patent_office: 'EP',
        assignee: 'Google',
        inventor: 'Jane Doe',
        cpc_code: 'H04L',
        year_from: 2019,
        year_to: 2023,
      });
      expect(query).toContain('neural network');
      expect(query).toContain('patent EP');
      expect(query).toContain('"Jane Doe"');
      expect(query).toContain('"H04L"');
      expect(query).toContain('2019..2023');
    });
  });

  // ── parseTavilyPatentResult tests ───────────────────────────────────────

  describe('parseTavilyPatentResult', () => {
    it('should parse a valid patent result', () => {
      const result = parseTavilyPatentResult({
        title: 'Method for AI - Google Patents',
        url: 'https://patents.google.com/patent/US1234567B2/en',
        content: 'Inventors: Alice Smith. A method for artificial intelligence...',
      });

      expect(result).not.toBeNull();
      expect(result!.patentNumber).toBe('US1234567B2');
      expect(result!.title).toBe('Method for AI');
      expect(result!.patentOffice).toBe('US');
      expect(result!.pdfUrl).toBe('https://patents.google.com/patent/US1234567B2/pdf');
      expect(result!.inventors).toContain('Alice Smith');
    });

    it('should return null for non-patent URLs', () => {
      const result = parseTavilyPatentResult({
        title: 'Scholar page',
        url: 'https://patents.google.com/scholar?q=test',
        content: 'Some content',
      });

      expect(result).toBeNull();
    });

    it('should return null for non-Google Patents URLs', () => {
      const result = parseTavilyPatentResult({
        title: 'Some page',
        url: 'https://example.com/patent/US1234567B2',
        content: 'Some content',
      });

      expect(result).toBeNull();
    });

    it('should extract assignee from snippet', () => {
      const result = parseTavilyPatentResult({
        title: 'Test Patent',
        url: 'https://patents.google.com/patent/US9876543B1',
        content: 'Assignee: Google LLC. This patent covers...',
      });

      expect(result).not.toBeNull();
      expect(result!.assignee).toBe('Google LLC');
    });

    it('should extract year from snippet as publicationDate', () => {
      const result = parseTavilyPatentResult({
        title: 'Test Patent',
        url: 'https://patents.google.com/patent/EP1234567A1',
        content: 'Filed in 2021. This patent describes...',
      });

      expect(result).not.toBeNull();
      expect(result!.publicationDate).toBe('2021');
    });

    it('should clean Google Patents suffix from title', () => {
      const result = parseTavilyPatentResult({
        title: 'My Invention - Google Patents',
        url: 'https://patents.google.com/patent/WO2023123456A1',
        content: 'Content',
      });

      expect(result).not.toBeNull();
      expect(result!.title).toBe('My Invention');
    });
  });

  // ── handleTavilyPatentSearch (via handlePatentSearch) ───────────────────

  describe('handlePatentSearch with Tavily provider', () => {
    it('should return error when TAVILY_API_KEY is missing', async () => {
      delete process.env.TAVILY_API_KEY;
      process.env.SEARCH_PROVIDER = 'tavily';

      const result = await handlePatentSearch({ query: 'machine learning' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Missing TAVILY_API_KEY');
      expect(result.structuredContent.patents).toEqual([]);
      expect(result.structuredContent.resultCount).toBe(0);
      expect(result.structuredContent.source).toBe('Tavily (Google Patents)');
    });

    it('should return patents on successful Tavily search', async () => {
      mockSearch.mockResolvedValue({
        results: [
          {
            title: 'Neural Network Method - Google Patents',
            url: 'https://patents.google.com/patent/US9876543B2/en',
            content: 'Inventors: John Doe. A method for neural network training in 2022...',
            score: 0.95,
          },
          {
            title: 'AI System - Google Patents',
            url: 'https://patents.google.com/patent/EP1234567A1',
            content: 'Assignee: DeepMind Inc. An artificial intelligence system...',
            score: 0.88,
          },
        ],
      });

      const result = await handlePatentSearch({
        query: 'neural network training',
        num_results: 5,
      });

      expect(result.isError).toBeUndefined();
      expect(result.structuredContent.patents).toHaveLength(2);
      expect(result.structuredContent.patents[0].patentNumber).toBe('US9876543B2');
      expect(result.structuredContent.patents[1].patentNumber).toBe('EP1234567A1');
      expect(result.structuredContent.source).toBe('Tavily (Google Patents)');
      expect(result.structuredContent.searchType).toBe('prior_art');
    });

    it('should call Tavily with include_domains for patents.google.com', async () => {
      mockSearch.mockResolvedValue({ results: [] });

      await handlePatentSearch({ query: 'test patent' });

      expect(mockSearch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          includeDomains: ['patents.google.com'],
          searchDepth: 'advanced',
        }),
      );
    });

    it('should pass num_results as maxResults to Tavily', async () => {
      mockSearch.mockResolvedValue({ results: [] });

      await handlePatentSearch({ query: 'test', num_results: 8 });

      expect(mockSearch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          maxResults: 8,
        }),
      );
    });

    it('should handle Tavily network errors gracefully', async () => {
      mockSearch.mockRejectedValue(new Error('Tavily API request failed'));

      const result = await handlePatentSearch({ query: 'test' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Tavily API request failed');
      expect(result.structuredContent.patents).toEqual([]);
      expect(result.structuredContent.source).toBe('Tavily (Google Patents)');
    });

    it('should skip non-patent URLs in Tavily results', async () => {
      mockSearch.mockResolvedValue({
        results: [
          {
            title: 'Valid Patent',
            url: 'https://patents.google.com/patent/US1234567B2',
            content: 'Patent content',
          },
          {
            title: 'Non-patent page',
            url: 'https://patents.google.com/scholar?q=test',
            content: 'Scholar results',
          },
        ],
      });

      const result = await handlePatentSearch({ query: 'test' });

      expect(result.structuredContent.patents).toHaveLength(1);
      expect(result.structuredContent.patents[0].patentNumber).toBe('US1234567B2');
    });

    it('should preserve search_type in Tavily response', async () => {
      mockSearch.mockResolvedValue({ results: [] });

      const result = await handlePatentSearch({
        query: 'test',
        search_type: 'landscape',
      });

      expect(result.structuredContent.searchType).toBe('landscape');
    });

    it('should trim query whitespace in Tavily response', async () => {
      mockSearch.mockResolvedValue({ results: [] });

      const result = await handlePatentSearch({ query: '  test query  ' });

      expect(result.structuredContent.query).toBe('test query');
    });

    it('should return empty patents array when Tavily returns no results', async () => {
      mockSearch.mockResolvedValue({ results: [] });

      const result = await handlePatentSearch({ query: 'nonexistent patent xyz' });

      expect(result.structuredContent.patents).toEqual([]);
      expect(result.structuredContent.resultCount).toBe(0);
    });
  });
});
