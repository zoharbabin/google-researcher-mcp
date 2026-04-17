/**
 * Quality Scoring Module
 *
 * Scores scraped content by multiple quality factors:
 * - Relevance: Query term matching and keyword density
 * - Freshness: Publication date recency
 * - Authority: Domain reputation (TLD and known domains)
 * - Content Quality: Length, structure, readability
 */

// ── Types ────────────────────────────────────────────────────────────────────

/**
 * Quality scores for a source
 */
export interface QualityScores {
  /** Composite score (0-1, weighted average) */
  overall: number;
  /** Query relevance score (0-1) */
  relevance: number;
  /** Content freshness score (0-1) */
  freshness: number;
  /** Domain authority score (0-1) */
  authority: number;
  /** Content quality score (0-1) */
  contentQuality: number;
}

/**
 * Configurable weights for scoring factors
 */
export interface QualityWeights {
  relevance: number;
  freshness: number;
  authority: number;
  contentQuality: number;
}

/**
 * Source with quality scores attached
 */
export interface SourceWithQuality {
  url: string;
  content: string;
  scores: QualityScores;
  metadata?: {
    title?: string;
    publishedDate?: string;
    domain?: string;
  };
}

/**
 * Options for scoring and ranking sources
 */
export interface QualityScoringOptions {
  /** Search query for relevance scoring */
  query: string;
  /** Custom weights (optional) */
  weights?: Partial<QualityWeights>;
  /** Minimum score threshold for filtering (0-1) */
  minScore?: number;
}

// ── Default Configuration ────────────────────────────────────────────────────

/**
 * Default weights for quality scoring factors
 */
export const DEFAULT_WEIGHTS: QualityWeights = {
  relevance: 0.35,
  freshness: 0.20,
  authority: 0.25,
  contentQuality: 0.20,
};

/**
 * Domain authority scores by TLD and known domains
 * Higher scores indicate more authoritative sources
 */
export const DOMAIN_AUTHORITY: Record<string, number> = {
  // Government and education - highest authority
  '.gov': 0.95,
  '.edu': 0.90,
  '.gov.uk': 0.92,
  '.ac.uk': 0.88,

  // Major authoritative sources
  'wikipedia.org': 0.85,
  'nature.com': 0.92,
  'science.org': 0.92,
  'sciencedirect.com': 0.88,
  'pubmed.ncbi.nlm.nih.gov': 0.90,

  // Major news outlets
  'reuters.com': 0.85,
  'apnews.com': 0.85,
  'bbc.com': 0.82,
  'bbc.co.uk': 0.82,
  'nytimes.com': 0.80,
  'theguardian.com': 0.78,
  'washingtonpost.com': 0.78,

  // Technical/developer resources
  'github.com': 0.80,
  'stackoverflow.com': 0.82,
  'developer.mozilla.org': 0.88,
  'docs.microsoft.com': 0.85,
  'cloud.google.com': 0.85,
  'aws.amazon.com': 0.85,

  // Standard TLDs
  '.org': 0.65,
  '.com': 0.50,
  '.net': 0.50,
  '.io': 0.45,

  // Lower authority / user-generated content
  'medium.com': 0.45,
  'dev.to': 0.45,
  'reddit.com': 0.40,
  'quora.com': 0.40,
  'twitter.com': 0.35,
  'x.com': 0.35,
  'facebook.com': 0.30,
};

// ── Scoring Functions ────────────────────────────────────────────────────────

/**
 * Calculates relevance score based on query term matching
 *
 * @param content - The text content to analyze
 * @param query - The search query
 * @returns Relevance score (0-1)
 */
export function scoreRelevance(content: string, query: string): number {
  if (!content || !query) return 0.5;

  const normalizedContent = content.toLowerCase();
  const lowerQuery = query.toLowerCase();
  const queryTerms = lowerQuery
    .split(/\s+/)
    .filter((term) => term.length > 2);

  if (queryTerms.length === 0) return 0.5;

  // Pre-compile all regexes once for the query
  const termRegexes = queryTerms.map(term =>
    new RegExp(`\\b${escapeRegex(term)}\\b`, 'gi')
  );

  const exactPhraseBonus = normalizedContent.includes(lowerQuery) ? 0.3 : 0;

  let matchScore = 0;
  for (const regex of termRegexes) {
    regex.lastIndex = 0;
    const matches = normalizedContent.match(regex);
    if (matches) {
      matchScore += Math.min(matches.length / 5, 1) / queryTerms.length;
    }
  }

  return Math.min(matchScore + exactPhraseBonus, 1.0);
}

