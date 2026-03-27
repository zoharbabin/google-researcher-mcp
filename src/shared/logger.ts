/**
 * Structured Logger
 *
 * Zero-dependency logger that adapts output format to the environment:
 * - NODE_ENV=production  → JSON (one object per line, machine-parseable)
 * - NODE_ENV=test        → silent for debug/info/warn; errors still print
 * - everything else      → human-readable with ISO timestamp
 *
 * Levels: debug < info < warn < error
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

interface LogEntry {
  level: LogLevel;
  timestamp: string;
  message: string;
  [key: string]: unknown;
}

class Logger {
  private env: string;

  constructor() {
    this.env = process.env.NODE_ENV ?? '';
  }

  // ── public API ──────────────────────────────────────────────

  debug(message: string, meta?: Record<string, unknown>): void {
    this.log('debug', message, meta);
  }

  info(message: string, meta?: Record<string, unknown>): void {
    this.log('info', message, meta);
  }

  warn(message: string, meta?: Record<string, unknown>): void {
    this.log('warn', message, meta);
  }

  error(message: string, meta?: Record<string, unknown>): void {
    this.log('error', message, meta);
  }

  // ── internals ───────────────────────────────────────────────

  /**
   * Write a line to stderr. In STDIO MCP mode stdout is the JSON-RPC
   * channel, so ALL log output MUST go to stderr to avoid corrupting
   * the protocol and causing client disconnects.
   */
  private write(line: string): void {
    process.stderr.write(line + '\n');
  }

  private log(level: LogLevel, message: string, meta?: Record<string, unknown>): void {
    // In test environment, only emit errors
    if (this.env === 'test' && level !== 'error') return;

    const entry: LogEntry = {
      level,
      timestamp: new Date().toISOString(),
      message,
      ...(meta ?? {}),
    };

    if (this.env === 'production') {
      // JSON output — one line per entry
      this.write(JSON.stringify(entry));
    } else {
      // Human-readable
      const prefix = `[${entry.timestamp}] [${level.toUpperCase()}]`;
      const metaStr = meta && Object.keys(meta).length > 0 ? ` ${JSON.stringify(meta)}` : '';
      this.write(`${prefix} ${message}${metaStr}`);
    }
  }
}

/** Singleton logger instance */
export const logger = new Logger();
