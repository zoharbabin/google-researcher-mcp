/**
 * Environment Variable Validation Module
 *
 * Validates format and presence of required environment variables at startup.
 * Provides clear, actionable error messages for misconfiguration.
 */

import { logger } from './logger.js';

// ── Validation Rule Definitions ────────────────────────────────────────────

export interface EnvValidationRule {
  /** Environment variable name */
  name: string;
  /** Whether the variable is required for the server to start */
  required: boolean;
  /** Regex pattern for format validation (if applicable) */
  pattern?: RegExp;
  /** Human-readable description of expected format */
  description: string;
  /** Example of valid value */
  example?: string;
  /** Custom validation function for complex rules */
  validate?: (value: string) => boolean;
}

/**
 * Validation rules for all known environment variables.
 * Patterns are based on documented formats from Google and OAuth specifications.
 */
export const ENV_VALIDATION_RULES: EnvValidationRule[] = [
  {
    name: 'GOOGLE_CUSTOM_SEARCH_API_KEY',
    required: true,
    // Google API keys start with "AIzaSy" followed by 33 alphanumeric/dash/underscore chars
    pattern: /^AIzaSy[A-Za-z0-9_-]{33}$/,
    description: 'Google API key must start with "AIzaSy" followed by 33 characters (39 total)',
    example: 'AIzaSyA1B2C3D4E5F6G7H8I9J0K1L2M3N4O5P6Q',
  },
  {
    name: 'GOOGLE_CUSTOM_SEARCH_ID',
    required: true,
    // Search Engine IDs are alphanumeric with colons, typically 10-50 chars
    pattern: /^[a-zA-Z0-9:_-]{10,50}$/,
    description: 'Search Engine ID must be 10-50 alphanumeric characters (may include colons)',
    example: '017576662512468239146:omuauf_gy1x',
  },
  {
    name: 'OAUTH_ISSUER_URL',
    required: false, // Only required when OAuth is enabled
    pattern: /^https:\/\/[a-zA-Z0-9][a-zA-Z0-9.-]*[a-zA-Z0-9](:\d+)?(\/.*)?$/,
    description: 'OAuth issuer URL must be a valid HTTPS URL',
    example: 'https://auth.example.com',
  },
  {
    name: 'OAUTH_AUDIENCE',
    required: false, // Only required when OAuth is enabled
    description: 'OAuth audience identifier (typically a URL or API identifier)',
    example: 'https://api.example.com',
    validate: (value: string) => value.length > 0 && value.length <= 500,
  },
  {
    name: 'EVENT_STORE_ENCRYPTION_KEY',
    required: false,
    // Must be exactly 64 hex characters (32 bytes)
    pattern: /^[0-9a-fA-F]{64}$/,
    description: 'Encryption key must be exactly 64 hexadecimal characters (32 bytes)',
    example: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  },
  {
    name: 'CACHE_ADMIN_KEY',
    required: false,
    description: 'Admin API key for cache management endpoints',
    validate: (value: string) => value.length >= 16, // Minimum security requirement
  },
  {
    name: 'PORT',
    required: false,
    pattern: /^\d{1,5}$/,
    description: 'Port number must be 1-65535',
    example: '3000',
    validate: (value: string) => {
      const port = parseInt(value, 10);
      return port >= 1 && port <= 65535;
    },
  },
  {
    name: 'RATE_LIMIT_WINDOW_MS',
    required: false,
    pattern: /^\d+$/,
    description: 'Rate limit window in milliseconds',
    example: '60000',
  },
  {
    name: 'RATE_LIMIT_MAX_REQUESTS',
    required: false,
    pattern: /^\d+$/,
    description: 'Maximum requests per rate limit window',
    example: '100',
  },
  {
    name: 'ALLOWED_ORIGINS',
    required: false,
    description: 'Comma-separated list of allowed CORS origins',
    example: 'https://example.com,https://app.example.com',
  },
  {
    name: 'TAVILY_API_KEY',
    required: false,
    description: 'Tavily API key for web search (enables Tavily provider when set)',
    example: 'tvly-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
    validate: (value: string) => value.length >= 32,
  },
  {
    name: 'SEARCH_PROVIDER',
    required: false,
    description: 'Search provider selection: google (default), tavily, or parallel',
    example: 'google',
    validate: (value: string) => ['google', 'tavily', 'parallel'].includes(value),
  },
];

// ── Validation Result Types ────────────────────────────────────────────────

export interface ValidationError {
  /** Environment variable name */
  variable: string;
  /** Error type */
  type: 'missing' | 'invalid_format' | 'invalid_value';
  /** Human-readable error message */
  message: string;
  /** Expected format description */
  expected?: string;
  /** Example of valid value */
  example?: string;
}

export interface ValidationWarning {
  /** Environment variable name */
  variable: string;
  /** Warning message */
  message: string;
}

export interface EnvValidationResult {
  /** Whether all required validations passed */
  valid: boolean;
  /** List of validation errors (blocking) */
  errors: ValidationError[];
  /** List of validation warnings (non-blocking) */
  warnings: ValidationWarning[];
}

export interface ValidateEnvironmentOptions {
  /** Require OAuth configuration (both OAUTH_ISSUER_URL and OAUTH_AUDIENCE) */
  requireOAuth?: boolean;
  /** Log warnings for optional variables with unusual values */
  logWarnings?: boolean;
  /** Additional custom rules to validate */
  additionalRules?: EnvValidationRule[];
}

// ── Core Validation Functions ──────────────────────────────────────────────

/**
 * Validates a single environment variable against its rule.
 */
