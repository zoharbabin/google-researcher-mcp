/**
 * MCP Prompts Module
 *
 * Implements MCP Prompts primitive to provide reusable research workflow
 * templates that clients can discover and execute.
 *
 * Prompts:
 * - comprehensive-research: Deep research on a topic with multiple sources
 * - fact-check: Verify a claim using authoritative sources
 * - summarize-url: Extract and summarize content from a URL
 * - news-briefing: Get a current news summary on a topic
 * - due-diligence-background: Background & reputational DD research on a company
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

// ── Types ────────────────────────────────────────────────────────────────────

/**
 * Depth options for research
 */
export type ResearchDepth = 'quick' | 'standard' | 'deep';

/**
 * Format options for summaries
 */
export type SummaryFormat = 'brief' | 'detailed' | 'bullets';

/**
 * Time range options for news
 */
export type NewsTimeRange = 'hour' | 'day' | 'week' | 'month';

// ── Prompt Registration ──────────────────────────────────────────────────────

/**
 * Registers all MCP prompts with the server
 *
 * @param server - The MCP server instance
 */
export function registerPrompts(server: McpServer): void {
  registerComprehensiveResearch(server);
  registerFactCheck(server);
  registerSummarizeUrl(server);
  registerNewsBriefing(server);
  registerPatentPortfolioAnalysis(server);
  registerCompetitiveAnalysis(server);
  registerLiteratureReview(server);
  registerTechnicalDeepDive(server);
  registerDueDiligenceBackground(server);
}

// ── Individual Prompt Implementations ────────────────────────────────────────

/**
 * Registers the comprehensive-research prompt
 */
function registerComprehensiveResearch(server: McpServer): void {
  server.prompt(
    'comprehensive-research',
    {
      topic: z
        .string()
        .min(1)
        .max(500)
        .describe('The topic or question to research'),
      depth: z
        .enum(['quick', 'standard', 'deep'])
        .default('standard')
        .describe(
          'Research depth: quick (3 sources), standard (5 sources), deep (8 sources)'
        ),
    },
    async ({ topic, depth = 'standard' }) => {
      const numSources =
        depth === 'quick' ? 3 : depth === 'standard' ? 5 : 8;

      return {
        messages: [
          {
            role: 'user' as const,
            content: {
              type: 'text' as const,
              text: `I need you to research the following topic comprehensively:

**Topic:** ${topic}

**Research Instructions:**
1. Use the \`search_and_scrape\` tool with num_results=${numSources} to gather information from multiple sources
2. For each finding, note the source URL for proper citation
3. Look for both consensus AND disagreement among sources
4. Identify any gaps or limitations in the available information
5. Consider source authority and recency when weighing evidence

**Output Format:**
Please structure your response as follows:

## Executive Summary
(2-3 sentences overview of key findings)

## Key Findings
(Bulleted list of main points with inline citations [Source 1], [Source 2], etc.)

## Different Perspectives
(If sources disagree, explain the different viewpoints)

## Limitations & Gaps
(What couldn't be verified or is missing from available sources)

## Sources
(Numbered list of all URLs used)

---

Begin by calling the search_and_scrape tool with the topic.`,
            },
          },
        ],
      };
    }
  );
}

/**
 * Registers the fact-check prompt
 */
function registerFactCheck(server: McpServer): void {
  server.prompt(
    'fact-check',
    {
      claim: z
        .string()
        .min(1)
        .max(1000)
        .describe('The claim or statement to verify'),
      sources: z
        .coerce.number()
        .min(2)
        .max(8)
        .default(4)
        .describe('Number of sources to check (2-8)'),
    },
    async ({ claim, sources = 4 }) => ({
      messages: [
        {
          role: 'user' as const,
          content: {
            type: 'text' as const,
            text: `Please fact-check the following claim:

**Claim:** "${claim}"

**Verification Process:**
1. Use \`search_and_scrape\` with num_results=${sources} to find evidence
2. Specifically look for:
   - Direct evidence supporting the claim
   - Direct evidence contradicting the claim
   - Contextual information that affects interpretation
3. Prefer authoritative sources (academic, government, established news outlets)
4. Note the publication date of each source to assess recency

**Output Format:**
Please structure your response as follows:

## Verdict
**[TRUE / FALSE / PARTIALLY TRUE / UNVERIFIED]**

## Confidence Level
**[High / Medium / Low]** — explain why

## Supporting Evidence
(Evidence that supports the claim, with source citations)

## Contradicting Evidence
(Evidence that contradicts the claim, with source citations)

## Important Context
(Additional context that affects how we should interpret this claim)

## Methodology
(Brief note on what sources were consulted)

## Sources
(Numbered list of URLs)

---

Begin verification by searching for evidence related to this claim.`,
          },
        },
      ],
    })
  );
}

