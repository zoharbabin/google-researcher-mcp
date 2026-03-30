/**
 * Patent Search Tool
 *
 * Searches for patents using Google Custom Search API with site:patents.google.com filter.
 * Supports prior art search, specific patent lookup, and patent landscaping.
 */

import { z } from 'zod';
import { tavily } from '@tavily/core';
import { logger } from '../shared/logger.js';
import type { PatentResultOutput, PatentSearchOutput } from '../schemas/outputSchemas.js';
import type { GoogleSearchItem, GoogleSearchResponse } from '../types/googleApi.js';
import { CPC_SECTIONS, PATENT_OFFICE_PREFIXES, getTechnologyArea } from '../shared/patentConstants.js';

// ── Input Schema ───────────────────────────────────────────────────────────

export const patentSearchInputSchema = {
  query: z.string().min(1).max(500)
    .describe('Patent search query (keywords, patent number, inventor, assignee). TIP: Try company name WITHOUT spaces (e.g., "raptmedia" instead of "Rapt Media") and try previous company names.'),
  num_results: z.number().min(1).max(10).default(5)
    .describe('Number of patents to return (1-10, default: 5)'),
  search_type: z.enum(['prior_art', 'specific', 'landscape']).default('prior_art')
    .describe('Search type: prior_art (find related patents), specific (exact patent), landscape (broad overview)'),
  patent_office: z.enum(['all', 'US', 'EP', 'WO', 'JP', 'CN', 'KR']).optional()
    .describe('Filter by patent office (US=USPTO, EP=EPO, WO=WIPO, JP=JPO, CN=CNIPA, KR=KIPO)'),
  assignee: z.string().max(200).optional()
    .describe('Company name to search for. Automatically tries variations (with/without spaces, Inc/Corp). For better results, also try previous company names in the query.'),
  inventor: z.string().max(200).optional()
    .describe('Inventor name to search for (exact phrase match)'),
  cpc_code: z.string().max(20).optional()
    .describe('CPC classification code to search for (e.g., G06F, H04L)'),
  year_from: z.number().int().min(1900).max(2030).optional()
    .describe('Filter patents from this year onwards'),
  year_to: z.number().int().min(1900).max(2030).optional()
    .describe('Filter patents up to this year'),
};

export type PatentSearchInput = {
  query: string;
  num_results?: number;
  search_type?: 'prior_art' | 'specific' | 'landscape';
  patent_office?: 'all' | 'US' | 'EP' | 'WO' | 'JP' | 'CN' | 'KR';
  assignee?: string;
  inventor?: string;
  cpc_code?: string;
  year_from?: number;
  year_to?: number;
};

// ── Output Schema ──────────────────────────────────────────────────────────

export { patentSearchOutputSchema } from '../schemas/outputSchemas.js';

// ── Helper Functions ───────────────────────────────────────────────────────

/**
 * Generate company name variations for more comprehensive patent searches.
 * Google Custom Search doesn't support structured `assignee:` filters,
 * so we need to search for variations as plain text.
 *
 * @example
 * generateCompanyNameVariations("Rapt Media")
 * // Returns: ["Rapt Media", "raptmedia", "RaptMedia", "Rapt Media Inc", "Rapt Media, Inc."]
 */
export function generateCompanyNameVariations(companyName: string): string[] {
  const name = companyName.trim();
  if (!name) return [];

  const variations = new Set<string>();

  // Original name
  variations.add(name);

  // Remove spaces (e.g., "Rapt Media" → "raptmedia", "RaptMedia")
  const noSpaces = name.replace(/\s+/g, '');
  variations.add(noSpaces.toLowerCase());
  variations.add(noSpaces);

  // Common suffixes to add
  const suffixes = ['Inc', 'Inc.', ', Inc.', ', Inc', 'LLC', 'Corp', 'Corporation'];

  // If name doesn't already have a suffix, add common ones
  const hasSuffix = /(?:Inc\.?|LLC|Corp(?:oration)?|Ltd\.?|GmbH|Co\.?)$/i.test(name);
  if (!hasSuffix) {
    variations.add(`${name} Inc`);
    variations.add(`${name}, Inc.`);
  }

  // Remove common suffixes to get base name
  const baseName = name
    .replace(/[,\s]*(Inc\.?|LLC|Corp(?:oration)?|Ltd\.?|GmbH|Co\.?)$/i, '')
    .trim();
  if (baseName !== name) {
    variations.add(baseName);
    // Also add no-spaces version of base name
    const baseNoSpaces = baseName.replace(/\s+/g, '');
    variations.add(baseNoSpaces.toLowerCase());
    variations.add(baseNoSpaces);
  }

  return Array.from(variations);
}

