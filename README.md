# google-researcher-mcp — DEPRECATED

> **⚠️ This project has been superseded by [`web-researcher-mcp`](https://github.com/zoharbabin/web-researcher-mcp).**
>
> A complete rewrite in Go: same tools, but it cites real sources and stays honest — citation verification, retraction flagging, eight search providers behind one interface, and a single signed static binary. No Node.js, no npm.

---

## Migrate in one line

Your **API keys and tool calls don't change** — only how the server is launched. Pick whichever you prefer (no Node required):

```bash
# macOS / Linux — installs the binary and registers it with Claude Code automatically:
curl -fsSL https://raw.githubusercontent.com/zoharbabin/web-researcher-mcp/main/install.sh | sh

# Windows (PowerShell):
powershell -ExecutionPolicy Bypass -c "irm https://raw.githubusercontent.com/zoharbabin/web-researcher-mcp/main/install.ps1 | iex"

# Python users (uv) — run with no install:
uvx web-researcher-mcp
```

### Before / after (MCP client config)

The config keeps the **same shape** — swap the `command`/`args`, keep your env:

```jsonc
// BEFORE — google-researcher-mcp (npx / Node)
{
  "mcpServers": {
    "google-researcher": {
      "command": "npx",
      "args": ["-y", "google-researcher-mcp"],
      "env": { "GOOGLE_CUSTOM_SEARCH_API_KEY": "…", "GOOGLE_CUSTOM_SEARCH_ID": "…" }
    }
  }
}

// AFTER — web-researcher-mcp (installed binary; or use "uvx" + args ["web-researcher-mcp"])
{
  "mcpServers": {
    "web-researcher": {
      "command": "web-researcher-mcp",
      "env": { "GOOGLE_CUSTOM_SEARCH_API_KEY": "…", "GOOGLE_CUSTOM_SEARCH_ID": "…" }
    }
  }
}
```

> **Don't run both at once** — they register identical tool names. Remove the `google-researcher` entry before adding `web-researcher`.

**→ [Full migration guide](https://github.com/zoharbabin/web-researcher-mcp/blob/main/docs/MIGRATION.md)**

Your existing `GOOGLE_CUSTOM_SEARCH_API_KEY` and `GOOGLE_CUSTOM_SEARCH_ID` work unchanged.

---

## Why the Rewrite?

| Open Issue | Resolution in web-researcher-mcp |
|------------|----------------------------------|
| [#108](https://github.com/zoharbabin/google-researcher-mcp/issues/108) — Orphan detection fails via npx | Go binary has native process lifecycle (EOF/SIGPIPE) — no npm wrapper |
| [#107](https://github.com/zoharbabin/google-researcher-mcp/issues/107) — Google discontinuing 'entire web' search | Eight providers (Brave, Serper, SearXNG, SearchAPI, Tavily, Exa, DuckDuckGo + Google PSE for lenses) with automatic fallback |
| [#55](https://github.com/zoharbabin/google-researcher-mcp/issues/55) — Support alternative search engines | Multiple engines behind one interface, plus a zero-config DuckDuckGo default |
| [#72](https://github.com/zoharbabin/google-researcher-mcp/issues/72) — Add Redis caching | Hybrid cache: memory + AES-encrypted disk + optional Redis |
| [#40](https://github.com/zoharbabin/google-researcher-mcp/issues/40) — Split server.ts into modules | Fully modular Go architecture (one package per concern) |

Plus what's new: **verify_citation** and **audit_bibliography** (catch fabricated/retracted citations), academic / patent / SEC-filing / US-case-law / economic / clinical-trial search, and authority-weighted search lenses.

---

## Links

- **New project**: https://github.com/zoharbabin/web-researcher-mcp
- **Install (all methods)**: [README → Get started](https://github.com/zoharbabin/web-researcher-mcp#get-started-in-30-seconds)
- **Docker**: `docker pull zoharbabin/web-researcher-mcp:latest`
- **Releases**: https://github.com/zoharbabin/web-researcher-mcp/releases