/**
 * Registers the summarize-url prompt
 */
function registerSummarizeUrl(server: McpServer): void {
  server.prompt(
    'summarize-url',
    {
      url: z.string().url().describe('The URL to summarize'),
      format: z
        .enum(['brief', 'detailed', 'bullets'])
        .default('detailed')
        .describe(
          'Output format: brief (1 paragraph), detailed (comprehensive), bullets (key points)'
        ),
    },
    async ({ url, format = 'detailed' }) => {
      const formatInstructions: Record<SummaryFormat, string> = {
        brief:
          'Provide a single paragraph summary (3-5 sentences) covering the main point.',
        detailed:
          'Provide a comprehensive summary including: main thesis, key arguments, supporting evidence, and conclusions.',
        bullets:
          'Provide a bulleted list of 5-10 key points, each being one clear takeaway.',
      };

      return {
        messages: [
          {
            role: 'user' as const,
            content: {
              type: 'text' as const,
              text: `Please summarize the content at this URL:

**URL:** ${url}

**Format:** ${format}

**Instructions:**
1. Use the \`scrape_page\` tool to retrieve the content
2. ${formatInstructions[format]}
3. Include any relevant metadata (author, date, publication) if available from the citation
4. Note if the content appears to be truncated or incomplete

**Output Format:**

## Title
[The title of the article/page]

## Summary
[Your summary in the requested format]

## Key Takeaways
- [Main point 1]
- [Main point 2]
- [Main point 3]

## Source Information
- **Author:** [If available]
- **Published:** [If available]
- **Site:** [Site name]

---

Begin by scraping the URL.`,
            },
          },
        ],
      };
    }
  );
}

/**
 * Registers the news-briefing prompt
 */
function registerNewsBriefing(server: McpServer): void {
  server.prompt(
    'news-briefing',
    {
      topic: z
        .string()
        .min(1)
        .max(200)
        .describe('The news topic to get a briefing on'),
      timeRange: z
        .enum(['hour', 'day', 'week', 'month'])
        .default('week')
        .describe('How recent the news should be'),
    },
    async ({ topic, timeRange = 'week' }) => {
      const timeDescriptions: Record<NewsTimeRange, string> = {
        hour: 'the past hour (breaking news)',
        day: 'the past 24 hours',
        week: 'the past week',
        month: 'the past month',
      };

      return {
        messages: [
          {
            role: 'user' as const,
            content: {
              type: 'text' as const,
              text: `Create a news briefing on:

**Topic:** ${topic}
**Time Range:** ${timeDescriptions[timeRange]}

**Instructions:**
1. Use \`google_news_search\` with freshness="${timeRange}" to find recent news
2. Then use \`scrape_page\` on the top 3-5 most relevant results for full details
3. Synthesize the information into a coherent briefing

**Output Format:**

## Headline Summary
(One sentence capturing the overall state of this topic)

## Key Developments
(3-5 main news items, each with:)
- **What happened:** Brief description
- **When:** Date/time
- **Source:** Publication name
- **Link:** URL

## Analysis
(What this means in context, patterns or trends you notice)

## What to Watch
(Upcoming events, expected developments, or open questions)

## Sources Used
(List of all sources consulted)

---

Begin by searching for recent news on this topic.`,
            },
          },
        ],
      };
    }
  );
}

// ── Patent Portfolio Analysis ─────────────────────────────────────────────────

