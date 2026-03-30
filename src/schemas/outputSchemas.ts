/**
 * Output Schemas for MCP Tools
 *
 * Defines structured output schemas for all tools to enable
 * type-safe structured responses per MCP spec.
 *
 * Note: Schemas are exported as raw Zod shapes (not wrapped in z.object())
 * because the MCP SDK expects this format for inputSchema/outputSchema.
 */

import { z } from 'zod';

// ── Citation Schema ─────────────────────────────────────────────────────────

/**
 * Schema for citation metadata extracted from web pages
 */
export const citationMetadataSchema = z.object({
  /** Page title */
  title: z.string().optional().describe('Title of the page or article'),
  /** Author name(s) */
  author: z.string().optional().describe('Author name(s) if available'),
  /** Publication date (YYYY-MM-DD format) */
  publishedDate: z.string().optional().describe('Publication date in YYYY-MM-DD format'),
  /** Site or publication name */
  siteName: z.string().optional().describe('Name of the website or publication'),
  /** Content description/excerpt */
  description: z.string().optional().describe('Brief description or excerpt'),
});

/**
 * Schema for formatted citations
 */
export const formattedCitationsSchema = z.object({
  /** APA 7th edition format */
  apa: z.string().describe('Citation formatted in APA 7th edition style'),
  /** MLA 9th edition format */
  mla: z.string().describe('Citation formatted in MLA 9th edition style'),
});

/**
 * Complete citation schema
 */
export const citationSchema = z.object({
  /** Extracted metadata */
  metadata: citationMetadataSchema.describe('Extracted metadata from the source'),
  /** URL of the source */
  url: z.string().url().describe('URL of the source'),
  /** Date the content was accessed */
  accessedDate: z.string().describe('Date the content was accessed (YYYY-MM-DD)'),
  /** Pre-formatted citation strings */
  formatted: formattedCitationsSchema.describe('Pre-formatted citation strings'),
});

/** Inferred type for citation metadata */
export type CitationMetadataOutput = z.infer<typeof citationMetadataSchema>;

/** Inferred type for formatted citations */
export type FormattedCitationsOutput = z.infer<typeof formattedCitationsSchema>;

/** Inferred type for complete citation */
export type CitationOutput = z.infer<typeof citationSchema>;

// ── Google Search Output ───────────────────────────────────────────────────

/**
 * Structured output schema for google_search tool
 */
export const googleSearchOutputSchema = {
  /** Array of URLs found by the search */
  urls: z.array(z.string().url()).describe('List of URLs returned by the search'),
  /** The original search query */
  query: z.string().describe('The search query that was executed'),
  /** Number of results returned */
  resultCount: z.number().int().min(0).describe('Number of URLs found'),
};

/** Inferred type for google_search structured output */
export type GoogleSearchOutput = {
  urls: string[];
  query: string;
  resultCount: number;
};

// ── Content Size Metadata Schema ───────────────────────────────────────────

/**
 * Schema for content size metadata
 */
export const sizeMetadataSchema = z.object({
  /** Content length in characters */
  contentLength: z.number().int().min(0).describe('Content length in characters'),
  /** Estimated token count (approximate) */
  estimatedTokens: z.number().int().min(0).describe('Estimated token count (~4 chars/token)'),
  /** Whether content was truncated */
  truncated: z.boolean().describe('Whether content was truncated'),
  /** Original length before truncation */
  originalLength: z.number().int().optional().describe('Original length if truncated'),
  /** Size category */
  sizeCategory: z.enum(['small', 'medium', 'large', 'very_large']).describe('Size category'),
});

/** Inferred type for size metadata */
export type SizeMetadataOutput = z.infer<typeof sizeMetadataSchema>;

// ── Content Preview Schema ─────────────────────────────────────────────────

/**
 * Schema for content preview (metadata without full content)
 */
export const contentPreviewSchema = z.object({
  /** Original URL */
  url: z.string().url().describe('Original URL'),
  /** Page title if available */
  title: z.string().optional().describe('Page title'),
  /** Content length in characters */
  contentLength: z.number().int().describe('Content length in characters'),
  /** Estimated token count */
  estimatedTokens: z.number().int().describe('Estimated token count'),
  /** List of headings found */
  headings: z.array(z.object({
    level: z.number().int().min(1).max(6),
    text: z.string(),
  })).describe('Headings extracted from content'),
  /** First paragraph or excerpt */
  excerpt: z.string().describe('First paragraph or excerpt'),
  /** Size category */
  sizeCategory: z.enum(['small', 'medium', 'large', 'very_large']).describe('Size category'),
});