export function validateEnvVar(
  rule: EnvValidationRule,
  value: string | undefined
): { valid: boolean; error?: ValidationError } {
  // Check if value exists
  if (value === undefined || value === '') {
    if (rule.required) {
      return {
        valid: false,
        error: {
          variable: rule.name,
          type: 'missing',
          message: `Required environment variable ${rule.name} is not set`,
          expected: rule.description,
          example: rule.example,
        },
      };
    }
    // Optional variable not set - valid
    return { valid: true };
  }

  // Check pattern if defined
  if (rule.pattern && !rule.pattern.test(value)) {
    return {
      valid: false,
      error: {
        variable: rule.name,
        type: 'invalid_format',
        message: `Environment variable ${rule.name} has invalid format`,
        expected: rule.description,
        example: rule.example,
      },
    };
  }

  // Run custom validation if defined
  if (rule.validate && !rule.validate(value)) {
    return {
      valid: false,
      error: {
        variable: rule.name,
        type: 'invalid_value',
        message: `Environment variable ${rule.name} has invalid value`,
        expected: rule.description,
        example: rule.example,
      },
    };
  }

  return { valid: true };
}

/**
 * Validates all environment variables according to defined rules.
 *
 * @param options - Validation options
 * @returns Validation result with errors and warnings
 */
export function validateEnvironment(
  options: ValidateEnvironmentOptions = {}
): EnvValidationResult {
  const errors: ValidationError[] = [];
  const warnings: ValidationWarning[] = [];

  // Combine default rules with any additional rules
  const rules = [...ENV_VALIDATION_RULES, ...(options.additionalRules ?? [])];

  // Adjust required status based on options
  const adjustedRules = rules.map(rule => {
    if (options.requireOAuth && (rule.name === 'OAUTH_ISSUER_URL' || rule.name === 'OAUTH_AUDIENCE')) {
      return { ...rule, required: true };
    }
    return rule;
  });

  // Validate each rule
  for (const rule of adjustedRules) {
    const value = process.env[rule.name];
    const result = validateEnvVar(rule, value);

    if (!result.valid && result.error) {
      errors.push(result.error);
    }
  }

  // Check OAuth consistency: if one is set, both should be set
  const oauthIssuer = process.env.OAUTH_ISSUER_URL;
  const oauthAudience = process.env.OAUTH_AUDIENCE;
  if ((oauthIssuer && !oauthAudience) || (!oauthIssuer && oauthAudience)) {
    warnings.push({
      variable: oauthIssuer ? 'OAUTH_AUDIENCE' : 'OAUTH_ISSUER_URL',
      message: 'OAuth configuration is incomplete. Set both OAUTH_ISSUER_URL and OAUTH_AUDIENCE, or neither.',
    });
  }

  // Check for potentially insecure configurations
  if (process.env.ALLOW_PRIVATE_IPS?.toLowerCase() === 'true') {
    warnings.push({
      variable: 'ALLOW_PRIVATE_IPS',
      message: 'ALLOW_PRIVATE_IPS is enabled. This allows scraping private/internal IP addresses and may pose security risks.',
    });
  }

  // Log warnings if requested
  if (options.logWarnings && warnings.length > 0) {
    for (const warning of warnings) {
      logger.warn(`Environment warning: ${warning.message}`, { variable: warning.variable });
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

/**
 * Formats a validation error into a clear, actionable message.
 */
export function formatValidationError(error: ValidationError): string {
  let message = `ERROR: ${error.message}`;

  if (error.expected) {
    message += `\n  Expected: ${error.expected}`;
  }

  if (error.example) {
    message += `\n  Example:  ${error.variable}=${error.example}`;
  }

  return message;
}

/**
 * Validates environment and exits with clear error messages if invalid.
 * Call this at server startup to fail fast with helpful diagnostics.
 *
 * @param options - Validation options
 */
/**
 * Error thrown when environment validation fails.
 * Used in test environments instead of process.exit().
 */
export class EnvironmentValidationError extends Error {
  constructor(
    message: string,
    public readonly errors: ValidationError[]
  ) {
    super(message);
    this.name = 'EnvironmentValidationError';
  }
}

export function validateEnvironmentOrExit(
  options: ValidateEnvironmentOptions = {}
): void {
  const result = validateEnvironment({ ...options, logWarnings: true });

  if (!result.valid) {
    logger.error('Environment validation failed. Please fix the following issues:');

    for (const error of result.errors) {
      const formatted = formatValidationError(error);
      // Log each line separately for better visibility
      for (const line of formatted.split('\n')) {
        logger.error(line);
      }
    }

    logger.error('See .env.example for configuration documentation.');

    // In test environment, throw an error instead of exiting so tests can catch it
    if (process.env.NODE_ENV === 'test') {
      throw new EnvironmentValidationError(
        'Environment validation failed',
        result.errors
      );
    }

    process.exit(1);
  }
}

/**
 * Gets a validated environment variable value, or undefined if not set.
 * Throws if the variable is set but has an invalid format.
 *
 * @param name - Environment variable name
 * @returns The validated value or undefined
 * @throws Error if the value is set but invalid
 */
export function getValidatedEnvValue(name: string): string | undefined {
  const value = process.env[name];
  if (value === undefined || value === '') {
    return undefined;
  }

  const rule = ENV_VALIDATION_RULES.find(r => r.name === name);
  if (!rule) {
    // No rule defined, return as-is
    return value;
  }

  const result = validateEnvVar(rule, value);
  if (!result.valid && result.error) {
    throw new Error(formatValidationError(result.error));
  }

  return value;
}