/**
 * Registers the patent-portfolio-analysis prompt
 */
function registerPatentPortfolioAnalysis(server: McpServer): void {
  server.prompt(
    'patent-portfolio-analysis',
    {
      company: z
        .string()
        .min(1)
        .max(200)
        .describe('The company name to analyze (include known subsidiaries)'),
      includeSubsidiaries: z
        .boolean()
        .default(true)
        .describe('Whether to search for subsidiary company patents'),
    },
    async ({ company, includeSubsidiaries = true }) => ({
      messages: [
        {
          role: 'user' as const,
          content: {
            type: 'text' as const,
            text: `Conduct a comprehensive patent portfolio analysis for:

**Company:** ${company}
**Include Subsidiaries:** ${includeSubsidiaries ? 'Yes' : 'No'}

**Research Process:**
1. Use \`scrape_page\` on \`https://patents.google.com/?assignee=${encodeURIComponent(company)}\` to get the full patent list
${includeSubsidiaries ? `2. Search for known subsidiaries and acquisitions using \`search_and_scrape\`
3. Scrape patent pages for each subsidiary found` : ''}
4. Compile all patents into a unified analysis

**Output Format:**

## Executive Summary
(Overview of patent portfolio strength, focus areas, key findings)

## Patent Portfolio Overview
| Metric | Value |
|--------|-------|
| Total Patents | [count] |
| Granted vs Pending | [breakdown] |
| Date Range | [earliest] - [latest] |
| Primary Assignees | [list] |

## Patents by Technology Area
(Group patents by CPC classification or technology theme)

| Technology Area | Count | Key Patents |
|-----------------|-------|-------------|
| [Area 1] | [n] | [Patent numbers] |

## Complete Patent List
| # | Patent Number | Title | Assignee | Status | Priority Date | Key Claims |
|---|--------------|-------|----------|--------|---------------|------------|

## Key Inventors
| Inventor | Patent Count | Primary Technologies |
|----------|--------------|---------------------|

## Competitive Positioning
(How this portfolio compares to industry, any gaps or strengths)

## Recommendations
(Actionable insights based on the analysis)

---

Begin by scraping the Google Patents page for ${company}.`,
          },
        },
      ],
    })
  );
}

// ── Competitive Analysis ──────────────────────────────────────────────────────

/**
 * Registers the competitive-analysis prompt
 */
function registerCompetitiveAnalysis(server: McpServer): void {
  server.prompt(
    'competitive-analysis',
    {
      entities: z
        .string()
        .min(1)
        .max(500)
        .describe('Comma-separated list of companies/products to compare'),
      aspects: z
        .string()
        .max(500)
        .optional()
        .describe('Specific aspects to compare (e.g., pricing, features, market share)'),
    },
    async ({ entities, aspects }) => {
      const entityList = entities.split(',').map((e) => e.trim());

      return {
        messages: [
          {
            role: 'user' as const,
            content: {
              type: 'text' as const,
              text: `Conduct a competitive analysis comparing:

**Entities:** ${entityList.join(', ')}
${aspects ? `**Focus Areas:** ${aspects}` : '**Focus Areas:** Features, market position, strengths, weaknesses'}

**Research Process:**
1. Use \`search_and_scrape\` to research each entity:
${entityList.map((e, i) => `   ${i + 1}. Search for "${e} company overview features""`).join('\n')}
2. Search for direct comparison articles: "${entityList.join(' vs ')}"
3. Look for industry analysis and market reports

**Output Format:**

## Executive Summary
(Key differentiators and overall winner by category)

## Comparison Matrix
| Aspect | ${entityList.join(' | ')} |
|--------|${entityList.map(() => '-----').join('|')}|
| [Aspect 1] | [Value] | [Value] | ... |
| [Aspect 2] | [Value] | [Value] | ... |

## Individual Profiles

${entityList.map((e) => `### ${e}
- **Overview:**
- **Key Strengths:**
- **Key Weaknesses:**
- **Market Position:**
- **Recent Developments:**
`).join('\n')}

## Head-to-Head Analysis
(Direct comparison with supporting evidence)

## Market Positioning Map
(Describe how each entity positions in the market)

## Recommendations
(Which entity is best for different use cases)

## Sources
(All URLs consulted with dates)

---

Begin by researching the first entity: ${entityList[0]}`,
            },
          },
        ],
      };
    }
  );
}

// ── Literature Review ─────────────────────────────────────────────────────────

/**
 * Registers the literature-review prompt
 */
function registerLiteratureReview(server: McpServer): void {
  server.prompt(
    'literature-review',
    {
      topic: z
        .string()
        .min(1)
        .max(500)
        .describe('The research topic for literature review'),
      yearFrom: z
        .coerce.number()
        .min(1900)
        .max(2030)
        .optional()
        .describe('Start year for publications'),
      sources: z
        .coerce.number()
        .min(3)
        .max(10)
        .default(5)
        .describe('Number of academic sources to find'),
    },
    async ({ topic, yearFrom, sources = 5 }) => ({
      messages: [
        {
          role: 'user' as const,
          content: {
            type: 'text' as const,
            text: `Conduct an academic literature review on:

**Topic:** ${topic}
${yearFrom ? `**Year Range:** ${yearFrom} - present` : '**Year Range:** Recent publications'}
**Target Sources:** ${sources} academic papers

**Research Process:**
1. Use \`academic_search\` with num_results=${sources}${yearFrom ? ` and year_from=${yearFrom}` : ''} to find relevant papers
2. For each paper found, note:
   - Full citation (use the provided APA/MLA/BibTeX)
   - Key findings
   - Methodology
   - How it relates to the research question
3. Identify themes, agreements, and disagreements across sources

**Output Format:**

## Abstract
(150-200 word summary of the review)

## Introduction
(Context and importance of the topic, research questions)

## Methodology
(How sources were selected, databases searched, inclusion criteria)

## Thematic Analysis

### Theme 1: [Name]
(Synthesis of findings across papers related to this theme)
- Key findings from [Author1, Year]
- Related findings from [Author2, Year]

### Theme 2: [Name]
(Continue for each major theme)

## Summary of Key Papers
| Paper | Authors | Year | Key Contribution | Methodology |
|-------|---------|------|------------------|-------------|

## Gaps in the Literature
(What hasn't been studied, limitations of current research)

## Conclusions
(Synthesis of overall findings, implications)

## Future Research Directions
(Suggested areas for further investigation)

## References
(Full academic citations in APA format)

---

Begin by searching for academic papers on: ${topic}`,
          },
        },
      ],
    })
  );
}