/** Inferred type for content preview */
export type ContentPreviewOutput = z.infer<typeof contentPreviewSchema>;

// ── Scrape Page Output ─────────────────────────────────────────────────────

/**
 * Structured output schema for scrape_page tool
 */
export const scrapePageOutputSchema = {
  /** The URL that was scraped */
  url: z.string().url().describe('The URL that was scraped'),
  /** Extracted text content (empty in preview mode) */
  content: z.string().describe('The extracted text content from the page'),
  /** Type of content extracted */
  contentType: z.enum(['html', 'youtube', 'pdf', 'docx', 'pptx']).describe('The type of content that was extracted'),
  /** Content length in characters */
  contentLength: z.number().int().min(0).describe('Length of the extracted content in characters'),
  /** Whether content was truncated */
  truncated: z.boolean().describe('Whether the content was truncated due to size limits'),
  /** Estimated token count */
  estimatedTokens: z.number().int().min(0).describe('Estimated token count (~4 chars/token)'),
  /** Size category */
  sizeCategory: z.enum(['small', 'medium', 'large', 'very_large']).describe('Size category based on content length'),
  /** Original length before truncation (if truncated) */
  originalLength: z.number().int().optional().describe('Original content length before truncation'),
  /** Document metadata (for document types) */
  metadata: z.object({
    title: z.string().optional().describe('Document title if available'),
    pageCount: z.number().int().optional().describe('Number of pages/slides'),
  }).optional().describe('Additional metadata for documents'),
  /** Citation information (for web pages) */
  citation: citationSchema.optional().describe('Citation information with metadata and formatted strings'),
  /** Preview information (when mode=preview) */
  preview: contentPreviewSchema.optional().describe('Content preview with structure (when mode=preview)'),
};

/** Inferred type for scrape_page structured output */
export type ScrapePageOutput = {
  url: string;
  content: string;
  contentType: 'html' | 'youtube' | 'pdf' | 'docx' | 'pptx';
  contentLength: number;
  truncated: boolean;
  estimatedTokens: number;
  sizeCategory: 'small' | 'medium' | 'large' | 'very_large';
  originalLength?: number;
  metadata?: {
    title?: string;
    pageCount?: number;
  };
  citation?: CitationOutput;
  preview?: ContentPreviewOutput;
};

// ── Search and Scrape Output ───────────────────────────────────────────────

/**
 * Source information for search_and_scrape
 */
export const sourceSchema = z.object({
  url: z.string().url().describe('URL of the source'),
  success: z.boolean().describe('Whether scraping succeeded'),
  contentLength: z.number().int().optional().describe('Length of content if successful'),
  citation: citationSchema.optional().describe('Citation information if available'),
  qualityScore: z.number().min(0).max(1).optional().describe('Overall quality score (0-1)'),
});

/**
 * Structured output schema for search_and_scrape tool
 */
export const searchAndScrapeOutputSchema = {
  /** The original search query */
  query: z.string().describe('The search query that was executed'),
  /** Sources that were successfully scraped */
  sources: z.array(sourceSchema).describe('List of sources that were processed'),
  /** Combined content from all sources */
  combinedContent: z.string().describe('Combined and optionally deduplicated content from all sources'),
  /** Summary statistics */
  summary: z.object({
    urlsSearched: z.number().int().describe('Number of URLs found by search'),
    urlsScraped: z.number().int().describe('Number of URLs successfully scraped'),
    processingTimeMs: z.number().int().describe('Total processing time in milliseconds'),
    duplicatesRemoved: z.number().int().optional().describe('Number of duplicate paragraphs removed'),
    reductionPercent: z.number().optional().describe('Percentage reduction from deduplication'),
  }).describe('Summary statistics for the operation'),
  /** Size metadata for the response */
  sizeMetadata: sizeMetadataSchema.describe('Size information for the combined content'),
};

/** Inferred type for source in search_and_scrape */
export type SourceOutput = {
  url: string;
  success: boolean;
  contentLength?: number;
  citation?: CitationOutput;
  qualityScore?: number;
};

/** Inferred type for search_and_scrape structured output */
export type SearchAndScrapeOutput = {
  query: string;
  sources: SourceOutput[];
  combinedContent: string;
  summary: {
    urlsSearched: number;
    urlsScraped: number;
    processingTimeMs: number;
    duplicatesRemoved?: number;
    reductionPercent?: number;
  };
  sizeMetadata: SizeMetadataOutput;
};