/**
 * Calculates freshness score based on publication date
 *
 * @param publishedDate - ISO date string or Date object
 * @returns Freshness score (0-1)
 */
export function scoreFreshness(publishedDate?: string | Date): number {
  if (!publishedDate) return 0.5; // Unknown date gets neutral score

  try {
    const pubDate = new Date(publishedDate);
    const now = new Date();

    // Invalid date
    if (isNaN(pubDate.getTime())) return 0.5;

    const daysSincePublication =
      (now.getTime() - pubDate.getTime()) / (1000 * 60 * 60 * 24);

    // Future date is suspicious
    if (daysSincePublication < 0) return 0.5;

    // Decay function based on age
    if (daysSincePublication <= 7) return 1.0; // Within a week
    if (daysSincePublication <= 30) return 0.9; // Within a month
    if (daysSincePublication <= 90) return 0.75; // Within 3 months
    if (daysSincePublication <= 180) return 0.6; // Within 6 months
    if (daysSincePublication <= 365) return 0.5; // Within a year
    if (daysSincePublication <= 730) return 0.35; // Within 2 years

    return 0.2; // Older than 2 years
  } catch {
    return 0.5;
  }
}

/**
 * Calculates authority score based on domain reputation
 *
 * @param url - The source URL
 * @returns Authority score (0-1)
 */
export function scoreAuthority(url: string): number {
  try {
    const hostname = new URL(url).hostname.toLowerCase();

    // Check for exact domain matches first (more specific)
    for (const [domain, score] of Object.entries(DOMAIN_AUTHORITY)) {
      if (!domain.startsWith('.') && hostname.includes(domain)) {
        return score;
      }
    }

    // Check TLD matches (less specific)
    for (const [tld, score] of Object.entries(DOMAIN_AUTHORITY)) {
      if (tld.startsWith('.') && hostname.endsWith(tld)) {
        return score;
      }
    }

    // Default for unknown domains
    return 0.50;
  } catch {
    return 0.30; // Invalid URL gets low score
  }
}

/**
 * Calculates content quality score based on structure and characteristics
 *
 * @param content - The text content to analyze
 * @returns Content quality score (0-1)
 */