/**
 * Extract patent number from Google Patents URL
 * Handles formats like:
 * - https://patents.google.com/patent/US1234567B2
 * - https://patents.google.com/patent/EP1234567A1/en
 */
function extractPatentNumber(url: string): string | undefined {
  const match = url.match(/patents\.google\.com\/patent\/([A-Z]{2}\d+[A-Z]?\d*)/i);
  return match ? match[1].toUpperCase() : undefined;
}

/**
 * Extract patent office from patent number
 */
function extractPatentOffice(patentNumber: string): string | undefined {
  const prefix = patentNumber.substring(0, 2).toUpperCase();
  return PATENT_OFFICE_PREFIXES[prefix] ? prefix : undefined;
}

/**
 * Generate Google Patents PDF URL from patent number
 */
function generatePdfUrl(patentNumber: string): string {
  return `https://patents.google.com/patent/${patentNumber}/pdf`;
}

/**
 * Extract year from snippet text
 * Looks for patterns like "2023" or "Filed 2022"
 */
function extractYearFromSnippet(snippet: string): number | undefined {
  const yearMatch = snippet.match(/\b(19\d{2}|20\d{2})\b/);
  return yearMatch ? parseInt(yearMatch[1], 10) : undefined;
}

/**
 * Extract inventor names from snippet
 * Looks for patterns like "Inventors: John Smith, Jane Doe"
 */
function extractInventorsFromSnippet(snippet: string): string[] {
  const inventors: string[] = [];

  // Pattern: "Inventors: Name1, Name2"
  const inventorMatch = snippet.match(/(?:Inventor|Inventors?)[:;]\s*([^.]+)/i);
  if (inventorMatch) {
    const names = inventorMatch[1].split(/[,;]/).map(n => n.trim()).filter(n => n.length > 0);
    inventors.push(...names);
  }

  // Pattern: "by Name et al."
  const byMatch = snippet.match(/by\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\s+et\s+al/);
  if (byMatch && inventors.length === 0) {
    inventors.push(`${byMatch[1]} et al.`);
  }

  return inventors;
}

/**
 * Extract assignee from snippet
 * Looks for patterns like "Assignee: Company Name" or "Company LLC"
 */
function extractAssigneeFromSnippet(snippet: string): string | undefined {
  // Pattern: "Assignee: Company"
  const assigneeMatch = snippet.match(/(?:Assignee|Assigned\s+to)[:;]\s*([^.]+)/i);
  if (assigneeMatch) {
    return assigneeMatch[1].trim();
  }

  // Pattern: company suffixes
  const companyMatch = snippet.match(/([A-Z][A-Za-z\s&]+(?:Inc|LLC|Corp|Ltd|GmbH|Co)\.?)/);
  if (companyMatch) {
    return companyMatch[1].trim();
  }

  return undefined;
}

/**
 * Build Google Custom Search URL for patents.
 *
 * IMPORTANT: Google Custom Search API does NOT support structured operators like
 * `assignee:`, `inventor:`, or `cpc:`. These are native Google Patents operators
 * that only work on patents.google.com directly.
 *
 * Instead, we include company/inventor names as search terms. For assignees,
 * we generate name variations to increase match likelihood.
 */
function buildPatentSearchUrl(params: PatentSearchInput & { traceId?: string }): string {
  const apiKey = process.env.GOOGLE_CUSTOM_SEARCH_API_KEY;
  const searchId = process.env.GOOGLE_CUSTOM_SEARCH_ID;

  if (!apiKey || !searchId) {
    throw new Error('Missing Google API credentials');
  }

  const queryParts: string[] = [];

  // Add the main query
  queryParts.push(params.query.trim());

  // Add site restriction to Google Patents
  queryParts.push('site:patents.google.com');

  // Add patent office filter (this works as it matches URL patterns)
  if (params.patent_office && params.patent_office !== 'all') {
    queryParts.push(`patent/${params.patent_office}`);
  }

  // Add assignee as search terms with variations
  // Note: We use OR to match any variation, quoted for exact phrase matching
  if (params.assignee) {
    const variations = generateCompanyNameVariations(params.assignee);
    if (variations.length === 1) {
      queryParts.push(`"${variations[0]}"`);
    } else if (variations.length > 1) {
      // Use OR to match any variation (limit to top 4 to avoid query length issues)
      const topVariations = variations.slice(0, 4);
      const orQuery = topVariations.map(v => `"${v}"`).join(' OR ');
      queryParts.push(`(${orQuery})`);
    }
  }

  // Add inventor name as search terms (quoted for exact match)
  if (params.inventor) {
    queryParts.push(`"${params.inventor}"`);
  }

  // Add CPC code as search term (appears in patent text)
  if (params.cpc_code) {
    queryParts.push(`"${params.cpc_code}"`);
  }

  // Add year range filter
  if (params.year_from || params.year_to) {
    const from = params.year_from ?? 1900;
    const to = params.year_to ?? new Date().getFullYear();
    queryParts.push(`${from}..${to}`);
  }

  const urlParams = new URLSearchParams({
    key: apiKey,
    cx: searchId,
    q: queryParts.join(' '),
    num: String(params.num_results ?? 5),
  });

  return `https://www.googleapis.com/customsearch/v1?${urlParams.toString()}`;
}