// ── Quality Scores Schema ─────────────────────────────────────────────────────

/**
 * Schema for quality score breakdown
 */
export const qualityScoresSchema = z.object({
  /** Composite quality score (0-1) */
  overall: z.number().min(0).max(1).describe('Composite quality score'),
  /** Query relevance score (0-1) */
  relevance: z.number().min(0).max(1).describe('Query relevance score'),
  /** Content freshness score (0-1) */
  freshness: z.number().min(0).max(1).describe('Content recency score'),
  /** Domain authority score (0-1) */
  authority: z.number().min(0).max(1).describe('Domain authority score'),
  /** Content quality score (0-1) */
  contentQuality: z.number().min(0).max(1).describe('Content quality score'),
});

/** Inferred type for quality scores */
export type QualityScoresOutput = z.infer<typeof qualityScoresSchema>;

// ── Google Image Search Output ────────────────────────────────────────────────

/**
 * Schema for image search result
 */
export const imageResultSchema = z.object({
  /** Image title */
  title: z.string().describe('Title or description of the image'),
  /** Direct URL to the full image */
  link: z.string().url().describe('Direct URL to the full image'),
  /** URL to thumbnail version */
  thumbnailLink: z.string().url().optional().describe('URL to thumbnail version'),
  /** Domain hosting the image */
  displayLink: z.string().describe('Domain hosting the image'),
  /** URL of the page containing the image */
  contextLink: z.string().url().optional().describe('URL of the page containing the image'),
  /** Image width in pixels */
  width: z.number().int().optional().describe('Image width in pixels'),
  /** Image height in pixels */
  height: z.number().int().optional().describe('Image height in pixels'),
  /** File size (as string from API) */
  fileSize: z.string().optional().describe('File size'),
});

/**
 * Structured output schema for google_image_search tool
 */
export const googleImageSearchOutputSchema = {
  /** Array of image results */
  images: z.array(imageResultSchema).describe('List of image results'),
  /** The original search query */
  query: z.string().describe('The search query that was executed'),
  /** Number of images found */
  resultCount: z.number().int().min(0).describe('Number of images found'),
};

/** Inferred type for image result */
export type ImageResultOutput = z.infer<typeof imageResultSchema>;

/** Inferred type for google_image_search structured output */
export type GoogleImageSearchOutput = {
  images: ImageResultOutput[];
  query: string;
  resultCount: number;
};

// ── Google News Search Output ─────────────────────────────────────────────────

/**
 * Schema for news article result
 */
export const newsResultSchema = z.object({
  /** Article headline */
  title: z.string().describe('Article headline'),
  /** URL to the full article */
  link: z.string().url().describe('URL to the full article'),
  /** Article excerpt/snippet */
  snippet: z.string().describe('Article excerpt or summary'),
  /** News source domain */
  source: z.string().describe('News source domain'),
  /** Publication date if available */
  publishedDate: z.string().optional().describe('Publication date if available'),
});

/**
 * Structured output schema for google_news_search tool
 */
export const googleNewsSearchOutputSchema = {
  /** Array of news articles */
  articles: z.array(newsResultSchema).describe('List of news articles'),
  /** The original search query */
  query: z.string().describe('The search query that was executed'),
  /** Number of articles found */
  resultCount: z.number().int().min(0).describe('Number of articles found'),
  /** Freshness filter used */
  freshness: z.string().describe('Freshness filter that was applied'),
  /** Sort order used */
  sortedBy: z.enum(['relevance', 'date']).describe('Sort order used'),
};

/** Inferred type for news result */
export type NewsResultOutput = z.infer<typeof newsResultSchema>;

/** Inferred type for google_news_search structured output */
export type GoogleNewsSearchOutput = {
  articles: NewsResultOutput[];
  query: string;
  resultCount: number;
  freshness: string;
  sortedBy: 'relevance' | 'date';
};

// ── Sequential Search Output ─────────────────────────────────────────────────

/**
 * Structured output schema for sequential_search tool
 */