// ── Technical Deep Dive ───────────────────────────────────────────────────────

/**
 * Registers the technical-deep-dive prompt
 */
function registerTechnicalDeepDive(server: McpServer): void {
  server.prompt(
    'technical-deep-dive',
    {
      technology: z
        .string()
        .min(1)
        .max(300)
        .describe('The technology, framework, or concept to investigate'),
      focusArea: z
        .enum(['architecture', 'implementation', 'comparison', 'best-practices', 'troubleshooting'])
        .default('implementation')
        .describe('What aspect to focus on'),
    },
    async ({ technology, focusArea = 'implementation' }) => {
      const focusInstructions: Record<string, string> = {
        architecture: 'Focus on system design, components, data flow, and architectural patterns.',
        implementation: 'Focus on how to implement, code examples, setup, and configuration.',
        comparison: 'Focus on comparing with alternatives, trade-offs, and when to use what.',
        'best-practices': 'Focus on recommended patterns, anti-patterns, and production considerations.',
        troubleshooting: 'Focus on common issues, debugging techniques, and solutions.',
      };

      return {
        messages: [
          {
            role: 'user' as const,
            content: {
              type: 'text' as const,
              text: `Conduct a technical deep dive on:

**Technology:** ${technology}
**Focus Area:** ${focusArea}

**Focus Instructions:** ${focusInstructions[focusArea]}

**Research Process:**
1. Use \`search_and_scrape\` with query "${technology} ${focusArea} guide" (num_results=5)
2. Search for official documentation: "${technology} official documentation"
3. Look for practical examples: "${technology} example tutorial"
4. Find community discussions for real-world insights

**Output Format:**

## Overview
(What is ${technology}, why it matters, when to use it)

## ${focusArea === 'architecture' ? 'Architecture' : focusArea === 'comparison' ? 'Comparison' : 'Technical Details'}

${focusArea === 'architecture' ? `### System Components
(Diagram description or component list)

### Data Flow
(How data moves through the system)

### Key Design Decisions
(Trade-offs and why they were made)` : ''}

${focusArea === 'implementation' ? `### Prerequisites
- [List requirements]

### Step-by-Step Guide
1. [Step 1]
2. [Step 2]
...

### Code Examples
\`\`\`
[Relevant code snippets]
\`\`\`

### Configuration
[Key configuration options]` : ''}

${focusArea === 'comparison' ? `### Alternatives
| Feature | ${technology} | Alternative 1 | Alternative 2 |
|---------|--------------|---------------|---------------|

### When to Choose ${technology}
(Use cases where it excels)

### When to Choose Alternatives
(Use cases where alternatives are better)` : ''}

${focusArea === 'best-practices' ? `### Do's
- [Best practice 1]
- [Best practice 2]

### Don'ts (Anti-patterns)
- [Anti-pattern 1]
- [Anti-pattern 2]

### Production Considerations
[Scaling, monitoring, security]` : ''}

${focusArea === 'troubleshooting' ? `### Common Issues
| Issue | Cause | Solution |
|-------|-------|----------|

### Debugging Techniques
[How to debug effectively]

### FAQ
[Frequently encountered problems]` : ''}

## Key Takeaways
(3-5 most important points to remember)

## Further Reading
(Links to official docs, tutorials, related topics)

## Sources
(All URLs with access dates)

---

Begin researching: ${technology}`,
            },
          },
        ],
      };
    }
  );
}

// ── Due Diligence Background Research ────────────────────────────────────────

/**
 * Registers the due-diligence-background prompt
 */
function registerDueDiligenceBackground(server: McpServer): void {
  server.prompt(
    'due-diligence-background',
    {
      companyName: z
        .string()
        .min(1)
        .max(200)
        .describe('The company name to research (e.g., "PathFactory")'),
    },
    async ({ companyName }) => {
      return {
        messages: [
          {
            role: 'user' as const,
            content: {
              type: 'text' as const,
              text: `Conduct public-source background and reputational due diligence research on a company. Find any publicly disclosed security breaches, data leaks, compliance violations, regulatory enforcement actions, lawsuits, executive scandals, or other concerning issues. Also document positive security posture findings (certifications, trust pages).

**Target Company:** ${companyName}

---

Execute the following phases in order. Use \`sequential_search\` to track progress across phases. Budget: ~20-25 queries maximum.

## PHASE 0 - DISCOVERY (find everything about the company first)

You must discover ALL of the following before proceeding to screening phases. Use \`search_and_scrape\` and \`google_search\` as needed.

### 0.1 - Find the company website
- \`google_search\`: "${companyName}" official website (num_results: 3)
- Identify the primary company domain (e.g., companyname.com). Record as COMPANY_WEBSITE and COMPANY_DOMAIN.

### 0.2 - Find all entity names (current name, prior names, subsidiaries, DBAs, acquired entities)
- \`search_and_scrape\`: "${companyName}" formerly known as OR "previously named" OR rebrand OR renamed (num_results: 3)
- \`search_and_scrape\`: "${companyName}" subsidiary OR subsidiaries OR "acquired" OR acquisition OR "parent company" (num_results: 3)
- \`google_search\`: site:COMPANY_DOMAIN "formerly" OR "previously" OR "now known as" (num_results: 3)
- Record ALL entity names found: the current company name, all prior/historical names, all subsidiaries, DBAs, and any companies they acquired. This is the ENTITY_LIST.

### 0.3 - Find key executives and board members
- \`search_and_scrape\`: "${companyName}" CEO OR founder OR "board of directors" OR executives OR leadership (num_results: 3)
- \`google_search\`: site:COMPANY_DOMAIN about OR team OR leadership OR "board of directors" (num_results: 3)
- Scrape the company's about/team/leadership page if found.
- Record ALL current and former executives, founders, and board members. Include their titles. This is the EXECUTIVE_LIST.

### 0.4 - Summarize discovery
Before proceeding, print a summary:
- **Company Website:** [URL]
- **All Entity Names Found:** [list each with type: current name / prior name / subsidiary / acquired entity]
- **All Executives Found:** [list each with title]

---

Now proceed with screening using the ENTITY_LIST and EXECUTIVE_LIST discovered above.

## PHASE 1 - COMPANY'S OWN DISCLOSURES (highest signal, do first)
- Use \`scrape_page\` on: COMPANY_WEBSITE/security (or /trust, /trust-center)
- Use \`scrape_page\` on: COMPANY_WEBSITE/privacy (or /privacy-policy)
- Use \`google_search\`: site:COMPANY_DOMAIN SOC2 OR ISO27001 OR "security certification" OR "penetration testing" (num_results: 5)
Record: what certifications they claim, what security practices they describe, any self-disclosed incidents.

## PHASE 2 - NEGATIVE SCREENING (exact-match quoted entity names)
Combine entity names from ENTITY_LIST into OR-quoted batches of 3 to stay within search length limits. For each batch, run these queries via \`google_search\` (num_results: 10 each):

Query A (Security): "Entity1" OR "Entity2" OR "Entity3" data breach OR security incident OR data leak OR hack
Query B (Legal): "Entity1" OR "Entity2" OR "Entity3" lawsuit OR "regulatory action" OR fine OR penalty OR "class action"
Query C (Compliance): "Entity1" OR "Entity2" OR "Entity3" GDPR OR CCPA OR PIPEDA violation OR complaint
Query D (Reputational): "Entity1" OR "Entity2" OR "Entity3" scandal OR controversy OR layoffs OR fraud OR misconduct

If you have more than 3 entity names, split into multiple batches. Prioritize the primary company name and any well-known subsidiaries in the first batch.

## PHASE 3 - BREACH DATABASE CHECKS (one query each, skip if empty)
- \`google_search\`: "PrimaryEntityName" OR "Entity2" site:haveibeenpwned.com (num_results: 3)
- \`google_search\`: "PrimaryEntityName" OR "Entity2" site:oag.ca.gov/privacy/databreach (num_results: 3)
- \`google_search\`: "PrimaryEntityName" OR "Entity2" CVE vulnerability advisory (num_results: 5)

## PHASE 4 - EXECUTIVE SCREENING (batch names from EXECUTIVE_LIST)
Combine executive names into OR-quoted batches of 3. For each batch:

Query: "Exec1" OR "Exec2" OR "Exec3" lawsuit OR scandal OR fraud OR controversy OR "regulatory action" OR misconduct

If any query returns a hit that APPEARS relevant (not a different person with the same name), run an individual follow-up \`search_and_scrape\` on that specific person to confirm. Disambiguate carefully by cross-referencing company names, locations, and titles.

## PHASE 5 - CORPORATE HISTORY (use search_and_scrape for content)
- \`search_and_scrape\`: "${companyName}" acquisition OR funding OR investment history (num_results: 3)
- \`search_and_scrape\`: "${companyName}" CEO OR founder background career (num_results: 3)

## PHASE 6 - NEWS CHECK
- \`google_news_search\`: "${companyName}" (freshness: year, num_results: 5)
- If any major subsidiaries were discovered, also search: "SubsidiaryName" (freshness: year, num_results: 3)

---

**STOP RULES (strictly follow):**
1. If a query category returns ZERO relevant results after ONE well-formed query, log it as "no findings" and move on. Do NOT run 3-4 variations of the same empty search.
2. Do NOT scrape LinkedIn, Crunchbase, ZoomInfo, or Glassdoor URLs - they will fail. Extract info from google_search snippet text instead.
3. ALWAYS use exact-match quoted "entity name" in queries. Never run broad unquoted searches.
4. If an entity has minimal public footprint, combine it into OR queries with larger entities. Do not give it dedicated queries.
5. Maximum total queries across all phases: 25 (including discovery).

---

**OUTPUT FORMAT:**

## 1. Executive Summary
One paragraph: overall clean/concerning finding across all categories.

## 2. Entities Researched
Table: Entity Name | Type (current/prior/subsidiary/acquired) | Period | Status

## 3. Corporate History Timeline
Table: Date | Event | Source

## 4. Security & Data Privacy Findings
### 4.1 Data Breaches & Security Incidents
[CLEAN or FINDINGS with details]
### 4.2 CVEs & Vulnerability Disclosures
[CLEAN or FINDINGS]
### 4.3 Regulatory Enforcement Actions
[CLEAN or FINDINGS]
### 4.4 Security Certifications & Posture
(positive findings from Phase 1)

## 5. Litigation & Legal Proceedings
[CLEAN or FINDINGS with details]

## 6. Executive Background Research
For each executive: Name | Role | Prior Roles | Negative Findings [NONE or details]

## 7. Reputational & Media Analysis
### 7.1 Industry Recognition (positive)
### 7.2 Layoffs & Employee Sentiment
### 7.3 Media Coverage of Key Events

## 8. Search Methodology
### 8.1 Entity Names Searched (full list)
### 8.2 Executive Names Searched (full list)
### 8.3 Queries Run (table: Category | Query | Results Found)
### 8.4 Sources Consulted

## 9. Limitations & Caveats
- Absence of evidence vs. evidence of absence
- Sources that were inaccessible (LinkedIn, etc.)
- Entities with minimal public footprint
- Certifications requiring currency verification
- Recommendation for formal background check services (LexisNexis, D&B) to supplement

## 10. References
Numbered list with URLs for every source cited.

For every finding (positive or negative), include the source URL. For every "CLEAN" verdict, list what was checked.

---

Begin with Phase 0: discover the company website, all entity names, and all executives.`,
            },
          },
        ],
      };
    }
  );
}

