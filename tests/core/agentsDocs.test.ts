// MCP connector §5 — `MCP_CONNECTOR.md` is the reference a GM reads, and a hand-written tool table
// is a table that drifts. So the table is rendered from the registry and asserted against the file:
// add a tool, forget the doc, and this test fails.
//
//   UPDATE_AGENT_DOCS=1 pnpm vitest run tests/core/agentsDocs.test.ts   ← rewrites the section
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import {
  DOC_SECTION_END,
  DOC_SECTION_START,
  renderToolSection,
  toolCount,
} from "../../src/core/agents/docs";
import { RESOURCE_TEMPLATES } from "../../src/core/agents/resources";
import { AGENT_TOOLS } from "../../src/core/agents/tools";
import { AGENT_PROMPTS } from "../../src/core/agents/prompts";

const docPath = fileURLToPath(new URL("../../MCP_CONNECTOR.md", import.meta.url));

const sectionIn = (body: string): string | null => {
  const at = body.indexOf(DOC_SECTION_START);
  if (at < 0) return null;
  const end = body.indexOf(DOC_SECTION_END, at);
  if (end < 0) return null;
  return body.slice(at, end + DOC_SECTION_END.length);
};

describe("the connector reference (§5)", () => {
  test("the rendered section every tool appears in, is the one in the file", () => {
    const body = readFileSync(docPath, "utf8");
    const found = sectionIn(body);
    expect(found, "MCP_CONNECTOR.md has no generated tool section").not.toBeNull();
    const wanted = renderToolSection();
    if (found === wanted) return;
    if (process.env["UPDATE_AGENT_DOCS"] === "1") {
      writeFileSync(docPath, body.replace(found ?? "", wanted), "utf8");
      return;
    }
    // Fail with something actionable rather than a diff of markdown.
    throw new Error(
      "MCP_CONNECTOR.md's tool table is out of date — re-run with UPDATE_AGENT_DOCS=1",
    );
  });

  test("every tool in the catalogue is named in the reference", () => {
    const body = readFileSync(docPath, "utf8");
    const found = sectionIn(body) ?? "";
    for (const tool of AGENT_TOOLS) {
      expect(found, `the tool table has no row for ${tool.name}`).toContain(`\`${tool.name}\``);
    }
    expect(toolCount()).toBe(AGENT_TOOLS.length);
  });

  test("the reference names every resource template and every prompt", () => {
    // The same drift risk as the tool table: a URI a client was told about that the bridge does
    // not answer is a dead end, and a promised recipe that does not exist is worse.
    const body = readFileSync(docPath, "utf8");
    for (const template of RESOURCE_TEMPLATES) {
      expect(body, `the reference does not mention ${template.uriTemplate}`).toContain(
        template.uriTemplate,
      );
    }
    for (const prompt of AGENT_PROMPTS) {
      expect(body, `the reference does not mention ${prompt.name}`).toContain(prompt.name);
    }
  });

  test("the reference says what the numbers in the plan said, or the plan is wrong too", () => {
    // The prose names counts; if they drift, a reader is told a surface that no longer exists.
    const body = readFileSync(docPath, "utf8");
    const tools = AGENT_TOOLS.filter((tool) => tool.name !== "token.create").length;
    expect(body).toContain(String(AGENT_TOOLS.length));
    expect(tools).toBeGreaterThan(30);
  });
});
