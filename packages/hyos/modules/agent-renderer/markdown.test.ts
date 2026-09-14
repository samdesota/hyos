import assert from "node:assert/strict";
import test from "node:test";

import {
  httpLinkUrl,
  mermaidDefinition,
  mermaidZoomScale,
  renderAgentMarkdown,
} from "./markdown.js";

test("agent Markdown renders as formatted, safe HTML", () => {
  const rendered = renderAgentMarkdown(
    "**Decision**\n\n- keep context\n- show `code`\n\n```mermaid\ngraph LR\n  A --> B\n```\n\n<script>alert(1)</script>",
  );

  assert.match(rendered, /<strong>Decision<\/strong>/);
  assert.match(rendered, /<ul>/);
  assert.match(rendered, /<code>code<\/code>/);
  assert.match(rendered, /class="language-mermaid"/);
  assert.doesNotMatch(rendered, /<script>/);
});

test("agent Markdown renders GFM pipe tables as HTML tables", () => {
  const rendered = renderAgentMarkdown(
    "| Name | Status |\n| --- | --- |\n| keep | done |\n| drop | todo |",
  );

  assert.match(rendered, /<table>/);
  assert.match(rendered, /<thead>/);
  assert.match(rendered, /<th>Name<\/th>/);
  assert.match(rendered, /<th>Status<\/th>/);
  assert.match(rendered, /<tbody>/);
  assert.match(rendered, /<td>keep<\/td>/);
  assert.match(rendered, /<td>todo<\/td>/);
  assert.match(rendered, /<\/table>/);
});

test("Mermaid definitions tolerate an agent-wrapped text fence", () => {
  const source = "flowchart LR\n  A --> B";

  assert.equal(mermaidDefinition("mermaid", source), source);
  assert.equal(
    mermaidDefinition("text", `\`\`\`mermaid\n${source}\n\`\`\``),
    source,
  );
  assert.equal(
    mermaidDefinition("typescript", `\`\`\`mermaid\n${source}\n\`\`\``),
    undefined,
  );
});

test("Mermaid trackpad zoom is smooth and bounded", () => {
  assert.ok(mermaidZoomScale(1, -20) > 1);
  assert.ok(mermaidZoomScale(1, 20) < 1);
  assert.equal(mermaidZoomScale(5, -1_000), 5);
  assert.equal(mermaidZoomScale(0.25, 1_000), 0.25);
});

test("http link clicks resolve to an absolute web url; others pass through", () => {
  const click = (href: string) => ({
    target: {
      closest: (selector: string) =>
        selector === "a[href]" ? { getAttribute: () => href } : null,
    } as unknown as Element,
  });
  const event = (target: Element | null) => ({ target });

  assert.equal(
    httpLinkUrl(click("https://example.com/page#sec")),
    "https://example.com/page#sec",
  );
  assert.equal(httpLinkUrl(click("http://example.com")), "http://example.com/");
  // Relative and non-web schemes are not routed to the side panel.
  assert.equal(httpLinkUrl(click("/docs/index.html")), null);
  assert.equal(httpLinkUrl(click("javascript:alert(1)")), null);
  assert.equal(httpLinkUrl(click("mailto:a@b.c")), null);
  assert.equal(httpLinkUrl(click("")), null);
  // A click outside any anchor keeps its default behavior.
  assert.equal(httpLinkUrl(event(null)), null);
});