/**
 * Parse Google API response item into patent result
 */
function parsePatentResult(item: GoogleSearchItem): PatentResultOutput | null {
  const patentNumber = extractPatentNumber(item.link);
  if (!patentNumber) {
    // Not a valid patent URL
    return null;
  }

  const snippet = item.snippet || '';
  const title = item.title
    .replace(/\s*-\s*Google Patents\s*$/i, '')
    .replace(/^\s*\[[^\]]+\]\s*/, '')
    .trim();

  const result: PatentResultOutput = {
    title,
    patentNumber,
    url: item.link,
    abstract: snippet,
    patentOffice: extractPatentOffice(patentNumber),
    pdfUrl: generatePdfUrl(patentNumber),
  };

  // Extract additional metadata from snippet and metatags
  const inventors = extractInventorsFromSnippet(snippet);
  if (inventors.length > 0) {
    result.inventors = inventors;
  }

  const assignee = extractAssigneeFromSnippet(snippet);
  if (assignee) {
    result.assignee = assignee;
  }

  // Try to extract dates from metatags
  const metatags = item.pagemap?.metatags?.[0];
  if (metatags) {
    if (metatags['citation_publication_date']) {
      result.publicationDate = metatags['citation_publication_date'];
    }
    if (metatags['citation_date']) {
      result.filingDate = metatags['citation_date'];
    }
  }

  // Fallback: extract year from snippet
  if (!result.publicationDate) {
    const year = extractYearFromSnippet(snippet);
    if (year) {
      result.publicationDate = String(year);
    }
  }

  return result;
}

// ── Tavily Search Helpers ──────────────────────────────────────────────────

/**
 * Build a free-text query string for Tavily patent search.
 * Replicates the same logic as buildPatentSearchUrl but without
 * Google-specific URL construction or site: operator.
 */
export function buildTavilyPatentQuery(params: PatentSearchInput): string {
  const queryParts: string[] = [];

  queryParts.push(params.query.trim());

  if (params.patent_office && params.patent_office !== 'all') {
    queryParts.push(`patent ${params.patent_office}`);
  }

  if (params.assignee) {
    const variations = generateCompanyNameVariations(params.assignee);
    if (variations.length === 1) {
      queryParts.push(`"${variations[0]}"`);
    } else if (variations.length > 1) {
      const topVariations = variations.slice(0, 4);
      const orQuery = topVariations.map(v => `"${v}"`).join(' OR ');
      queryParts.push(`(${orQuery})`);
    }
  }

  if (params.inventor) {
    queryParts.push(`"${params.inventor}"`);
  }

  if (params.cpc_code) {
    queryParts.push(`"${params.cpc_code}"`);
  }

  if (params.year_from || params.year_to) {
    const from = params.year_from ?? 1900;
    const to = params.year_to ?? new Date().getFullYear();
    queryParts.push(`${from}..${to}`);
  }

  return queryParts.join(' ');
}

/**
 * Parse a Tavily search result into a PatentResultOutput.
 */
