/**
 * Type Definitions for Google Custom Search API Responses
 *
 * These interfaces provide type-safe access to Google API responses,
 * replacing unsafe `as any` casts throughout the codebase.
 */

// ── Google Search API Response Types ─────────────────────────────────────────

/**
 * Individual search result item from Google Custom Search API
 */
export interface GoogleSearchItem {
  /** Result title */
  title: string;
  /** URL of the result */
  link: string;
  /** Display URL (shortened/pretty version) */
  displayLink: string;
  /** Snippet/description of the result */
  snippet?: string;
  /** HTML snippet with highlighting */
  htmlSnippet?: string;
  /** Formatted URL for display */
  formattedUrl?: string;
  /** Cache information */
  cacheId?: string;
  /** Page map metadata */
  pagemap?: GoogleSearchPagemap;
}

/**
 * Page map metadata from search results
 */
export interface GoogleSearchPagemap {
  /** Meta tags from the page */
  metatags?: Array<Record<string, string>>;
  /** CSE thumbnails */
  cse_thumbnail?: Array<{
    src: string;
    width: string;
    height: string;
  }>;
  /** CSE images */
  cse_image?: Array<{
    src: string;
  }>;
}

/**
 * Search information metadata
 */
export interface GoogleSearchInformation {
  /** Total results (as string from API) */
  totalResults: string;
  /** Time taken for search */
  searchTime: number;
  /** Formatted total results */
  formattedTotalResults?: string;
  /** Formatted search time */
  formattedSearchTime?: string;
}

/**
 * Full response from Google Custom Search API
 */
export interface GoogleSearchResponse {
  /** Search result items */
  items?: GoogleSearchItem[];
  /** Search metadata */
  searchInformation?: GoogleSearchInformation;
  /** Query information */
  queries?: {
    request?: Array<{
      totalResults: string;
      searchTerms: string;
      count: number;
      startIndex: number;
    }>;
    nextPage?: Array<{
      totalResults: string;
      searchTerms: string;
      count: number;
      startIndex: number;
    }>;
  };
  /** Error information if request failed */
  error?: GoogleApiError;
}

// ── Google Image Search Response Types ───────────────────────────────────────

/**
 * Image-specific metadata in search results
 */
export interface GoogleImageInfo {
  /** URL to thumbnail */
  thumbnailLink?: string;
  /** URL to the page containing the image */
  contextLink?: string;
  /** Image width in pixels */
  width?: number;
  /** Image height in pixels */
  height?: number;
  /** Thumbnail width */
  thumbnailWidth?: number;
  /** Thumbnail height */
  thumbnailHeight?: number;
  /** File size in bytes */
  byteSize?: number;
}

/**
 * Image search result item
 */
export interface GoogleImageSearchItem extends GoogleSearchItem {
  /** Image-specific information */
  image?: GoogleImageInfo;
  /** MIME type of the image */
  mime?: string;
  /** File format */
  fileFormat?: string;
}

/**
 * Response from Google Image Search API
 */
export interface GoogleImageSearchResponse {
  /** Image search results */
  items?: GoogleImageSearchItem[];
  /** Search metadata */
  searchInformation?: GoogleSearchInformation;
  /** Error information */
  error?: GoogleApiError;
}

// ── Google News Search Response Types ────────────────────────────────────────

/**
 * News-specific metadata in search results
 */
export interface GoogleNewsMetadata {
  /** Article published time (ISO format) */
  'article:published_time'?: string;
  /** Last updated time (ISO format) */
  'og:updated_time'?: string;
  /** Open Graph title */
  'og:title'?: string;
  /** Open Graph description */
  'og:description'?: string;
  /** Author name */
  'article:author'?: string;
  /** Site name */
  'og:site_name'?: string;
}

/**
 * News search result item
 */
export interface GoogleNewsSearchItem extends GoogleSearchItem {
  /** Enhanced pagemap with news-specific metadata */
  pagemap?: GoogleSearchPagemap & {
    metatags?: GoogleNewsMetadata[];
  };
}

/**
 * Response from Google News Search
 */
export interface GoogleNewsSearchResponse {
  /** News search results */
  items?: GoogleNewsSearchItem[];
  /** Search metadata */
  searchInformation?: GoogleSearchInformation;
  /** Error information */
  error?: GoogleApiError;
}

// ── Normalized Search Result (provider-agnostic) ─────────────────────────────

/**
 * A provider-agnostic search result that normalizes Google and Tavily responses
 * so both providers feed the same downstream formatters.
 *
 * TODO: Currently unused — the actual data contract is TextContent[] (URL-only).
 * Reserved for a planned future refactor that surfaces titles/snippets downstream.
 */
interface NormalizedSearchResult {
  /** Result title */
  title: string;
  /** URL of the result */
  url: string;
  /** Snippet or content excerpt */
  snippet: string;
  /** Relevance score (0-1, optional — Tavily provides this natively) */
  score?: number;
  /** Which provider returned this result */
  provider: 'google' | 'tavily';
}

// ── Error Types ──────────────────────────────────────────────────────────────

/**
 * Google API error structure
 */
export interface GoogleApiError {
  /** Error code */
  code: number;
  /** Error message */
  message: string;
  /** Error status */
  status?: string;
  /** Detailed errors */
  errors?: Array<{
    message: string;
    domain: string;
    reason: string;
  }>;
}

// ── Type Guards ──────────────────────────────────────────────────────────────

/**
 * Type guard to check if a value is a Google API error response
 */
export function isGoogleApiError(
  response: unknown
): response is { error: GoogleApiError } {
  return (
    typeof response === 'object' &&
    response !== null &&
    'error' in response &&
    typeof (response as { error: unknown }).error === 'object'
  );
}

/**
 * Type guard for Google Search response
 */
export function isGoogleSearchResponse(
  response: unknown
): response is GoogleSearchResponse {
  return (
    typeof response === 'object' &&
    response !== null &&
    (('items' in response && Array.isArray((response as GoogleSearchResponse).items)) ||
      ('searchInformation' in response))
  );
}

// ── Utility Types ────────────────────────────────────────────────────────────

/**
 * Safe error message extraction
 */
export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === 'string') {
    return error;
  }
  if (
    typeof error === 'object' &&
    error !== null &&
    'message' in error &&
    typeof (error as { message: unknown }).message === 'string'
  ) {
    return (error as { message: string }).message;
  }
  return String(error);
}

/**
 * Check if an error is an instance of Error
 */
export function isError(error: unknown): error is Error {
  return error instanceof Error;
}