export function scoreContentQuality(content: string): number {
  if (!content) return 0.0;

  let score = 0.5; // Start at neutral

  // Length scoring (optimal range: 500-5000 characters)
  const length = content.length;
  if (length < 100) {
    score -= 0.25; // Very short content
  } else if (length < 500) {
    score -= 0.1; // Short content
  } else if (length >= 500 && length <= 5000) {
    score += 0.15; // Ideal length
  } else if (length > 5000 && length <= 15000) {
    score += 0.1; // Good length
  } else if (length > 15000) {
    score += 0.05; // Very long, might be verbose
  }

  // Structure indicators
  const paragraphs = content.split(/\n\n+/).filter((p) => p.trim().length > 20);
  const hasGoodParagraphs = paragraphs.length >= 2;

  const hasHeadings =
    /^#{1,6}\s|^[A-Z][^.!?]*:\s*$/m.test(content) ||
    /<h[1-6]>/i.test(content);

  const hasList =
    /^\s*[-*\u2022]\s/m.test(content) || /^\s*\d+\.\s/m.test(content);

  if (hasGoodParagraphs) score += 0.1;
  if (hasHeadings) score += 0.1;
  if (hasList) score += 0.05;

  // Readability indicators
  const sentences = content.split(/[.!?]+/).filter((s) => s.trim().length > 0);
  const avgSentenceLength =
    sentences.length > 0 ? content.length / sentences.length : 0;

  // Ideal sentence length: 50-200 characters (10-40 words)
  if (avgSentenceLength >= 50 && avgSentenceLength <= 200) {
    score += 0.1;
  } else if (avgSentenceLength > 300) {
    score -= 0.1; // Very long sentences are hard to read
  }

  // Check for excessive special characters or formatting issues
  const specialCharRatio =
    (content.match(/[^\w\s.,!?;:'"()-]/g) || []).length / content.length;
  if (specialCharRatio > 0.1) {
    score -= 0.1; // Too many special characters
  }

  return Math.max(0, Math.min(1, score));
}

// ── Main Scoring Functions ───────────────────────────────────────────────────

/**
 * Scores a single source across all quality dimensions
 *
 * @param url - Source URL
 * @param content - Source content
 * @param query - Search query for relevance scoring
 * @param publishedDate - Publication date (optional)
 * @param weights - Custom weights (optional)
 * @returns Quality scores object
 */
export function scoreSource(
  url: string,
  content: string,
  query: string,
  publishedDate?: string,
  weights: QualityWeights = DEFAULT_WEIGHTS
): QualityScores {
  const relevance = scoreRelevance(content, query);
  const freshness = scoreFreshness(publishedDate);
  const authority = scoreAuthority(url);
  const contentQuality = scoreContentQuality(content);

  // Calculate weighted overall score
  const overall =
    relevance * weights.relevance +
    freshness * weights.freshness +
    authority * weights.authority +
    contentQuality * weights.contentQuality;

  return {
    overall: roundToTwoDecimals(overall),
    relevance: roundToTwoDecimals(relevance),
    freshness: roundToTwoDecimals(freshness),
    authority: roundToTwoDecimals(authority),
    contentQuality: roundToTwoDecimals(contentQuality),
  };
}

/**
 * Scores and ranks multiple sources by quality
 *
 * @param sources - Array of sources to score
 * @param options - Scoring options
 * @returns Sorted array of sources with quality scores
 */
export function scoreAndRankSources(
  sources: Array<{ url: string; content: string; publishedDate?: string }>,
  options: QualityScoringOptions
): SourceWithQuality[] {
  const { query, weights = {}, minScore = 0 } = options;
  const finalWeights = { ...DEFAULT_WEIGHTS, ...weights };

  const scored = sources.map((source) => {
    const scores = scoreSource(
      source.url,
      source.content,
      query,
      source.publishedDate,
      finalWeights
    );

    let domain: string | undefined;
    try {
      domain = new URL(source.url).hostname;
    } catch {
      domain = undefined;
    }

    return {
      url: source.url,
      content: source.content,
      scores,
      metadata: {
        publishedDate: source.publishedDate,
        domain,
      },
    };
  });

  // Filter by minimum score and sort by overall score descending
  return scored
    .filter((s) => s.scores.overall >= minScore)
    .sort((a, b) => b.scores.overall - a.scores.overall);
}

/**
 * Gets the top N sources by quality score
 *
 * @param sources - Array of sources to score
 * @param query - Search query
 * @param topN - Number of top sources to return
 * @returns Top N sources with quality scores
 */
export function getTopSources(
  sources: Array<{ url: string; content: string; publishedDate?: string }>,
  query: string,
  topN: number = 3
): SourceWithQuality[] {
  return scoreAndRankSources(sources, { query }).slice(0, topN);
}

/**
 * Gets the average quality score across sources
 *
 * @param sources - Array of scored sources
 * @returns Average scores across all dimensions
 */
export function getAverageScores(sources: SourceWithQuality[]): QualityScores | null {
  if (sources.length === 0) return null;

  const sum = sources.reduce(
    (acc, s) => ({
      overall: acc.overall + s.scores.overall,
      relevance: acc.relevance + s.scores.relevance,
      freshness: acc.freshness + s.scores.freshness,
      authority: acc.authority + s.scores.authority,
      contentQuality: acc.contentQuality + s.scores.contentQuality,
    }),
    { overall: 0, relevance: 0, freshness: 0, authority: 0, contentQuality: 0 }
  );

  const count = sources.length;
  return {
    overall: roundToTwoDecimals(sum.overall / count),
    relevance: roundToTwoDecimals(sum.relevance / count),
    freshness: roundToTwoDecimals(sum.freshness / count),
    authority: roundToTwoDecimals(sum.authority / count),
    contentQuality: roundToTwoDecimals(sum.contentQuality / count),
  };
}

// ── Utility Functions ────────────────────────────────────────────────────────

/**
 * Escapes special regex characters in a string
 */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Rounds a number to two decimal places
 */
function roundToTwoDecimals(num: number): number {
  return Math.round(num * 100) / 100;
}