export function parseTavilyPatentResult(item: { title: string; url: string; content: string }): PatentResultOutput | null {
  const patentNumber = extractPatentNumber(item.url);
  if (!patentNumber) {
    return null;
  }

  const snippet = item.content || '';
  const title = item.title
    .replace(/\s*-\s*Google Patents\s*$/i, '')
    .replace(/^\s*\[[^\]]+\]\s*/, '')
    .trim();

  const result: PatentResultOutput = {
    title,
    patentNumber,
    url: item.url,
    abstract: snippet,
    patentOffice: extractPatentOffice(patentNumber),
    pdfUrl: generatePdfUrl(patentNumber),
  };

  const inventors = extractInventorsFromSnippet(snippet);
  if (inventors.length > 0) {
    result.inventors = inventors;
  }

  const assignee = extractAssigneeFromSnippet(snippet);
  if (assignee) {
    result.assignee = assignee;
  }

  if (!result.publicationDate) {
    const year = extractYearFromSnippet(snippet);
    if (year) {
      result.publicationDate = String(year);
    }
  }

  return result;
}

/**
 * Execute patent search via Tavily with include_domains restriction.
 */
async function handleTavilyPatentSearch(
  params: PatentSearchInput,
  traceId?: string,
): Promise<{
  isError?: boolean;
  content: Array<{ type: 'text'; text: string }>;
  structuredContent: PatentSearchOutput;
}> {
  const tavilyApiKey = process.env.TAVILY_API_KEY;
  const trimmedQuery = params.query.trim();

  if (!tavilyApiKey) {
    logger.error('Missing TAVILY_API_KEY for patent search', { traceId });
    return {
      isError: true,
      content: [{ type: 'text', text: 'Missing TAVILY_API_KEY environment variable.' }],
      structuredContent: {
        patents: [],
        query: trimmedQuery,
        totalResults: 0,
        resultCount: 0,
        searchType: params.search_type ?? 'prior_art',
        source: 'Tavily (Google Patents)',
      },
    };
  }

  try {
    const client = tavily({ apiKey: tavilyApiKey });
    const query = buildTavilyPatentQuery(params);
    logger.info('Patent search request (Tavily)', { traceId, query, searchType: params.search_type });

    const response = await client.search(query, {
      maxResults: params.num_results ?? 5,
      searchDepth: 'advanced',
      includeDomains: ['patents.google.com'],
    });

    const patents: PatentResultOutput[] = [];
    for (const item of response.results) {
      const patent = parseTavilyPatentResult(item);
      if (patent) {
        patents.push(patent);
      }
    }

    logger.info('Patent search completed (Tavily)', { traceId, returned: patents.length });

    const textParts: string[] = [
      `Patent search for "${trimmedQuery}"`,
      `Found ${patents.length} patents via Tavily.`,
      '',
    ];

    for (let i = 0; i < patents.length; i++) {
      const p = patents[i];
      textParts.push(`${i + 1}. ${p.title}`);
      textParts.push(`   Patent: ${p.patentNumber}`);
      if (p.assignee) textParts.push(`   Assignee: ${p.assignee}`);
      if (p.inventors?.length) textParts.push(`   Inventors: ${p.inventors.join(', ')}`);
      if (p.publicationDate) textParts.push(`   Date: ${p.publicationDate}`);
      textParts.push(`   URL: ${p.url}`);
      if (p.abstract) textParts.push(`   ${p.abstract.substring(0, 200)}...`);
      textParts.push('');
    }

    return {
      content: [{ type: 'text', text: textParts.join('\n') }],
      structuredContent: {
        patents,
        query: trimmedQuery,
        totalResults: patents.length,
        resultCount: patents.length,
        searchType: params.search_type ?? 'prior_art',
        source: 'Tavily (Google Patents)',
      },
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error('Patent search failed (Tavily)', { traceId, error: errorMessage });

    return {
      isError: true,
      content: [{ type: 'text', text: `Patent search failed: ${errorMessage}` }],
      structuredContent: {
        patents: [],
        query: trimmedQuery,
        totalResults: 0,
        resultCount: 0,
        searchType: params.search_type ?? 'prior_art',
        source: 'Tavily (Google Patents)',
      },
    };
  }
}

// ── Main Handler ───────────────────────────────────────────────────────────

/**
 * Determine whether to use Tavily or Google for patent search.
 * Tavily is used when SEARCH_PROVIDER=tavily or when TAVILY_API_KEY is set
 * and Google credentials are absent.
 */
export function useTavilyProvider(): boolean {
  const provider = process.env.SEARCH_PROVIDER?.toLowerCase();
  if (provider === 'tavily') return true;
  if (provider === 'parallel') return true;
  if (provider === 'google') return false;
  // Fallback: use Tavily only if Google credentials are missing but Tavily key exists
  const hasGoogle = !!(process.env.GOOGLE_CUSTOM_SEARCH_API_KEY && process.env.GOOGLE_CUSTOM_SEARCH_ID);
  const hasTavily = !!process.env.TAVILY_API_KEY;
  return !hasGoogle && hasTavily;
}

/**
 * Handle patent search request
 */
export async function handlePatentSearch(
  params: PatentSearchInput,
  traceId?: string
): Promise<{
  isError?: boolean;
  content: Array<{ type: 'text'; text: string }>;
  structuredContent: PatentSearchOutput;
}> {
  // Route to Tavily if configured
  if (useTavilyProvider()) {
    return handleTavilyPatentSearch(params, traceId);
  }

  const apiKey = process.env.GOOGLE_CUSTOM_SEARCH_API_KEY;
  const searchId = process.env.GOOGLE_CUSTOM_SEARCH_ID;

  if (!apiKey || !searchId) {
    logger.error('Missing Google API credentials for patent search', { traceId });
    return {
      isError: true,
      content: [{ type: 'text', text: 'Missing Google API credentials. Please set GOOGLE_CUSTOM_SEARCH_API_KEY and GOOGLE_CUSTOM_SEARCH_ID environment variables.' }],
      structuredContent: {
        patents: [],
        query: params.query.trim(),
        totalResults: 0,
        resultCount: 0,
        searchType: params.search_type ?? 'prior_art',
        source: 'Google Patents',
      },
    };
  }

  const trimmedQuery = params.query.trim();

  try {
    const searchUrl = buildPatentSearchUrl({ ...params, traceId });
    logger.info('Patent search request', { traceId, query: trimmedQuery, searchType: params.search_type });

    const response = await fetch(searchUrl);

    if (!response.ok) {
      const errorText = await response.text();
      logger.error('Patent search API error', { traceId, status: response.status, error: errorText });
      return {
        isError: true,
        content: [{ type: 'text', text: `Patent search failed: HTTP ${response.status}` }],
        structuredContent: {
          patents: [],
          query: trimmedQuery,
          totalResults: 0,
          resultCount: 0,
          searchType: params.search_type ?? 'prior_art',
          source: 'Google Patents',
        },
      };
    }

    const data = await response.json() as GoogleSearchResponse;

    if (data.error) {
      logger.error('Patent search API returned error', { traceId, error: data.error.message });
      return {
        isError: true,
        content: [{ type: 'text', text: `Patent search failed: ${data.error.message}` }],
        structuredContent: {
          patents: [],
          query: trimmedQuery,
          totalResults: 0,
          resultCount: 0,
          searchType: params.search_type ?? 'prior_art',
          source: 'Google Patents',
        },
      };
    }

    const totalResults = parseInt(data.searchInformation?.totalResults ?? '0', 10);
    const items = data.items ?? [];

    // Parse patent results
    const patents: PatentResultOutput[] = [];
    for (const item of items) {
      const patent = parsePatentResult(item);
      if (patent) {
        patents.push(patent);
      }
    }

    logger.info('Patent search completed', { traceId, totalResults, returned: patents.length });

    // Build text response
    const textParts: string[] = [
      `Patent search for "${trimmedQuery}"`,
      `Found ${totalResults} total results, returning ${patents.length} patents.`,
      '',
    ];

    for (let i = 0; i < patents.length; i++) {
      const p = patents[i];
      textParts.push(`${i + 1}. ${p.title}`);
      textParts.push(`   Patent: ${p.patentNumber}`);
      if (p.assignee) textParts.push(`   Assignee: ${p.assignee}`);
      if (p.inventors?.length) textParts.push(`   Inventors: ${p.inventors.join(', ')}`);
      if (p.publicationDate) textParts.push(`   Date: ${p.publicationDate}`);
      textParts.push(`   URL: ${p.url}`);
      if (p.abstract) textParts.push(`   ${p.abstract.substring(0, 200)}...`);
      textParts.push('');
    }

    return {
      content: [{ type: 'text', text: textParts.join('\n') }],
      structuredContent: {
        patents,
        query: trimmedQuery,
        totalResults,
        resultCount: patents.length,
        searchType: params.search_type ?? 'prior_art',
        source: 'Google Patents',
      },
    };

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error('Patent search failed', { traceId, error: errorMessage });

    return {
      isError: true,
      content: [{ type: 'text', text: `Patent search failed: ${errorMessage}` }],
      structuredContent: {
        patents: [],
        query: trimmedQuery,
        totalResults: 0,
        resultCount: 0,
        searchType: params.search_type ?? 'prior_art',
        source: 'Google Patents',
      },
    };
  }
}
