/**
 * Sequential Search Tool
 *
 * A state-tracking tool for multi-step research, following the pattern
 * established by the official sequential_thinking MCP server.
 *
 * Key Principle: The LLM does the reasoning; the server tracks state.
 *
 * This tool helps LLMs manage complex research by:
 * - Tracking search steps and progress
 * - Recording sources with quality scores
 * - Noting knowledge gaps identified by the LLM
 * - Supporting revisions and branching
 * - Exposing state via MCP Resource
 */

import { z } from 'zod';
import { randomUUID } from 'node:crypto';

// ── Types ────────────────────────────────────────────────────────────────────

/**
 * A source found during research
 */
export interface ResearchSource {
  /** URL of the source */
  url: string;
  /** LLM-provided summary of the source */
  summary: string;
  /** Quality score (0-1) if available */
  qualityScore?: number;
  /** Step number when this source was added */
  addedAtStep: number;
  /** Timestamp when source was added */
  addedAt: string;
}

/**
 * A knowledge gap identified by the LLM
 */
export interface KnowledgeGap {
  /** Description of what's missing */
  description: string;
  /** Step number when gap was identified */
  identifiedAtStep: number;
  /** Whether this gap has been addressed */
  resolved: boolean;
  /** Step number when gap was resolved (if applicable) */
  resolvedAtStep?: number;
}

/**
 * A single step in the research process
 */
export interface ResearchStep {
  /** Step number */
  stepNumber: number;
  /** Description of what happened in this step */
  description: string;
  /** Timestamp of this step */
  timestamp: string;
  /** Whether this is a revision of a previous step */
  isRevision?: boolean;
  /** Which step this revises (if isRevision) */
  revisesStep?: number;
  /** Branch ID if this is part of a branch */
  branchId?: string;
  /** Step number this branched from */
  branchFromStep?: number;
}

/**
 * Complete research session state
 */
export interface ResearchSession {
  /** Unique session ID */
  sessionId: string;
  /** Research question/topic */
  question: string;
  /** Current step number */
  currentStep: number;
  /** Estimated total steps */
  totalStepsEstimate: number;
  /** Whether research is complete */
  isComplete: boolean;
  /** All research steps */
  steps: ResearchStep[];
  /** All sources found */
  sources: ResearchSource[];
  /** All knowledge gaps */
  gaps: KnowledgeGap[];
  /** Session start time */
  startedAt: string;
  /** Session end time (if complete) */
  completedAt?: string;
  /** Current branch ID */
  currentBranch?: string;
}

// ── Session Storage ──────────────────────────────────────────────────────────

/**
 * In-memory storage for research sessions
 * Sessions expire after 30 minutes of inactivity
 */
const sessions = new Map<string, ResearchSession>();
const sessionLastAccess = new Map<string, number>();
const SESSION_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
const MAX_SESSIONS = 50;

/**
 * Current active session ID (most recent)
 */
let currentSessionId: string | null = null;

/**
 * Cleanup expired sessions periodically
 */
function cleanupExpiredSessions(): void {
  const now = Date.now();
  for (const [sessionId, lastAccess] of sessionLastAccess.entries()) {
    if (now - lastAccess > SESSION_TIMEOUT_MS) {
      sessions.delete(sessionId);
      sessionLastAccess.delete(sessionId);
      if (currentSessionId === sessionId) {
        currentSessionId = null;
      }
    }
  }
}

// Run cleanup every 5 minutes (skip in test environment).
// .unref() ensures this timer doesn't prevent the process from exiting cleanly.
if (process.env.NODE_ENV !== 'test' && !process.env.JEST_WORKER_ID) {
  setInterval(cleanupExpiredSessions, 5 * 60 * 1000).unref();
}

// ── Session Management ───────────────────────────────────────────────────────

/**
 * Creates a new research session
 */
export function createSession(question: string, totalStepsEstimate: number = 5): ResearchSession {
  // Evict expired sessions first, then oldest if still over limit
  if (sessions.size >= MAX_SESSIONS) {
    cleanupExpiredSessions();
    if (sessions.size >= MAX_SESSIONS) {
      const oldest = [...sessionLastAccess.entries()]
        .sort((a, b) => a[1] - b[1])[0];
      if (oldest) {
        sessions.delete(oldest[0]);
        sessionLastAccess.delete(oldest[0]);
      }
    }
  }

  const sessionId = randomUUID();
  const now = new Date().toISOString();

  const session: ResearchSession = {
    sessionId,
    question,
    currentStep: 0,
    totalStepsEstimate,
    isComplete: false,
    steps: [],
    sources: [],
    gaps: [],
    startedAt: now,
  };

  sessions.set(sessionId, session);
  sessionLastAccess.set(sessionId, Date.now());
  currentSessionId = sessionId;

  return session;
}

