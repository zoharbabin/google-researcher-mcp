#!/usr/bin/env node

const MIGRATION_NOTICE = `
╔══════════════════════════════════════════════════════════════════════╗
║                                                                      ║
║   google-researcher-mcp is DEPRECATED                                ║
║                                                                      ║
║   This package has been replaced by web-researcher-mcp (Go binary).  ║
║   The new version resolves all open issues, adds multiple search     ║
║   providers (Brave, Serper, SearXNG), and ships as a single binary.  ║
║                                                                      ║
║   ➜ Repo:    https://github.com/zoharbabin/web-researcher-mcp       ║
║   ➜ Install: go install github.com/zoharbabin/web-researcher-mcp/   ║
║              cmd/web-researcher-mcp@latest                           ║
║   ➜ Docker:  docker pull zoharbabin/web-researcher-mcp:latest        ║
║   ➜ Binary:  https://github.com/zoharbabin/web-researcher-mcp/      ║
║              releases/latest                                         ║
║                                                                      ║
║   Your existing GOOGLE_CUSTOM_SEARCH_API_KEY and                     ║
║   GOOGLE_CUSTOM_SEARCH_ID work without changes.                      ║
║                                                                      ║
║   Migration guide:                                                   ║
║   https://github.com/zoharbabin/web-researcher-mcp/blob/main/       ║
║   docs/MIGRATION.md                                                  ║
║                                                                      ║
╚══════════════════════════════════════════════════════════════════════╝
`;

process.stderr.write(MIGRATION_NOTICE + "\n");
process.exit(1);