export const sequentialSearchOutputSchema = {
  /** Unique session identifier */
  sessionId: z.string().uuid().describe('Unique session identifier'),
  /** Current step number */
  currentStep: z.number().int().describe('Current step number'),
  /** Estimated total steps */
  totalStepsEstimate: z.number().int().describe('Estimated total steps'),
  /** Whether research is complete */
  isComplete: z.boolean().describe('Whether research is marked as complete'),
  /** Number of sources collected */
  sourceCount: z.number().int().describe('Number of sources collected so far'),
  /** Number of open knowledge gaps */
  openGapsCount: z.number().int().describe('Number of unresolved knowledge gaps'),
  /** Summary of current state */
  stateSummary: z.string().describe('Human-readable summary of research state'),
  /** All sources (included when complete) */
  sources: z.array(z.object({
    url: z.string(),
    summary: z.string(),
    qualityScore: z.number().optional(),
  })).optional().describe('All sources collected (included when complete)'),
  /** All gaps (included when complete) */
  gaps: z.array(z.object({
    description: z.string(),
    resolved: z.boolean(),
  })).optional().describe('All knowledge gaps (included when complete)'),
};

// ── Academic Search Output ───────────────────────────────────────────────────

/**
 * Schema for academic paper citations
 */
export const academicCitationsSchema = z.object({
  apa: z.string().describe('APA 7th edition format'),
  mla: z.string().describe('MLA 9th edition format'),
  bibtex: z.string().describe('BibTeX format'),
});

/**
 * Schema for academic paper result
 */
export const academicPaperSchema = z.object({
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
  citations: academicCitationsSchema.describe('Pre-formatted citations'),
});

/**
 * Structured output schema for academic_search tool
 */
export const academicSearchOutputSchema = {
  /** Array of academic papers */
  papers: z.array(academicPaperSchema).describe('List of academic papers'),
  /** Original search query */
  query: z.string().describe('The search query that was executed'),
  /** Total results found */
  totalResults: z.number().int().describe('Total papers matching query'),
  /** Number of results returned */
  resultCount: z.number().int().describe('Number of papers returned'),
  /** Data source */
  source: z.literal('Google Scholar Search').describe('Data source'),
};

/** Inferred type for academic paper */
export type AcademicPaperOutput = z.infer<typeof academicPaperSchema>;

/** Inferred type for academic_search structured output */
export type AcademicSearchOutput = {
  papers: AcademicPaperOutput[];
  query: string;
  totalResults: number;
  resultCount: number;
  source: 'Google Scholar Search';
};

// ── Patent Search Output ───────────────────────────────────────────────────

/**
 * Schema for patent result
 */
export const patentResultSchema = z.object({
  /** Patent title */
  title: z.string().describe('Patent title'),
  /** Patent number (e.g., US1234567B2) */
  patentNumber: z.string().describe('Patent number with country prefix'),
  /** URL to patent page */
  url: z.string().url().describe('URL to Google Patents page'),
  /** Patent abstract/description */
  abstract: z.string().optional().describe('Patent abstract or snippet'),
  /** Inventor names */
  inventors: z.array(z.string()).optional().describe('List of inventor names'),
  /** Assignee/owner */
  assignee: z.string().optional().describe('Patent assignee or owner'),
  /** Filing date */
  filingDate: z.string().optional().describe('Filing date (YYYY-MM-DD)'),
  /** Publication date */
  publicationDate: z.string().optional().describe('Publication date (YYYY-MM-DD)'),
  /** Patent office (USPTO, EPO, WIPO, etc.) */
  patentOffice: z.string().optional().describe('Patent office'),
  /** CPC classification codes */
  cpcCodes: z.array(z.string()).optional().describe('CPC classification codes'),
  /** Direct link to PDF */
  pdfUrl: z.string().url().optional().describe('Direct link to patent PDF'),
});

/**
 * Structured output schema for patent_search tool
 */
export const patentSearchOutputSchema = {
  /** Array of patent results */
  patents: z.array(patentResultSchema).describe('List of patent results'),
  /** Original search query */
  query: z.string().describe('The search query that was executed'),
  /** Total results found */
  totalResults: z.number().int().describe('Total patents matching query'),
  /** Number of results returned */
  resultCount: z.number().int().describe('Number of patents returned'),
  /** Search type used */
  searchType: z.enum(['prior_art', 'specific', 'landscape']).describe('Type of patent search'),
  /** Data source */
  source: z.enum(['Google Patents', 'Tavily (Google Patents)']).describe('Data source'),
};

/** Inferred type for patent result */
export type PatentResultOutput = z.infer<typeof patentResultSchema>;

/** Inferred type for patent_search structured output */
export type PatentSearchOutput = {
  patents: PatentResultOutput[];
  query: string;
  totalResults: number;
  resultCount: number;
  searchType: 'prior_art' | 'specific' | 'landscape';
  source: 'Google Patents' | 'Tavily (Google Patents)';
};
