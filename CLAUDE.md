# CLAUDE.md - Canonical Project Context

## Project Overview
**google-researcher-mcp** - An MCP (Model Context Protocol) server providing Google Search, web scraping, and multi-source research tools for AI assistants.

## Quick Commands

### Build & Run
```bash
npm install                    # Install deps + Chromium browser (via postinstall)
npm run build                  # Build TypeScript to dist/
npm start                      # Start server (STDIO mode default)
npm run dev                    # Start with hot reload (development)
PORT=3001 npm start            # Start HTTP server on custom port
```

### Testing
```bash
npm test                       # Run all unit/component tests (860+)
npm run test:coverage          # Generate code coverage report
npm run test:e2e               # Full E2E suite (STDIO + SSE + YouTube)
npm run test:e2e:stdio         # STDIO transport E2E only
npm run test:e2e:sse           # HTTP/SSE transport E2E only
npm run test:e2e:youtube       # YouTube transcript E2E only
```

## Server Ports
- **Default**: PORT 3000 (configurable via `PORT` env var)
- **STDIO Transport**: No port (standard input/output)
- **HTTP/SSE Transport**: Listens on PORT (default 3000)

## Transport Modes
1. **STDIO** (default): For Claude Desktop and direct MCP clients
2. **HTTP/SSE**: For web clients, requires OAuth configuration

## Environment Variables
Required for Google Search:
- `GOOGLE_CUSTOM_SEARCH_API_KEY`
- `GOOGLE_CUSTOM_SEARCH_ID`

Required for HTTP transport (OAuth 2.1):
- `OAUTH_ISSUER_URL`
- `OAUTH_AUDIENCE`

Optional:
- `PORT` (default: 3000)
- `MCP_TEST_MODE=stdio` (force STDIO only)
- `ALLOWED_ORIGINS` (CORS origins)
- `ALLOW_PRIVATE_IPS` (for local development)

## Architecture
```
src/
├── server.ts          # Main server entry point
├── cache/             # Caching layer with persistence
├── documents/         # PDF, DOCX, PPTX parsing
├── prompts/           # MCP Prompts primitive
├── resources/         # MCP Resources primitive
├── schemas/           # Output schemas
├── shared/            # Shared utilities (OAuth, logging, etc.)
├── tools/             # Tool implementations
├── types/             # TypeScript types
└── youtube/           # YouTube transcript extraction
```

## MCP Tools Provided
- `google_search` - Google Custom Search
- `scrape_page` - Web/PDF/DOCX scraping
- `search_and_scrape` - Combined search + scrape
- `google_image_search` - Image search
- `google_news_search` - News search
- `academic_search` - Academic paper search
- `patent_search` - Patent search
- `sequential_search` - Multi-step research tracking

## MCP Resources (stats://*)
- `stats://tools` - Per-tool execution metrics (calls, latency, cache hits)
- `stats://tools/{name}` - Single tool metrics
- `stats://cache` - Cache performance metrics
- `stats://events` - Event store statistics

## Monitoring Endpoints (HTTP mode)
- `GET /mcp/metrics/prometheus` - Prometheus format metrics
- `GET /mcp/cache-stats` - Cache statistics JSON
- `GET /mcp/event-store-stats` - Event store statistics JSON

## Key Files
- `package.json` - Dependencies and scripts
- `.env.example` - Environment variable template
- `README.md` - User documentation
- `docs/` - Extended documentation

## GitHub Issues
Single source of truth for project roadmap. Use `gh issue list` to view.
