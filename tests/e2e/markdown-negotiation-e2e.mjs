// markdown-negotiation-e2e.mjs
// Tests that scrape_page correctly uses Accept: text/markdown content negotiation
// for sites that support it (Cloudflare Markdown for Agents, llms.txt, etc.)
import assert from "assert";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";

const client = new Client({ name: "markdown-negotiation-test", version: "1.0.0" });
const transport = new StdioClientTransport({
  command: "node",
  args: ["--no-warnings", "dist/server.js"],
  env: { ...process.env, MCP_TEST_MODE: "stdio" },
});

let passed = 0;
let failed = 0;

function report(name, ok, detail) {
  if (ok) {
    passed++;
    console.log(`✅ ${name}`);
  } else {
    failed++;
    console.error(`❌ ${name}: ${detail}`);
  }
}

try {
  await client.connect(transport);
  console.log("Connected to MCP server via stdio\n");

  // ─── Test 1: kaltura.md returns markdown via text/plain content negotiation ───
  {
    const result = await client.callTool({
      name: "scrape_page",
      arguments: { url: "https://kaltura.md" },
    });
    const text = result.content[0]?.text ?? "";
    const structured = result.structuredContent;

    report(
      "kaltura.md: returns markdown content",
      text.includes("# Kaltura API Guides"),
      `Expected markdown heading, got: ${text.substring(0, 100)}`
    );
    report(
      "kaltura.md: contentType is 'markdown'",
      structured?.contentType === "markdown",
      `Expected contentType 'markdown', got '${structured?.contentType}'`
    );
    report(
      "kaltura.md: contains guide links",
      text.includes("KALTURA_") || text.includes("kaltura"),
      "Expected Kaltura guide references in content"
    );
    report(
      "kaltura.md: preserves markdown structure (not HTML extraction)",
      !text.startsWith("Title:") && !text.includes("Headings:"),
      "Got HTML-extraction format instead of raw markdown"
    );
  }

  // ─── Test 2: Cloudflare docs with proper text/markdown Content-Type ───
  {
    const result = await client.callTool({
      name: "scrape_page",
      arguments: { url: "https://developers.cloudflare.com/fundamentals/reference/markdown-for-agents/" },
    });
    const text = result.content[0]?.text ?? "";
    const structured = result.structuredContent;

    report(
      "cloudflare docs: returns markdown content",
      text.includes("# Markdown for Agents") || text.includes("Markdown for Agents"),
      `Expected markdown content, got: ${text.substring(0, 100)}`
    );
    report(
      "cloudflare docs: contentType is 'markdown'",
      structured?.contentType === "markdown",
      `Expected contentType 'markdown', got '${structured?.contentType}'`
    );
    report(
      "cloudflare docs: contains code examples",
      text.includes("text/markdown") && text.includes("Accept"),
      "Expected content negotiation examples in the page"
    );
  }

  // ─── Test 3: Regular HTML site falls through to normal scraping ───
  {
    const result = await client.callTool({
      name: "scrape_page",
      arguments: { url: "https://www.example.com" },
    });
    const text = result.content[0]?.text ?? "";
    const structured = result.structuredContent;

    report(
      "example.com: does NOT return markdown contentType",
      structured?.contentType === "html",
      `Expected contentType 'html', got '${structured?.contentType}'`
    );
    report(
      "example.com: returns normal scraped content",
      text.includes("Example Domain") || text.includes("example"),
      `Expected page content, got: ${text.substring(0, 100)}`
    );
  }

  // ─── Test 4: Anthropic docs support markdown negotiation ───
  {
    const result = await client.callTool({
      name: "scrape_page",
      arguments: { url: "https://docs.anthropic.com/en/docs/overview" },
    });
    const text = result.content[0]?.text ?? "";
    const structured = result.structuredContent;

    report(
      "anthropic docs: returns markdown content",
      text.includes("Claude") && (text.includes("#") || text.includes("**")),
      `Expected markdown with Claude references, got: ${text.substring(0, 100)}`
    );
    report(
      "anthropic docs: contentType is 'markdown'",
      structured?.contentType === "markdown",
      `Expected contentType 'markdown', got '${structured?.contentType}'`
    );
  }

  console.log(`\n${"═".repeat(50)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log(`${"═".repeat(50)}`);

  await transport.close();
  process.exit(failed > 0 ? 1 : 0);
} catch (error) {
  console.error("Fatal error:", error);
  await transport.close().catch(() => {});
  process.exit(1);
}
