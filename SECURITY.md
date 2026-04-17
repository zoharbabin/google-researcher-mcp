# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 6.x     | :white_check_mark: |
| < 6.0   | :x:                |

We only provide security fixes for the latest major version. Please upgrade to the latest release before reporting.

## Reporting a Vulnerability

**Do not open a public issue for security vulnerabilities.**

Please report security issues through [GitHub's private vulnerability reporting](https://github.com/zoharbabin/google-researcher-mcp/security/advisories/new).

When reporting, please include:

- Description of the vulnerability and its potential impact
- Steps to reproduce or a proof-of-concept
- Affected versions
- Any suggested fix (if you have one)

### What to expect

- **Acknowledgment**: Within 48 hours of your report.
- **Assessment**: We will evaluate severity and impact within 1 week.
- **Fix**: Critical and high-severity issues will be patched as soon as possible, typically within 2 weeks.
- **Disclosure**: We will coordinate disclosure with you. We request that you do not publicly disclose the vulnerability until a fix is released.

## Security Best Practices for Users

When deploying this MCP server:

- **Keep API keys secret**: Never commit `.env` files or API keys to version control. Use environment variables or secret managers.
- **Use STDIO transport for local use**: STDIO mode requires no network exposure and is the safest option for single-user setups.
- **Configure OAuth for HTTP transport**: When exposing the server over HTTP, always enable OAuth 2.1 authentication. Never run HTTP mode without authentication in production.
- **Restrict CORS origins**: Set `ALLOWED_ORIGINS` to only the domains that need access.
- **Keep dependencies updated**: Run `npm audit` regularly and update promptly when security advisories are published.
- **Use Docker for isolation**: The Docker image runs as a non-root user and provides process-level isolation.
- **Review private IP access**: Only set `ALLOW_PRIVATE_IPS=true` for local development, never in production.

## Scope

The following are in scope for security reports:

- Authentication and authorization bypasses
- Server-Side Request Forgery (SSRF)
- Remote code execution
- Injection vulnerabilities (command, SQL, XSS in any output)
- Sensitive data exposure (API key leaks, credential logging)
- Denial of service via crafted input
- Dependency vulnerabilities with a known exploit

The following are out of scope:

- Issues requiring physical access to the host machine
- Social engineering attacks
- Vulnerabilities in third-party services (Google APIs, etc.)
- Issues that require the user to have already compromised their own API keys
