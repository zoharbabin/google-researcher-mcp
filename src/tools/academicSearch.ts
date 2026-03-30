/**
 * Academic Paper Search Tool
 *
 * Searches academic papers using Google Custom Search API with
 * site filters for academic sources (arXiv, PubMed, IEEE, etc.).
 *
 * Uses the same Google API credentials as other search tools.
 *
 * Returns:
 * - Paper titles, authors, abstracts
 * - Publication years and venues
 * - PDF URLs (when available)
 * - Pre-formatted citations (APA, MLA, BibTeX)
 */

import { z } from 'zod';
import { tavily } from '@tavily/core';
import { getErrorMessage, GoogleSearchResponse, GoogleSearchItem } from '../types/googleApi.js';

// ── Constants ────────────────────────────────────────────────────────────────

/** Google Custom Search API base URL */
const GOOGLE_SEARCH_API = 'https://www.googleapis.com/customsearch/v1';

/** Request timeout in milliseconds */
const API_TIMEOUT_MS = 15_000;

/** Academic source domains for site filtering */
const ACADEMIC_SITES = [
  'arxiv.org',
  'pubmed.ncbi.nlm.nih.gov',
  'scholar.google.com',
  'ieee.org',
  'acm.org',
  'nature.com',
  'sciencedirect.com',
  'springer.com',
  'researchgate.net',
  'semanticscholar.org',
  'biorxiv.org',
  'medrxiv.org',
  'plos.org',
  'frontiersin.org',
  'mdpi.com',
  'wiley.com',
  'tandfonline.com',
  'sagepub.com',
  'jstor.org',
  'ncbi.nlm.nih.gov',
];

// ── Types ────────────────────────────────────────────────────────────────────

/**
 * Formatted citations for a paper
 */
export interface FormattedCitations {
  apa: string;
  mla: string;
  bibtex: string;
}

/**
 * Processed paper result for output
 */
export interface AcademicPaperResult {
  title: string;
  authors: string[];
  year?: number;
  venue?: string;
  abstract?: string;
  url: string;
  pdfUrl?: string;
  doi?: string;
  arxivId?: string;
  source: string;
  citations: FormattedCitations;
}

// ── Input Schema ─────────────────────────────────────────────────────────────

/**
 * Input schema for academic_search tool
 */
export const academicSearchInputSchema = {
  /** Search query for academic papers */
  query: z.string().min(1).max(500)
    .describe('Search query for academic papers'),

  /** Number of results to return (1-10) */
  num_results: z.number().int().min(1).max(10).default(5)
    .describe('Number of papers to return (1-10, default: 5)'),

  /** Filter by publication year (from) */
  year_from: z.number().int().min(1900).max(2030).optional()
    .describe('Only include papers published in or after this year'),

  /** Filter by publication year (to) */
  year_to: z.number().int().min(1900).max(2030).optional()
    .describe('Only include papers published in or before this year'),

  /** Specific academic source to search */
  source: z.enum(['all', 'arxiv', 'pubmed', 'ieee', 'nature', 'springer']).default('all')
    .describe('Limit search to specific academic source (default: all sources)'),

  /** Search for PDFs only */
  pdf_only: z.boolean().default(false)
    .describe('Only return results with PDF links'),

  /** Sort order */
  sort_by: z.enum(['relevance', 'date']).default('relevance')
    .describe('Sort by relevance or publication date (most recent first)'),
};

// ── Output Schema ────────────────────────────────────────────────────────────

/**
 * Output schema for academic_search tool
 */
export const academicSearchOutputSchema = {
  /** Array of academic papers */
  papers: z.array(z.object({
    title: z.string().describe('Paper title'),
    authors: z.array(z.string()).describe('List of author names'),
    year: z.number().int().optional().describe('Publication year'),
    venue: z.string().optional().describe('Journal or conference name'),
    abstract: z.string().optional().describe('Paper abstract or description'),
    url: z.string().url().describe('URL to paper page'),
    pdfUrl: z.string().url().optional().describe('Direct URL to PDF'),
    doi: z.string().optional().describe('Digital Object Identifier'),
    arxivId: z.string().optional().describe('arXiv identifier'),
    source: z.string().describe('Academic source domain'),
    citations: z.object({
      apa: z.string().describe('APA 7th edition format'),
      mla: z.string().describe('MLA 9th edition format'),
      bibtex: z.string().describe('BibTeX format'),
    }).describe('Pre-formatted citations'),
  })).describe('List of academic papers'),

  /** Original search query */
  query: z.string().describe('The search query that was executed'),

  /** Total results found */
  totalResults: z.number().int().describe('Total papers matching query'),

  /** Number of results returned */
  resultCount: z.number().int().describe('Number of papers returned'),

  /** Data source */
  source: z.literal('Google Scholar Search').describe('Data source'),
};

