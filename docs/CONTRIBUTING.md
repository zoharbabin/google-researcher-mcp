# Contributing to Google Researcher MCP

Thank you for considering contributing! Every contribution is valuable — bug reports, feature requests, documentation improvements, and code contributions all help make this project better for the community.

## Table of Contents

- [Code of Conduct](#code-of-conduct)
- [How Can I Contribute?](#how-can-i-contribute)
- [Development Setup](#development-setup)
- [Making Changes](#making-changes)
- [Submitting a Pull Request](#submitting-a-pull-request)
- [Coding Guidelines](#coding-guidelines)
- [Testing Requirements](#testing-requirements)
- [Documentation Standards](#documentation-standards)
- [Security](#security)
- [License](#license)

## Code of Conduct

All contributors are expected to adhere to our [Code of Conduct](./CODE_OF_CONDUCT.md). Please read it before participating.

## How Can I Contribute?

| Contribution | How |
|---|---|
| Report a bug | [Open a bug report](https://github.com/zoharbabin/google-researcher-mcp/issues/new?template=bug_report.yml) |
| Request a feature | [Open a feature request](https://github.com/zoharbabin/google-researcher-mcp/issues/new?template=feature_request.yml) |
| Report a security vulnerability | [Private vulnerability report](https://github.com/zoharbabin/google-researcher-mcp/security/advisories/new) (do **not** open a public issue) |
| Ask a question | [Open an issue](https://github.com/zoharbabin/google-researcher-mcp/issues) with your question |
| Fix a bug or add a feature | Fork, branch, code, test, PR (see below) |
| Improve documentation | Same workflow — documentation PRs are welcome |

### Good first issues

Look for issues labeled [`good first issue`](https://github.com/zoharbabin/google-researcher-mcp/labels/good%20first%20issue) — these are scoped, well-documented tasks suitable for new contributors.

## Development Setup

### Prerequisites

- **Node.js** >= 20.0.0 ([download](https://nodejs.org/))
- **Git**
- **Google API credentials** (for testing search tools) — see the [API Setup Guide](./API_SETUP.md)

### Setup steps

1. **Fork and clone**:
    ```bash
    git clone https://github.com/YOUR_USERNAME/google-researcher-mcp.git
    cd google-researcher-mcp
    ```

2. **Install dependencies** (Chromium for Playwright is installed automatically via postinstall):
    ```bash
    npm install
    ```

3. **Configure environment**:
    ```bash
    cp .env.example .env
    # Edit .env and add your Google API key and Search Engine ID
    ```
    You only need API keys for the tools you intend to test.

4. **Build and verify**:
    ```bash
    npm run build
    npm test
    ```
    All 860+ tests should pass. If any fail, check that your Node.js version is >= 20.

5. **Start in development mode** (auto-reloads on changes):
    ```bash
    npm run dev
    ```

6. **Run E2E tests** (optional, requires API keys):
    ```bash
    npm run test:e2e:stdio
    ```

### Useful links

- [Architecture Guide](./architecture/architecture.md) — how the codebase is structured
- [Adding New Tools](./ADDING_NEW_TOOLS.md) — step-by-step guide for new MCP tools
- [Testing Guide](./testing-guide.md) — testing philosophy, patterns, and how to write tests

## Making Changes

1. **Create a branch** from `main`:
    ```bash
    git checkout -b feat/my-change    # or fix/, docs/, refactor/, test/
    ```

2. **Make focused changes**. Keep your PR scoped to one feature or fix. If you find an unrelated issue, open a separate PR.

3. **Write tests** for new functionality. Bug fixes should include a test that fails without the fix.

4. **Run the full test suite** before committing:
    ```bash
    npm test
    npm run build
    ```

5. **Commit with [Conventional Commits](https://www.conventionalcommits.org/)** format:
    ```bash
    git commit -m "feat: add support for RSS feed scraping"
    git commit -m "fix: handle timeout in search_and_scrape"
    git commit -m "docs: clarify Docker setup instructions"
    ```

    Common prefixes: `feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `perf:`, `chore:`

6. **Push to your fork** and open a PR:
    ```bash
    git push origin feat/my-change
    ```

## Submitting a Pull Request

When you open a PR, the [PR template](https://github.com/zoharbabin/google-researcher-mcp/blob/main/.github/PULL_REQUEST_TEMPLATE.md) will guide you through what to include.

### PR expectations

- **Clear title and description**: Explain what changed and why. Link to the issue it addresses (`Closes #123`).
- **One concern per PR**: Don't mix a bug fix with a refactor. Smaller PRs get reviewed faster.
- **All CI checks must pass**: Tests, type checking, linting, and security audit.
- **Allow maintainer edits**: Check "Allow edits from maintainers" so we can make small adjustments.
- **Be responsive**: If a reviewer requests changes, please address them within a reasonable timeframe.

### What happens after you submit

1. CI runs automatically (tests, type checks, lint, security audit, Docker build)
2. A maintainer will review your PR, usually within a few days
3. You may receive feedback — this is collaborative, not adversarial
4. Once approved, a maintainer will merge your PR

## Coding Guidelines

### TypeScript

- All new code must be written in TypeScript with proper type annotations.
- Avoid `any` — use specific types or generics.
- Export types that consumers might need.

### Code style

- Follow the existing conventions in the codebase.
- Use descriptive variable and function names.
- Keep functions focused and reasonably sized.
- Handle errors at system boundaries (external APIs, user input) — don't over-defend internal code paths.

### Security

- Never hardcode secrets, API keys, or credentials.
- Sanitize and validate all external input (URLs, user parameters, API responses).
- Be cautious with `eval`, dynamic imports, or shell commands.
- When handling URLs, use the existing `sanitizeUrl` and SSRF protections.
- Run `npm audit` if you add or update dependencies.

## Testing Requirements

- **Unit tests are required** for new functionality.
- **Bug fix PRs** should include a regression test.
- All tests must pass: `npm test` (860+ tests across 37+ suites).
- For test coverage: `npm run test:coverage`
- See the [Testing Guide](./testing-guide.md) for patterns and best practices.

### Test file naming

- Unit/component tests: `*.spec.ts` next to the source file
- Integration tests: `*.integration.spec.ts`
- E2E tests: `tests/e2e/`

## Documentation Standards

- **New features**: Document in README.md and/or relevant files in `docs/`.
- **Changed behavior**: Update existing documentation to match.
- **New MCP tools**: Must include detailed descriptions, parameter annotations, and a title in the tool registration — see existing tools in `src/server.ts` for the expected format.
- **Changelog**: Add an entry under `[Unreleased]` in `docs/CHANGELOG.md` for any user-facing change.

## Versioning

We use [Semantic Versioning](https://semver.org/):
- **MAJOR**: Breaking changes to the MCP tool interface
- **MINOR**: New tools, features, or non-breaking enhancements
- **PATCH**: Bug fixes, performance improvements, documentation

## Security

If you discover a security vulnerability, please do **not** open a public issue. See our [Security Policy](../SECURITY.md) for reporting instructions.

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](../LICENSE).