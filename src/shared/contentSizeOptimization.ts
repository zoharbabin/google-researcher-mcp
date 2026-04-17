/**
 * Content Size Optimization Utilities
 *
 * Provides mechanical operations for content size management:
 * - Truncation at character limits with natural breakpoints
 * - Token estimation (approximate)
 * - Content structure extraction (headings)
 * - Keyword-based paragraph filtering (string matching, not semantic)
 *
 * IMPORTANT: This module performs ONLY mechanical operations.
 * Summarization, semantic analysis, and reasoning are the LLM's responsibility.
 */

/**
 * Result of content truncation
 */
export interface TruncationResult {
  /** The (possibly truncated) content */
  content: string;
  /** Whether content was truncated */
  truncated: boolean;
  /** Original content length in characters */
  originalLength: number;
  /** Truncated content length in characters */
  truncatedLength: number;
  /** Characters removed by truncation */
  charactersRemoved: number;
}

/**
 * Content preview information (metadata without full content)
 */
export interface ContentPreview {
  /** Original URL */
  url: string;
  /** Page title if available */
  title?: string;
  /** Content length in characters */
  contentLength: number;
  /** Estimated token count */
  estimatedTokens: number;
  /** List of headings found in the content */
  headings: Array<{ level: number; text: string }>;
  /** First paragraph or excerpt */
  excerpt: string;
  /** Recommendation based on size */
  sizeCategory: 'small' | 'medium' | 'large' | 'very_large';
}

/**
 * Result of keyword filtering
 */
export interface KeywordFilterResult {
  /** Filtered content */
  content: string;
  /** Total paragraphs in original content */
  totalParagraphs: number;
  /** Paragraphs included after filtering */
  includedParagraphs: number;
  /** Paragraphs excluded */
  excludedParagraphs: number;
}

/**
 * Size metadata for responses
 */
export interface SizeMetadata {
  /** Content length in characters */
  contentLength: number;
  /** Estimated token count (approximate: ~4 chars per token) */
  estimatedTokens: number;
  /** Whether content was truncated */
  truncated: boolean;
  /** Original length before truncation (if truncated) */
  originalLength?: number;
  /** Size category */
  sizeCategory: 'small' | 'medium' | 'large' | 'very_large';
}