// ── Output Type ──────────────────────────────────────────────────────────────

export interface AcademicSearchOutput {
  papers: AcademicPaperResult[];
  query: string;
  totalResults: number;
  resultCount: number;
  source: 'Google Scholar Search';
  [key: string]: unknown; // Index signature for MCP SDK compatibility
}

// ── Metadata Extraction ──────────────────────────────────────────────────────

/**
 * Extracts authors from Google search result snippet or title
 */
function extractAuthors(item: GoogleSearchItem): string[] {
  const authors: string[] = [];

  // Try pagemap metatags for author info
  const metatags = item.pagemap?.metatags?.[0];
  if (metatags) {
    const authorMeta = metatags['citation_author'] ||
                       metatags['author'] ||
                       metatags['dc.creator'];
    if (authorMeta) {
      // Handle comma or semicolon separated authors
      return authorMeta.split(/[,;]/).map((a: string) => a.trim()).filter(Boolean);
    }
  }

  // Try to extract from snippet patterns like "by Author Name - 2023"
  const snippet = item.snippet || '';
  const byMatch = snippet.match(/^by\s+([^-–—]+?)(?:\s*[-–—]|$)/i);
  if (byMatch) {
    const authorStr = byMatch[1].trim();
    // Split on common separators
    const authorList = authorStr.split(/,\s*(?:and\s+)?|\s+and\s+/i);
    authors.push(...authorList.map(a => a.trim()).filter(a => a && a.length < 50));
  }

  // Try title pattern for arXiv-style "[Author et al.]"
  const etAlMatch = item.title.match(/\[([^\]]+(?:et al\.?)?)\]/i);
  if (etAlMatch) {
    authors.push(etAlMatch[1].trim());
  }

  return authors.length > 0 ? authors : ['Unknown Author'];
}

/**
 * Extracts publication year from Google search result
 */
function extractYear(item: GoogleSearchItem): number | undefined {
  // Try pagemap metatags
  const metatags = item.pagemap?.metatags?.[0];
  if (metatags) {
    const dateMeta = metatags['citation_publication_date'] ||
                     metatags['citation_date'] ||
                     metatags['dc.date'] ||
                     metatags['article:published_time'];
    if (dateMeta) {
      const yearMatch = dateMeta.match(/(\d{4})/);
      if (yearMatch) return parseInt(yearMatch[1], 10);
    }
  }

  // Try snippet for year patterns
  const snippet = item.snippet || '';
  const yearMatch = snippet.match(/\b(19|20)\d{2}\b/);
  if (yearMatch) {
    const year = parseInt(yearMatch[0], 10);
    if (year >= 1900 && year <= new Date().getFullYear() + 1) {
      return year;
    }
  }

  return undefined;
}

/**
 * Extracts venue/journal from Google search result
 */
function extractVenue(item: GoogleSearchItem): string | undefined {
  const metatags = item.pagemap?.metatags?.[0];
  if (metatags) {
    return metatags['citation_journal_title'] ||
           metatags['og:site_name'] ||
           metatags['dc.publisher'];
  }

  // Use display link as fallback venue
  const domain = item.displayLink.replace(/^www\./, '');
  const siteName = domain.split('.')[0];

  // Map domain to friendly venue names
  const venueMap: Record<string, string> = {
    'arxiv': 'arXiv',
    'pubmed': 'PubMed',
    'ieee': 'IEEE',
    'acm': 'ACM Digital Library',
    'nature': 'Nature',
    'sciencedirect': 'ScienceDirect',
    'springer': 'Springer',
    'researchgate': 'ResearchGate',
    'biorxiv': 'bioRxiv',
    'medrxiv': 'medRxiv',
    'plos': 'PLOS',
    'frontiersin': 'Frontiers',
    'mdpi': 'MDPI',
    'wiley': 'Wiley',
    'jstor': 'JSTOR',
    'ncbi': 'NCBI',
  };

  return venueMap[siteName.toLowerCase()] || siteName.charAt(0).toUpperCase() + siteName.slice(1);
}