// ── Prompt Descriptions (for testing and documentation) ─────────────────────

/**
 * Metadata about available prompts
 */
export const PROMPT_METADATA = {
  'comprehensive-research': {
    name: 'comprehensive-research',
    description: 'Research a topic thoroughly using multiple sources, with synthesis and citations',
    arguments: ['topic', 'depth'],
  },
  'fact-check': {
    name: 'fact-check',
    description: 'Verify a claim using multiple authoritative sources',
    arguments: ['claim', 'sources'],
  },
  'summarize-url': {
    name: 'summarize-url',
    description: 'Extract and summarize content from a specific URL',
    arguments: ['url', 'format'],
  },
  'news-briefing': {
    name: 'news-briefing',
    description: 'Get a current news summary on a topic',
    arguments: ['topic', 'timeRange'],
  },
  'patent-portfolio-analysis': {
    name: 'patent-portfolio-analysis',
    description: 'Analyze a company\'s patent portfolio including subsidiaries',
    arguments: ['company', 'includeSubsidiaries'],
  },
  'competitive-analysis': {
    name: 'competitive-analysis',
    description: 'Compare multiple companies or products across key dimensions',
    arguments: ['entities', 'aspects'],
  },
  'literature-review': {
    name: 'literature-review',
    description: 'Conduct an academic literature review with proper citations',
    arguments: ['topic', 'yearFrom', 'sources'],
  },
  'technical-deep-dive': {
    name: 'technical-deep-dive',
    description: 'In-depth technical investigation of a technology or concept',
    arguments: ['technology', 'focusArea'],
  },
  'due-diligence-background': {
    name: 'due-diligence-background',
    description:
      'Background & reputational due diligence research on a company: automatically discovers subsidiaries, prior names, executives, then screens for security breaches, compliance violations, lawsuits, executive scandals, and security posture',
    arguments: ['companyName'],
  },
} as const;

/**
 * List of all prompt names
 */
export const PROMPT_NAMES = Object.keys(PROMPT_METADATA) as Array<
  keyof typeof PROMPT_METADATA
>;
