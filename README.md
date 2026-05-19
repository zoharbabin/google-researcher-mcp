# google-researcher-mcp — DEPRECATED

> **⚠️ This project has been superseded by [`web-researcher-mcp`](https://github.com/zoharbabin/web-researcher-mcp).**
>
> The new version is a complete rewrite in Go that resolves all open issues, adds multiple search providers (Brave, Serper, SearXNG), and ships as a single static binary — no Node.js or npm required.

---

## Migration Guide

**→ [Full migration instructions](https://github.com/zoharbabin/web-researcher-mcp/blob/main/docs/MIGRATION.md)**

Quick summary:

1. **Remove** the `google-researcher` entry from your MCP client config
2. **Install** the new binary (`go install`, Docker, or download from [Releases](https://github.com/zoharbabin/web-researcher-mcp/releases))
3. **Add** the `web-researcher` entry to your MCP config

Your existing `GOOGLE_CUSTOM_SEARCH_API_KEY` and `GOOGLE_CUSTOM_SEARCH_ID` work without changes.

---

## Why the Rewrite?

| Open Issue | Resolution in web-researcher-mcp |
|------------|----------------------------------|
| [#108](https://github.com/zoharbabin/google-researcher-mcp/issues/108) — Orphan detection fails via npx | Go binary has native process lifecycle (EOF/SIGPIPE) — no npm wrapper |
| [#107](https://github.com/zoharbabin/google-researcher-mcp/issues/107) — Google discontinuing 'entire web' search | Supports 4 providers: Brave, Serper, SearXNG + Google PSE for lenses |
| [#55](https://github.com/zoharbabin/google-researcher-mcp/issues/55) — Support alternative search engines | Built-in Brave, Serper, and SearXNG support |
| [#72](https://github.com/zoharbabin/google-researcher-mcp/issues/72) — Add Redis caching | Hybrid 3-tier cache: memory + AES-encrypted disk + optional Redis |
| [#40](https://github.com/zoharbabin/google-researcher-mcp/issues/40) — Split server.ts into modules | Fully modular Go architecture (one package per concern) |

---

## Links

- **New project**: https://github.com/zoharbabin/web-researcher-mcp
- **Docker**: `docker pull zoharbabin/web-researcher-mcp:latest`
- **Releases**: https://github.com/zoharbabin/web-researcher-mcp/releases

---

*This repository is archived and read-only. No further updates will be made here.*