/**
 * Extracts DOI from Google search result
 */
function extractDOI(item: GoogleSearchItem): string | undefined {
  const metatags = item.pagemap?.metatags?.[0];
  if (metatags) {
    const doi = metatags['citation_doi'] || metatags['dc.identifier'];
    if (doi && doi.includes('10.')) {
      // Clean DOI format
      const doiMatch = doi.match(/10\.\d{4,}\/[^\s]+/);
      return doiMatch ? doiMatch[0] : undefined;
    }
  }

  // Try to extract from URL
  const doiUrlMatch = item.link.match(/doi\.org\/(10\.\d{4,}\/[^\s?#]+)/);
  if (doiUrlMatch) return doiUrlMatch[1];

  return undefined;
}

/**
 * Extracts arXiv ID from URL or metadata
 */
function extractArxivId(item: GoogleSearchItem): string | undefined {
  // Try URL pattern
  const arxivMatch = item.link.match(/arxiv\.org\/(?:abs|pdf)\/(\d{4}\.\d{4,5}(?:v\d+)?)/i);
  if (arxivMatch) return arxivMatch[1];

  // Try pagemap
  const metatags = item.pagemap?.metatags?.[0];
  if (metatags?.['citation_arxiv_id']) {
    return metatags['citation_arxiv_id'];
  }

  return undefined;
}

/**
 * Validates that a string is a valid URL
 */
function isValidUrl(str: string): boolean {
  try {
    new URL(str);
    return true;
  } catch {
    return false;
  }
}

/**
 * Extracts PDF URL from Google search result
 */
function extractPdfUrl(item: GoogleSearchItem): string | undefined {
  // Direct PDF links
  if (item.link.endsWith('.pdf') && isValidUrl(item.link)) {
    return item.link;
  }

  // arXiv PDF conversion
  if (item.link.includes('arxiv.org/abs/')) {
    const pdfUrl = item.link.replace('/abs/', '/pdf/') + '.pdf';
    if (isValidUrl(pdfUrl)) return pdfUrl;
  }

  // Try pagemap for PDF link
  const metatags = item.pagemap?.metatags?.[0];
  if (metatags?.['citation_pdf_url']) {
    const pdfUrl = metatags['citation_pdf_url'];
    if (isValidUrl(pdfUrl)) return pdfUrl;
  }

  return undefined;
}

/**
 * Gets abstract/description from search result
 */
function extractAbstract(item: GoogleSearchItem): string | undefined {
  const metatags = item.pagemap?.metatags?.[0];
  if (metatags) {
    const description = metatags['og:description'] ||
                        metatags['description'] ||
                        metatags['dc.description'];
    if (description && description.length > 50) {
      return description;
    }
  }

  // Use snippet as fallback
  if (item.snippet && item.snippet.length > 50) {
    return item.snippet;
  }

  return undefined;
}

// ── Citation Formatting ──────────────────────────────────────────────────────

/**
 * Formats author names for APA style (Last, F. M.)
 */
function formatAuthorsAPA(authors: string[]): string {
  if (authors.length === 0 || (authors.length === 1 && authors[0] === 'Unknown Author')) {
    return 'Unknown Author';
  }
  if (authors.length === 1) return formatSingleAuthorAPA(authors[0]);
  if (authors.length === 2) {
    return `${formatSingleAuthorAPA(authors[0])} & ${formatSingleAuthorAPA(authors[1])}`;
  }
  // 3+ authors: First author et al.
  return `${formatSingleAuthorAPA(authors[0])} et al.`;
}

function formatSingleAuthorAPA(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0];
  const lastName = parts[parts.length - 1];
  const initials = parts.slice(0, -1).map(p => p[0]?.toUpperCase() + '.').join(' ');
  return `${lastName}, ${initials}`;
}

/**
 * Formats author names for MLA style (Last, First)
 */
function formatAuthorsMLA(authors: string[]): string {
  if (authors.length === 0 || (authors.length === 1 && authors[0] === 'Unknown Author')) {
    return 'Unknown Author';
  }
  if (authors.length === 1) return formatSingleAuthorMLA(authors[0]);
  if (authors.length === 2) {
    return `${formatSingleAuthorMLA(authors[0])}, and ${authors[1]}`;
  }
  // 3+ authors
  return `${formatSingleAuthorMLA(authors[0])}, et al.`;
}

function formatSingleAuthorMLA(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0];
  const lastName = parts[parts.length - 1];
  const firstName = parts.slice(0, -1).join(' ');
  return `${lastName}, ${firstName}`;
}

/**
 * Formats authors for BibTeX
 */
function formatAuthorsBibTeX(authors: string[]): string {
  if (authors.length === 0 || (authors.length === 1 && authors[0] === 'Unknown Author')) {
    return 'Unknown Author';
  }
  return authors.join(' and ');
}

/**
 * Creates a BibTeX key from title and year
 */
function createBibTeXKey(title: string, year?: number): string {
  const firstWord = title.split(/\s+/)[0]?.toLowerCase().replace(/[^a-z]/g, '') || 'unknown';
  return `${firstWord}${year || 'unknown'}`;
}

/**
 * Generates formatted citations for a paper
 */
function generateCitations(paper: {
  title: string;
  authors: string[];
  year?: number;
  venue?: string;
  doi?: string;
  url: string;
}): FormattedCitations {
  const { authors, year, title, venue, doi, url } = paper;

  // APA 7th Edition
  let apa = `${formatAuthorsAPA(authors)} (${year || 'n.d.'}). ${title}. `;
  if (venue) {
    apa += `*${venue}*. `;
  }
  if (doi) {
    apa += `https://doi.org/${doi}`;
  } else {
    apa += url;
  }

  // MLA 9th Edition
  let mla = `${formatAuthorsMLA(authors)}. "${title}." `;
  if (venue) {
    mla += `*${venue}*, `;
  }
  if (year) {
    mla += `${year}`;
  }
  if (doi) {
    mla += `, https://doi.org/${doi}`;
  }
  mla += '.';

  // BibTeX
  const bibtexKey = createBibTeXKey(title, year);
  let bibtex = `@article{${bibtexKey},\n`;
  bibtex += `  title = {${title}},\n`;
  bibtex += `  author = {${formatAuthorsBibTeX(authors)}},\n`;
  if (year) bibtex += `  year = {${year}},\n`;
  if (venue) bibtex += `  journal = {${venue}},\n`;
  if (doi) bibtex += `  doi = {${doi}},\n`;
  bibtex += `  url = {${url}},\n`;
  bibtex += `}`;

  return { apa, mla, bibtex };
}

// ── Tavily Helpers ───────────────────────────────────────────────────────────

/** Domain subsets for source-specific Tavily queries */
const TAVILY_SOURCE_DOMAINS: Record<string, string[]> = {
  'arxiv': ['arxiv.org'],
  'pubmed': ['pubmed.ncbi.nlm.nih.gov', 'ncbi.nlm.nih.gov'],
  'ieee': ['ieee.org', 'ieeexplore.ieee.org'],
  'nature': ['nature.com'],
  'springer': ['springer.com', 'link.springer.com'],
};

/**
 * Tavily search result type (subset of fields we use)
 */
interface TavilySearchResult {
  title: string;
  url: string;
  content: string;
  score: number;
  publishedDate?: string;
}

/**
 * Extracts authors from a Tavily result content snippet
 */
function extractAuthorsFromSnippet(content: string): string[] {
  // Try "by Author Name - 2023" pattern
  const byMatch = content.match(/^by\s+([^-–—]+?)(?:\s*[-–—]|$)/i);
  if (byMatch) {
    const authorStr = byMatch[1].trim();
    const authorList = authorStr.split(/,\s*(?:and\s+)?|\s+and\s+/i);
    const authors = authorList.map(a => a.trim()).filter(a => a && a.length < 50);
    if (authors.length > 0) return authors;
  }
  return ['Unknown Author'];
}

/**
 * Extracts publication year from content or URL
 */
function extractYearFromContent(content: string, url: string, publishedDate?: string): number | undefined {
  if (publishedDate) {
    const yearMatch = publishedDate.match(/(\d{4})/);
    if (yearMatch) return parseInt(yearMatch[1], 10);
  }
  const yearMatch = content.match(/\b(19|20)\d{2}\b/);
  if (yearMatch) {
    const year = parseInt(yearMatch[0], 10);
    if (year >= 1900 && year <= new Date().getFullYear() + 1) return year;
  }
  const urlYearMatch = url.match(/\/(\d{4})\//);
  if (urlYearMatch) {
    const year = parseInt(urlYearMatch[1], 10);
    if (year >= 1900 && year <= new Date().getFullYear() + 1) return year;
  }
  return undefined;
}

/**
 * Determines venue name from a URL domain
 */
function venueFromDomain(url: string): string {
  const venueMap: Record<string, string> = {
    'arxiv': 'arXiv',
    'pubmed': 'PubMed',
    'ncbi': 'NCBI',
    'ieee': 'IEEE',
    'acm': 'ACM Digital Library',
    'nature': 'Nature',
    'sciencedirect': 'ScienceDirect',
    'springer': 'Springer',
    'researchgate': 'ResearchGate',
    'biorxiv': 'bioRxiv',
    'medrxiv': 'medRxiv',
    'plos': 'PLOS',
    'frontiersin': 'Frontiers',
    'mdpi': 'MDPI',
    'wiley': 'Wiley',
    'jstor': 'JSTOR',
  };

  try {
    const hostname = new URL(url).hostname.replace(/^www\./, '');
    const siteName = hostname.split('.')[0];
    return venueMap[siteName.toLowerCase()] || siteName.charAt(0).toUpperCase() + siteName.slice(1);
  } catch {
    return 'Unknown';
  }
}

/**
 * Converts a Tavily search result into an AcademicPaperResult
 */
function tavilyResultToPaper(result: TavilySearchResult): AcademicPaperResult {
  const authors = extractAuthorsFromSnippet(result.content);
  const year = extractYearFromContent(result.content, result.url, result.publishedDate);
  const venue = venueFromDomain(result.url);

  // Extract DOI from URL
  const doiUrlMatch = result.url.match(/doi\.org\/(10\.\d{4,}\/[^\s?#]+)/);
  const doi = doiUrlMatch ? doiUrlMatch[1] : undefined;

  // Extract arXiv ID from URL
  const arxivMatch = result.url.match(/arxiv\.org\/(?:abs|pdf)\/(\d{4}\.\d{4,5}(?:v\d+)?)/i);
  const arxivId = arxivMatch ? arxivMatch[1] : undefined;

  // PDF URL
  let pdfUrl: string | undefined;
  if (result.url.endsWith('.pdf')) {
    pdfUrl = result.url;
  } else if (result.url.includes('arxiv.org/abs/')) {
    pdfUrl = result.url.replace('/abs/', '/pdf/') + '.pdf';
  }

  // Clean title
  const title = result.title
    .replace(/\s*[-|]\s*(arXiv|PubMed|IEEE|Nature|Springer|ResearchGate).*$/i, '')
    .replace(/\s*\[.*\]\s*$/, '')
    .trim();

  const abstract = result.content && result.content.length > 50 ? result.content : undefined;

  let hostname: string;
  try {
    hostname = new URL(result.url).hostname;
  } catch {
    hostname = 'unknown';
  }

  return {
    title,
    authors,
    year,
    venue,
    abstract,
    url: result.url,
    pdfUrl,
    doi,
    arxivId,
    source: hostname,
    citations: generateCitations({ title, authors, year, venue, doi, url: result.url }),
  };
}

/**
 * Performs academic search using Tavily
 */
async function searchWithTavily(
  query: string,
  numResults: number,
  source: string,
  yearFrom?: number,
  yearTo?: number,
): Promise<{ papers: AcademicPaperResult[]; totalResults: number }> {
  const tavilyApiKey = process.env.TAVILY_API_KEY!;
  const client = tavily({ apiKey: tavilyApiKey });

  // Determine which domains to include
  const includeDomains = source !== 'all' && TAVILY_SOURCE_DOMAINS[source]
    ? TAVILY_SOURCE_DOMAINS[source]
    : ACADEMIC_SITES;

  const response = await client.search(query, {
    maxResults: Math.min(numResults, 20),
    searchDepth: 'advanced',
    topic: 'general',
    includeDomains: includeDomains,
  });

  let papers = (response.results as TavilySearchResult[]).map(tavilyResultToPaper);

  // Post-filter by year if specified
  if (yearFrom || yearTo) {
    papers = papers.filter(paper => {
      if (!paper.year) return true; // Keep papers without year info
      if (yearFrom && paper.year < yearFrom) return false;
      if (yearTo && paper.year > yearTo) return false;
      return true;
    });
  }

  return { papers, totalResults: papers.length };
}

// ── Handler ──────────────────────────────────────────────────────────────────

/**
 * Input type for academic search handler
 */
export type AcademicSearchInput = {
  query: string;
  num_results?: number;
  year_from?: number;
  year_to?: number;
  source?: 'all' | 'arxiv' | 'pubmed' | 'ieee' | 'nature' | 'springer';
  pdf_only?: boolean;
  sort_by?: 'relevance' | 'date';
};

/**
 * Determines whether to use Tavily based on env vars
 */
function useTavilyProvider(): boolean {
  return !!(
    process.env.TAVILY_API_KEY &&
    process.env.SEARCH_PROVIDER?.toLowerCase() === 'tavily'
  );
}

/**
 * Handler for the academic_search tool
 */
export async function handleAcademicSearch(input: AcademicSearchInput): Promise<{
  content: Array<{ type: 'text'; text: string }>;
  structuredContent: AcademicSearchOutput;
  isError?: boolean;
}> {
  const {
    query,
    num_results = 5,
    year_from,
    year_to,
    source = 'all',
    pdf_only = false,
    sort_by = 'relevance',
  } = input;

  // Determine search provider
  const isTavily = useTavilyProvider();

  if (!isTavily) {
    // Check for required Google environment variables
    const apiKey = process.env.GOOGLE_CUSTOM_SEARCH_API_KEY;
    const searchId = process.env.GOOGLE_CUSTOM_SEARCH_ID;

    if (!apiKey || !searchId) {
      return {
        content: [{ type: 'text', text: 'Academic search failed: Missing Google API credentials (GOOGLE_CUSTOM_SEARCH_API_KEY or GOOGLE_CUSTOM_SEARCH_ID)' }],
        structuredContent: {
          papers: [],
          query: query.trim(),
          totalResults: 0,
          resultCount: 0,
          source: 'Google Scholar Search',
        },
        isError: true,
      };
    }
  }

  try {
    let papers: AcademicPaperResult[];
    let totalResults: number;
    const providerLabel = isTavily ? 'Tavily Academic Search' : 'Google Scholar Search';

    if (isTavily) {
      // ── Tavily code path ────────────────────────────────────────────────
      const result = await searchWithTavily(query.trim(), num_results, source, year_from, year_to);
      papers = result.papers;
      totalResults = result.totalResults;

      // Post-filter for PDF-only if requested
      if (pdf_only) {
        papers = papers.filter(p => p.pdfUrl);
      }
    } else {
      // ── Google code path (existing) ─────────────────────────────────────
      const apiKey = process.env.GOOGLE_CUSTOM_SEARCH_API_KEY!;
      const searchId = process.env.GOOGLE_CUSTOM_SEARCH_ID!;

      // Build search query with site filters
      let searchQuery = query.trim();

      // Add site filter based on source selection
      const siteFilters: Record<string, string> = {
        'arxiv': 'site:arxiv.org',
        'pubmed': 'site:pubmed.ncbi.nlm.nih.gov OR site:ncbi.nlm.nih.gov',
        'ieee': 'site:ieee.org OR site:ieeexplore.ieee.org',
        'nature': 'site:nature.com',
        'springer': 'site:springer.com OR site:link.springer.com',
      };

      if (source !== 'all' && siteFilters[source]) {
        searchQuery = `${searchQuery} ${siteFilters[source]}`;
      } else if (source === 'all') {
        // Search across all academic sites
        const siteQuery = ACADEMIC_SITES.slice(0, 10).map(s => `site:${s}`).join(' OR ');
        searchQuery = `${searchQuery} (${siteQuery})`;
      }

      // Add year filter
      if (year_from || year_to) {
        if (year_from && year_to) {
          searchQuery = `${searchQuery} ${year_from}..${year_to}`;
        } else if (year_from) {
          searchQuery = `${searchQuery} after:${year_from - 1}`;
        } else if (year_to) {
          searchQuery = `${searchQuery} before:${year_to + 1}`;
        }
      }

      // Add PDF filter
      if (pdf_only) {
        searchQuery = `${searchQuery} filetype:pdf`;
      }

      // Build Google Custom Search URL
      const params = new URLSearchParams({
        key: apiKey,
        cx: searchId,
        q: searchQuery,
        num: String(Math.min(num_results, 10)),
      });

      // Add date sorting if requested
      if (sort_by === 'date') {
        params.set('sort', 'date');
      }

      const url = `${GOOGLE_SEARCH_API}?${params.toString()}`;

      // Make API request
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'Accept': 'application/json',
        },
        signal: AbortSignal.timeout(API_TIMEOUT_MS),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Google API error: ${response.status} - ${errorText}`);
      }

      const data = await response.json() as GoogleSearchResponse;

      // Process results
      const items = data.items || [];
      totalResults = parseInt(data.searchInformation?.totalResults || '0', 10);

      // Transform to academic paper format
      papers = items.map(item => {
        const authors = extractAuthors(item);
        const year = extractYear(item);
        const venue = extractVenue(item);
        const doi = extractDOI(item);
        const arxivId = extractArxivId(item);
        const pdfUrl = extractPdfUrl(item);
        const abstract = extractAbstract(item);

        // Clean title (remove site name suffixes)
        let title = item.title
          .replace(/\s*[-|]\s*(arXiv|PubMed|IEEE|Nature|Springer|ResearchGate).*$/i, '')
          .replace(/\s*\[.*\]\s*$/, '')
          .trim();

        return {
          title,
          authors,
          year,
          venue,
          abstract,
          url: item.link,
          pdfUrl,
          doi,
          arxivId,
          source: item.displayLink,
          citations: generateCitations({ title, authors, year, venue, doi, url: item.link }),
        };
      });
    }

    // Build text content
    let textContent = `Academic Search Results for: "${query}"\n`;
    textContent += `Source: ${isTavily ? 'Tavily Academic Search' : 'Google Scholar Search'} (${source === 'all' ? 'all academic sources' : source})\n`;
    textContent += `Found approximately ${totalResults} results, showing ${papers.length}\n\n`;

    papers.forEach((paper, index) => {
      textContent += `--- Paper ${index + 1} ---\n`;
      textContent += `Title: ${paper.title}\n`;
      textContent += `Authors: ${paper.authors.join(', ')}\n`;
      if (paper.year) textContent += `Year: ${paper.year}\n`;
      if (paper.venue) textContent += `Venue: ${paper.venue}\n`;
      textContent += `Source: ${paper.source}\n`;
      if (paper.abstract) {
        const truncatedAbstract = paper.abstract.length > 300
          ? paper.abstract.substring(0, 300) + '...'
          : paper.abstract;
        textContent += `Abstract: ${truncatedAbstract}\n`;
      }
      if (paper.pdfUrl) textContent += `PDF: ${paper.pdfUrl}\n`;
      if (paper.doi) textContent += `DOI: ${paper.doi}\n`;
      if (paper.arxivId) textContent += `arXiv: ${paper.arxivId}\n`;
      textContent += `URL: ${paper.url}\n`;
      textContent += `\nCitation (APA): ${paper.citations.apa}\n\n`;
    });

    const output: AcademicSearchOutput = {
      papers,
      query: query.trim(),
      totalResults,
      resultCount: papers.length,
      source: 'Google Scholar Search',
    };

    return {
      content: [{ type: 'text', text: textContent }],
      structuredContent: output,
    };
  } catch (error) {
    const errorMessage = getErrorMessage(error);
    return {
      content: [{ type: 'text', text: `Academic search failed: ${errorMessage}` }],
      structuredContent: {
        papers: [],
        query: query.trim(),
        totalResults: 0,
        resultCount: 0,
        source: 'Google Scholar Search',
      },
      isError: true,
    };
  }
}