// Pre-compiled regexes used in findNaturalBreakpoint and extractHeadings
const SENTENCE_END_REGEX = /[.!?]\s/g;
const MARKDOWN_HEADING_REGEX = /^(#{1,6})\s+(.+)$/gm;
const UNDERLINE_HEADING_REGEX = /^(.+)\n(={3,}|-{3,})$/gm;
const CAPS_HEADING_REGEX = /^([A-Z][A-Z\s]{10,})$/gm;

// Size thresholds in characters
const SIZE_THRESHOLDS = {
  small: 5_000,      // < 5k chars (~1.25k tokens)
  medium: 20_000,    // < 20k chars (~5k tokens)
  large: 50_000,     // < 50k chars (~12.5k tokens)
  // very_large: >= 50k chars
};

/**
 * Estimate token count from character count.
 * Uses approximate ratio of 4 characters per token (conservative estimate).
 */
export function estimateTokens(text: string): number {
  // GPT/Claude tokenizers average ~4 chars per token for English
  // This is a rough estimate; actual token count varies by content
  return Math.ceil(text.length / 4);
}

/**
 * Determine size category based on content length
 */
export function getSizeCategory(length: number): 'small' | 'medium' | 'large' | 'very_large' {
  if (length < SIZE_THRESHOLDS.small) return 'small';
  if (length < SIZE_THRESHOLDS.medium) return 'medium';
  if (length < SIZE_THRESHOLDS.large) return 'large';
  return 'very_large';
}

/**
 * Generate size metadata for content
 */
export function generateSizeMetadata(
  content: string,
  originalLength?: number,
  truncated = false
): SizeMetadata {
  return {
    contentLength: content.length,
    estimatedTokens: estimateTokens(content),
    truncated,
    originalLength: truncated ? originalLength : undefined,
    sizeCategory: getSizeCategory(content.length),
  };
}

/**
 * Find the nearest natural breakpoint (sentence or paragraph end)
 * before the given position.
 */
function findNaturalBreakpoint(text: string, maxPosition: number): number {
  if (maxPosition >= text.length) return text.length;

  // Look for paragraph break first (double newline)
  const paragraphBreak = text.lastIndexOf('\n\n', maxPosition);
  if (paragraphBreak > maxPosition * 0.7) {
    return paragraphBreak + 2; // Include the newlines
  }

  // Look for sentence end (. ! ?)
  SENTENCE_END_REGEX.lastIndex = 0;
  let lastSentenceEnd = -1;
  let match;
  while ((match = SENTENCE_END_REGEX.exec(text)) !== null) {
    if (match.index > maxPosition) break;
    lastSentenceEnd = match.index + 2; // Include punctuation and space
  }
  if (lastSentenceEnd > maxPosition * 0.7) {
    return lastSentenceEnd;
  }

  // Look for single newline
  const newlinePos = text.lastIndexOf('\n', maxPosition);
  if (newlinePos > maxPosition * 0.8) {
    return newlinePos + 1;
  }

  // Fallback: look for space to avoid breaking mid-word
  const spacePos = text.lastIndexOf(' ', maxPosition);
  if (spacePos > maxPosition * 0.9) {
    return spacePos + 1;
  }

  // Last resort: use exact position
  return maxPosition;
}

/**
 * Truncate content at a specified maximum length.
 * Attempts to truncate at natural breakpoints (sentence/paragraph boundaries).
 *
 * @param content - The content to truncate
 * @param maxLength - Maximum length in characters
 * @param strategy - 'start' keeps beginning, 'balanced' keeps beginning and end
 */
export function truncateContent(
  content: string,
  maxLength: number,
  strategy: 'start' | 'balanced' = 'start'
): TruncationResult {
  const originalLength = content.length;

  if (originalLength <= maxLength) {
    return {
      content,
      truncated: false,
      originalLength,
      truncatedLength: originalLength,
      charactersRemoved: 0,
    };
  }

  let truncatedContent: string;

  if (strategy === 'balanced') {
    // Keep both beginning and end, truncate middle
    const halfSize = Math.floor((maxLength - 60) / 2); // Reserve space for truncation message
    const startBreak = findNaturalBreakpoint(content, halfSize);
    const endStart = content.length - halfSize;

    truncatedContent =
      content.substring(0, startBreak) +
      '\n\n[... CONTENT TRUNCATED: ' +
      (originalLength - maxLength).toLocaleString() +
      ' characters removed ...]\n\n' +
      content.substring(endStart);
  } else {
    // Keep beginning only
    const breakpoint = findNaturalBreakpoint(content, maxLength - 80);
    truncatedContent =
      content.substring(0, breakpoint) +
      '\n\n[... CONTENT TRUNCATED: ' +
      (originalLength - breakpoint).toLocaleString() +
      ' characters remaining ...]';
  }

  return {
    content: truncatedContent,
    truncated: true,
    originalLength,
    truncatedLength: truncatedContent.length,
    charactersRemoved: originalLength - truncatedContent.length,
  };
}

/**
 * Extract headings from HTML-like content using simple regex patterns.
 * This is a mechanical operation that looks for common heading patterns.
 */
export function extractHeadings(content: string): Array<{ level: number; text: string }> {
  const headings: Array<{ level: number; text: string }> = [];

  // Pattern 1: Markdown-style headings (# ## ### etc.)
  MARKDOWN_HEADING_REGEX.lastIndex = 0;
  let match;
  while ((match = MARKDOWN_HEADING_REGEX.exec(content)) !== null) {
    headings.push({
      level: match[1].length,
      text: match[2].trim(),
    });
  }

  // Pattern 2: Underlined headings (=== or ---)
  UNDERLINE_HEADING_REGEX.lastIndex = 0;
  while ((match = UNDERLINE_HEADING_REGEX.exec(content)) !== null) {
    headings.push({
      level: match[2].startsWith('=') ? 1 : 2,
      text: match[1].trim(),
    });
  }

  // Pattern 3: ALL CAPS lines that look like headings (at least 3 words)
  CAPS_HEADING_REGEX.lastIndex = 0;
  while ((match = CAPS_HEADING_REGEX.exec(content)) !== null) {
    const text = match[1].trim();
    if (text.split(/\s+/).length >= 2 && text.length < 100) {
      headings.push({
        level: 2,
        text: text.charAt(0) + text.slice(1).toLowerCase(),
      });
    }
  }

  return headings;
}

/**
 * Extract the first paragraph or meaningful excerpt from content.
 */
export function extractExcerpt(content: string, maxLength = 500): string {
  // Skip any leading whitespace or short lines
  const trimmed = content.trim();

  // Find first substantial paragraph (at least 100 chars)
  const paragraphs = trimmed.split(/\n\n+/);
  for (const para of paragraphs) {
    const cleaned = para.trim();
    if (cleaned.length >= 100 && !cleaned.startsWith('#')) {
      return cleaned.length > maxLength
        ? cleaned.substring(0, maxLength) + '...'
        : cleaned;
    }
  }

  // Fallback: just return first N characters
  return trimmed.length > maxLength
    ? trimmed.substring(0, maxLength) + '...'
    : trimmed;
}

/**
 * Generate a content preview with metadata and structure.
 * This allows the LLM to make informed decisions about whether to fetch full content.
 */
export function generatePreview(url: string, content: string, title?: string): ContentPreview {
  return {
    url,
    title,
    contentLength: content.length,
    estimatedTokens: estimateTokens(content),
    headings: extractHeadings(content),
    excerpt: extractExcerpt(content),
    sizeCategory: getSizeCategory(content.length),
  };
}

/**
 * Split content into paragraphs.
 */
function splitIntoParagraphs(content: string): string[] {
  return content
    .split(/\n\n+/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}

/**
 * Check if a paragraph contains any of the keywords (case-insensitive).
 * This is simple string matching, not semantic analysis.
 */
function paragraphContainsKeywords(paragraph: string, keywords: string[]): boolean {
  const lowerPara = paragraph.toLowerCase();
  return keywords.some((keyword) => lowerPara.includes(keyword.toLowerCase()));
}

/**
 * Filter content to only include paragraphs containing specified keywords.
 * This is a mechanical string-matching operation, not semantic filtering.
 *
 * @param content - The content to filter
 * @param keywords - Array of keywords to match (case-insensitive)
 * @param minParagraphLength - Minimum paragraph length to consider
 */
export function filterByKeywords(
  content: string,
  keywords: string[],
  minParagraphLength = 50
): KeywordFilterResult {
  if (keywords.length === 0) {
    const count = splitIntoParagraphs(content).length;
    return {
      content,
      totalParagraphs: count,
      includedParagraphs: count,
      excludedParagraphs: 0,
    };
  }

  const paragraphs = splitIntoParagraphs(content);
  const included: string[] = [];
  let excluded = 0;

  for (const para of paragraphs) {
    if (para.length < minParagraphLength) {
      // Short paragraphs are likely headers/navigation, skip them
      excluded++;
      continue;
    }

    if (paragraphContainsKeywords(para, keywords)) {
      included.push(para);
    } else {
      excluded++;
    }
  }

  return {
    content: included.join('\n\n'),
    totalParagraphs: paragraphs.length,
    includedParagraphs: included.length,
    excludedParagraphs: excluded,
  };
}

/**
 * Extract keywords from a search query for filtering.
 * Removes common stop words and returns significant terms.
 */
export function extractQueryKeywords(query: string): string[] {
  const stopWords = new Set([
    'a', 'an', 'the', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
    'of', 'with', 'by', 'from', 'as', 'is', 'was', 'are', 'were', 'been',
    'be', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would',
    'could', 'should', 'may', 'might', 'must', 'shall', 'can', 'need',
    'what', 'which', 'who', 'whom', 'this', 'that', 'these', 'those',
    'how', 'why', 'when', 'where', 'i', 'you', 'he', 'she', 'it', 'we', 'they',
  ]);

  return query
    .toLowerCase()
    .split(/\s+/)
    .filter((word) => word.length >= 3 && !stopWords.has(word))
    .slice(0, 10); // Limit to 10 keywords
}