/**
 * Gets a session by ID, or the current session if no ID provided
 */
export function getSession(sessionId?: string): ResearchSession | null {
  const id = sessionId || currentSessionId;
  if (!id) return null;

  const session = sessions.get(id);
  if (session) {
    sessionLastAccess.set(id, Date.now());
  }
  return session || null;
}

/**
 * Gets the current active session
 */
export function getCurrentSession(): ResearchSession | null {
  return getSession(currentSessionId || undefined);
}

/**
 * Clears all sessions (for testing)
 */
export function clearAllSessions(): void {
  sessions.clear();
  sessionLastAccess.clear();
  currentSessionId = null;
}

// ── Input Schema ─────────────────────────────────────────────────────────────

/**
 * Input schema for sequential_search tool
 */
export const sequentialSearchInputSchema = {
  /** Current search step description (what the LLM just searched/found) */
  searchStep: z.string().min(1).max(2000)
    .describe('Description of what you searched or found in this step'),

  /** Current step number in the sequence */
  stepNumber: z.number().int().min(1)
    .describe('Current step number (starts at 1)'),

  /** Estimated total steps needed */
  totalStepsEstimate: z.number().int().min(1).max(50).default(5)
    .describe('Estimated total steps needed (can be adjusted as you go)'),

  /** Whether more steps are needed */
  nextStepNeeded: z.boolean()
    .describe('Set to true if more research steps are needed, false when done'),

  /** Source to add (optional) */
  source: z.object({
    url: z.string().url().describe('URL of the source'),
    summary: z.string().min(1).max(500).describe('Brief summary of what this source provides'),
    qualityScore: z.number().min(0).max(1).optional().describe('Quality score 0-1'),
  }).optional().describe('Source found in this step (if any)'),

  /** Knowledge gap identified (optional) */
  knowledgeGap: z.string().max(500).optional()
    .describe('Knowledge gap identified - what information is still missing'),

  /** Whether this step revises a previous step */
  isRevision: z.boolean().optional()
    .describe('Set to true if this step revises previous thinking'),

  /** Which step this revises */
  revisesStep: z.number().int().min(1).optional()
    .describe('Step number being revised (required if isRevision is true)'),

  /** Branch from a previous step */
  branchFromStep: z.number().int().min(1).optional()
    .describe('Step number to branch from (for exploring alternatives)'),

  /** Branch identifier */
  branchId: z.string().max(50).optional()
    .describe('Identifier for this branch of research'),

  /** Session ID to continue (optional - auto-detects current session) */
  sessionId: z.string().uuid().optional()
    .describe('Session ID to continue (optional - uses current session if omitted)'),
};

// ── Output Schema ────────────────────────────────────────────────────────────

/**
 * Output schema for sequential_search tool
 */
