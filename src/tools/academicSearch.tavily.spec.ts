/**
 * Tests for Academic Paper Search Tool — Tavily code path
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';

// Mock @tavily/core before importing the module under test
const mockSearch = jest.fn();
jest.unstable_mockModule('@tavily/core', () => ({
  tavily: jest.fn(() => ({ search: mockSearch })),
}));

// Dynamic import so the mock is in place
const {
  handleAcademicSearch,
  extractAuthorsFromSnippet,
  extractYearFromContent,
  venueFromDomain,
  tavilyResultToPaper,
} = await import('./academicSearch.js');

// Save original env vars
const originalEnv = { ...process.env };

describe('academicSearch — Tavily provider', () => {
  beforeEach(() => {
    process.env.TAVILY_API_KEY = 'tvly-test-key-123';
    process.env.SEARCH_PROVIDER = 'tavily';
    // Clear Google vars so we know it's not using that path
    delete process.env.GOOGLE_CUSTOM_SEARCH_API_KEY;
    delete process.env.GOOGLE_CUSTOM_SEARCH_ID;
    mockSearch.mockReset();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    jest.restoreAllMocks();
  });

  // ── Routing tests ───────────────────────────────────────────────────────────

  describe('provider routing', () => {
    it('should route to Tavily when SEARCH_PROVIDER=tavily and TAVILY_API_KEY set', async () => {
      mockSearch.mockResolvedValue({ results: [] });

      const result = await handleAcademicSearch({ query: 'machine learning' });

      expect(mockSearch).toHaveBeenCalled();
      expect(result.isError).toBeUndefined();
      expect(result.structuredContent.papers).toEqual([]);
    });

    it('should route to Tavily when SEARCH_PROVIDER=parallel and TAVILY_API_KEY set', async () => {
      process.env.SEARCH_PROVIDER = 'parallel';
      mockSearch.mockResolvedValue({ results: [] });

      const result = await handleAcademicSearch({ query: 'neural networks' });

      expect(mockSearch).toHaveBeenCalled();
      expect(result.isError).toBeUndefined();
    });

    it('should NOT route to Tavily when TAVILY_API_KEY is missing', async () => {
      delete process.env.TAVILY_API_KEY;
      // No Google creds either → should return missing-creds error
      const result = await handleAcademicSearch({ query: 'test' });

      expect(mockSearch).not.toHaveBeenCalled();
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Missing Google API credentials');
    });
  });

  // ── tavilyResultToPaper mapping tests ───────────────────────────────────────

  describe('tavilyResultToPaper', () => {
    it('should map title, url, and content correctly', () => {
      const paper = tavilyResultToPaper({
        title: 'Deep Learning for NLP',
        url: 'https://arxiv.org/abs/2301.12345',
        content: 'by John Smith - 2023 - This paper presents a novel approach to NLP using deep learning techniques and transformer architectures.',
        score: 0.95,
      });

      expect(paper.title).toBe('Deep Learning for NLP');
      expect(paper.url).toBe('https://arxiv.org/abs/2301.12345');
      expect(paper.authors).toEqual(['John Smith']);
      expect(paper.year).toBe(2023);
    });

    it('should extract arXiv ID from URL', () => {
      const paper = tavilyResultToPaper({
        title: 'Test Paper',
        url: 'https://arxiv.org/abs/2301.12345v2',
        content: 'Some content about the paper that is long enough to be an abstract.',
        score: 0.9,
      });

      expect(paper.arxivId).toBe('2301.12345v2');
    });

    it('should extract DOI from URL', () => {
      const paper = tavilyResultToPaper({
        title: 'Test Paper',
        url: 'https://doi.org/10.1038/s41586-023-06747-5',
        content: 'Some content about the paper that is long enough to be an abstract.',
        score: 0.9,
      });

      expect(paper.doi).toBe('10.1038/s41586-023-06747-5');
    });

    it('should generate PDF URL for arXiv abs pages', () => {
      const paper = tavilyResultToPaper({
        title: 'Test Paper',
        url: 'https://arxiv.org/abs/2301.12345',
        content: 'Content.',
        score: 0.9,
      });

      expect(paper.pdfUrl).toBe('https://arxiv.org/pdf/2301.12345.pdf');
    });

    it('should detect direct PDF URLs', () => {
      const paper = tavilyResultToPaper({
        title: 'Test Paper',
        url: 'https://example.com/paper.pdf',
        content: 'Content.',
        score: 0.9,
      });

      expect(paper.pdfUrl).toBe('https://example.com/paper.pdf');
    });

    it('should use publishedDate for year when available', () => {
      const paper = tavilyResultToPaper({
        title: 'Test Paper',
        url: 'https://nature.com/articles/123',
        content: 'No year in content.',
        score: 0.9,
        publishedDate: '2024-03-15',
      });

      expect(paper.year).toBe(2024);
    });

    it('should clean title by removing site name suffixes', () => {
      const paper = tavilyResultToPaper({
        title: 'Deep Learning Methods - arXiv preprint',
        url: 'https://arxiv.org/abs/2301.12345',
        content: 'Content.',
        score: 0.9,
      });

      expect(paper.title).toBe('Deep Learning Methods');
    });

    it('should generate citations', () => {
      const paper = tavilyResultToPaper({
        title: 'Test Paper',
        url: 'https://arxiv.org/abs/2301.12345',
        content: 'by Alice Smith - 2023 - Test abstract content that is long enough to count as an abstract for our purposes.',
        score: 0.9,
      });

      expect(paper.citations.apa).toContain('Test Paper');
      expect(paper.citations.mla).toContain('"Test Paper."');
      expect(paper.citations.bibtex).toContain('@article{');
    });
  });

  // ── extractAuthorsFromSnippet tests ─────────────────────────────────────────

  describe('extractAuthorsFromSnippet', () => {
    it('should extract single author from "by Author -" pattern', () => {
      expect(extractAuthorsFromSnippet('by John Smith - 2023 - Some text'))
        .toEqual(['John Smith']);
    });

    it('should extract multiple authors separated by commas', () => {
      expect(extractAuthorsFromSnippet('by Alice Smith, Bob Jones - 2023'))
        .toEqual(['Alice Smith', 'Bob Jones']);
    });

    it('should extract authors separated by "and"', () => {
      expect(extractAuthorsFromSnippet('by Alice Smith and Bob Jones - 2023'))
        .toEqual(['Alice Smith', 'Bob Jones']);
    });

    it('should return Unknown Author when no pattern matches', () => {
      expect(extractAuthorsFromSnippet('No author pattern here'))
        .toEqual(['Unknown Author']);
    });
  });

  // ── extractYearFromContent tests ────────────────────────────────────────────

  describe('extractYearFromContent', () => {
    it('should prefer publishedDate', () => {
      expect(extractYearFromContent('content 2020', 'https://example.com', '2023-01-15'))
        .toBe(2023);
    });

    it('should extract year from content when no publishedDate', () => {
      expect(extractYearFromContent('Published in 2022, this paper...', 'https://example.com'))
        .toBe(2022);
    });

    it('should extract year from URL path', () => {
      expect(extractYearFromContent('no year here', 'https://example.com/2021/paper'))
        .toBe(2021);
    });

    it('should return undefined when no year found', () => {
      expect(extractYearFromContent('no year', 'https://example.com/paper'))
        .toBeUndefined();
    });
  });

  // ── venueFromDomain tests ─────────────────────────────────────────────────

  describe('venueFromDomain', () => {
    it('should map arxiv.org to arXiv', () => {
      expect(venueFromDomain('https://arxiv.org/abs/123')).toBe('arXiv');
    });

    it('should map ieee.org to IEEE', () => {
      expect(venueFromDomain('https://ieee.org/paper')).toBe('IEEE');
    });

    it('should map nature.com to Nature', () => {
      expect(venueFromDomain('https://nature.com/articles/123')).toBe('Nature');
    });

    it('should capitalize unknown domains', () => {
      expect(venueFromDomain('https://example.com/paper')).toBe('Example');
    });

    it('should return Unknown for invalid URLs', () => {
      expect(venueFromDomain('not-a-url')).toBe('Unknown');
    });
  });

  // ── Year post-filtering tests ───────────────────────────────────────────────

  describe('year post-filtering', () => {
    const makeTavilyResults = (years: (number | null)[]) => ({
      results: years.map((y, i) => ({
        title: `Paper ${i}`,
        url: `https://arxiv.org/abs/2301.${String(i).padStart(5, '0')}`,
        content: y ? `Published in ${y}, this paper explores...` : 'No year information in this content.',
        score: 0.9,
      })),
    });

    it('should keep papers within year range', async () => {
      mockSearch.mockResolvedValue(makeTavilyResults([2020, 2022, 2024]));

      const result = await handleAcademicSearch({
        query: 'test',
        year_from: 2021,
        year_to: 2023,
      });

      expect(result.structuredContent.papers).toHaveLength(1);
      expect(result.structuredContent.papers[0].year).toBe(2022);
    });

    it('should drop papers with unknown year when year filter is active', async () => {
      mockSearch.mockResolvedValue(makeTavilyResults([2022, null]));

      const result = await handleAcademicSearch({
        query: 'test',
        year_from: 2020,
      });

      // The null-year paper should be dropped
      expect(result.structuredContent.papers).toHaveLength(1);
      expect(result.structuredContent.papers[0].year).toBe(2022);
    });

    it('should keep all papers when no year filter is set', async () => {
      mockSearch.mockResolvedValue(makeTavilyResults([2022, null]));

      const result = await handleAcademicSearch({ query: 'test' });

      expect(result.structuredContent.papers).toHaveLength(2);
    });
  });

  // ── pdf_only post-filtering ─────────────────────────────────────────────────

  describe('pdf_only filtering', () => {
    it('should filter to only papers with PDF URLs when pdf_only=true', async () => {
      mockSearch.mockResolvedValue({
        results: [
          {
            title: 'Paper with PDF',
            url: 'https://arxiv.org/abs/2301.12345',
            content: 'by Author - 2023 - Content long enough for abstract purposes here.',
            score: 0.9,
          },
          {
            title: 'Paper without PDF',
            url: 'https://nature.com/articles/abc',
            content: 'by Author - 2023 - Content long enough for abstract purposes here.',
            score: 0.8,
          },
        ],
      });

      const result = await handleAcademicSearch({
        query: 'test',
        pdf_only: true,
      });

      // Only the arXiv paper has a generated PDF URL
      expect(result.structuredContent.papers).toHaveLength(1);
      expect(result.structuredContent.papers[0].pdfUrl).toBeDefined();
    });
  });

  // ── Error propagation ──────────────────────────────────────────────────────

  describe('error handling', () => {
    it('should propagate Tavily client errors gracefully', async () => {
      mockSearch.mockRejectedValue(new Error('Tavily API rate limit exceeded'));

      const result = await handleAcademicSearch({ query: 'test' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Tavily API rate limit exceeded');
    });

    it('should handle empty results from Tavily', async () => {
      mockSearch.mockResolvedValue({ results: [] });

      const result = await handleAcademicSearch({ query: 'very obscure topic' });

      expect(result.isError).toBeUndefined();
      expect(result.structuredContent.papers).toEqual([]);
      expect(result.structuredContent.resultCount).toBe(0);
    });
  });

  // ── Tavily search parameters ───────────────────────────────────────────────

  describe('Tavily search parameters', () => {
    it('should pass academic domains as includeDomains for source=all', async () => {
      mockSearch.mockResolvedValue({ results: [] });

      await handleAcademicSearch({ query: 'test', source: 'all' });

      expect(mockSearch).toHaveBeenCalledWith('test', expect.objectContaining({
        searchDepth: 'advanced',
        topic: 'general',
        includeDomains: expect.arrayContaining(['arxiv.org', 'pubmed.ncbi.nlm.nih.gov']),
      }));
    });

    it('should pass source-specific domains for source=arxiv', async () => {
      mockSearch.mockResolvedValue({ results: [] });

      await handleAcademicSearch({ query: 'test', source: 'arxiv' });

      expect(mockSearch).toHaveBeenCalledWith('test', expect.objectContaining({
        includeDomains: ['arxiv.org'],
      }));
    });

    it('should respect num_results parameter', async () => {
      mockSearch.mockResolvedValue({ results: [] });

      await handleAcademicSearch({ query: 'test', num_results: 3 });

      expect(mockSearch).toHaveBeenCalledWith('test', expect.objectContaining({
        maxResults: 3,
      }));
    });
  });
});