export const sequentialSearchOutputSchema = {
  /** Session ID */
  sessionId: z.string().uuid().describe('Unique session identifier'),

  /** Current step number */
  currentStep: z.number().int().describe('Current step number'),

  /** Total steps estimate */
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

// ── Output Type ──────────────────────────────────────────────────────────────

export interface SequentialSearchOutput {
  sessionId: string;
  currentStep: number;
  totalStepsEstimate: number;
  isComplete: boolean;
  sourceCount: number;
  openGapsCount: number;
  stateSummary: string;
  sources?: Array<{
    url: string;
    summary: string;
    qualityScore?: number;
  }>;
  gaps?: Array<{
    description: string;
    resolved: boolean;
  }>;
  [key: string]: unknown; // Index signature for MCP SDK compatibility
}

// ── Handler ──────────────────────────────────────────────────────────────────

/**
 * Input type for sequential search handler
 */
export type SequentialSearchInput = {
  searchStep: string;
  stepNumber: number;
  totalStepsEstimate?: number;
  nextStepNeeded: boolean;
  source?: {
    url: string;
    summary: string;
    qualityScore?: number;
  };
  knowledgeGap?: string;
  isRevision?: boolean;
  revisesStep?: number;
  branchFromStep?: number;
  branchId?: string;
  sessionId?: string;
};

/**
 * Handler for the sequential_search tool
 */
export function handleSequentialSearch(input: SequentialSearchInput): {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent: SequentialSearchOutput;
} {
  const {
    searchStep,
    stepNumber,
    totalStepsEstimate = 5,
    nextStepNeeded,
    source,
    knowledgeGap,
    isRevision,
    revisesStep,
    branchFromStep,
    branchId,
    sessionId: inputSessionId,
  } = input;

  const now = new Date().toISOString();
  let session: ResearchSession;

  // Get or create session
  if (stepNumber === 1 && !inputSessionId) {
    // First step without session ID - create new session
    session = createSession(searchStep, totalStepsEstimate);
  } else {
    // Continue existing session
    const existingSession = getSession(inputSessionId);
    if (!existingSession) {
      // No existing session found, create one
      session = createSession(searchStep, totalStepsEstimate);
    } else {
      session = existingSession;
    }
  }

  // Update session state
  session.currentStep = stepNumber;
  session.totalStepsEstimate = totalStepsEstimate;

  // Record the step
  const step: ResearchStep = {
    stepNumber,
    description: searchStep,
    timestamp: now,
    isRevision,
    revisesStep,
    branchId,
    branchFromStep,
  };
  session.steps.push(step);

  // Handle branching
  if (branchId) {
    session.currentBranch = branchId;
  }

  // Add source if provided
  if (source) {
    session.sources.push({
      ...source,
      addedAtStep: stepNumber,
      addedAt: now,
    });
  }

  // Add knowledge gap if provided
  if (knowledgeGap) {
    session.gaps.push({
      description: knowledgeGap,
      identifiedAtStep: stepNumber,
      resolved: false,
    });
  }

  // Mark complete if no more steps needed
  if (!nextStepNeeded) {
    session.isComplete = true;
    session.completedAt = now;
  }

  // Calculate stats
  const openGapsCount = session.gaps.filter(g => !g.resolved).length;

  // Build state summary
  const summaryParts: string[] = [
    `Step ${stepNumber}/${totalStepsEstimate}`,
    `${session.sources.length} source(s)`,
    `${openGapsCount} open gap(s)`,
  ];
  if (session.isComplete) {
    summaryParts.push('COMPLETE');
  }
  if (session.currentBranch) {
    summaryParts.push(`Branch: ${session.currentBranch}`);
  }

  // Build output
  const output: SequentialSearchOutput = {
    sessionId: session.sessionId,
    currentStep: session.currentStep,
    totalStepsEstimate: session.totalStepsEstimate,
    isComplete: session.isComplete,
    sourceCount: session.sources.length,
    openGapsCount,
    stateSummary: summaryParts.join(' | '),
  };

  // Include full state when complete
  if (session.isComplete) {
    output.sources = session.sources.map(s => ({
      url: s.url,
      summary: s.summary,
      qualityScore: s.qualityScore,
    }));
    output.gaps = session.gaps.map(g => ({
      description: g.description,
      resolved: g.resolved,
    }));
  }

  // Build text content
  let textContent = `Research Session: ${session.sessionId}\n`;
  textContent += `Question: ${session.question}\n`;
  textContent += `Status: ${output.stateSummary}\n`;

  if (session.isComplete) {
    textContent += '\n--- Research Complete ---\n';
    textContent += `\nSources Found (${session.sources.length}):\n`;
    session.sources.forEach((s, i) => {
      textContent += `${i + 1}. ${s.url}\n   ${s.summary}\n`;
      if (s.qualityScore !== undefined) {
        textContent += `   Quality: ${(s.qualityScore * 100).toFixed(0)}%\n`;
      }
    });

    if (session.gaps.length > 0) {
      textContent += `\nKnowledge Gaps:\n`;
      session.gaps.forEach((g, i) => {
        const status = g.resolved ? '✓' : '○';
        textContent += `${status} ${i + 1}. ${g.description}\n`;
      });
    }
  }

  return {
    content: [{ type: 'text', text: textContent }],
    structuredContent: output,
  };
}

// ── Resource Helper ──────────────────────────────────────────────────────────

/**
 * Gets the current session state for MCP Resource exposure
 */
export function getCurrentSessionForResource(): ResearchSession | null {
  return getCurrentSession();
}
