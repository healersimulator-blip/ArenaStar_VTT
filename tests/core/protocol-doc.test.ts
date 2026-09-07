import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { MsgKind } from "../../src/core/messages";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

describe("PROTOCOL.md ↔ MsgKind consistency (§0, §13, D-010)", () => {
  const doc = readFileSync(resolve(repoRoot, "PROTOCOL.md"), "utf8");

  test("every MsgKind message has a documented section with its byte value", () => {
    for (const [name, byte] of Object.entries(MsgKind)) {
      const heading = `### ${name} (0x`;
      expect(doc, `PROTOCOL.md missing heading for '${name}'`).toContain(heading);
      const section = doc.slice(doc.indexOf(heading));
      const hex = byte.toString(16).padStart(2, "0");
      expect(section.slice(0, 120), `'${name}' section should open with byte 0x${hex}`).toContain(
        `0x${hex}`,
      );
    }
  });

  test("documented message sections exactly match the MsgKind names", () => {
    const documented = [...doc.matchAll(/^### ([a-z.]+) \(0x/gm)].map((m) => m[1]);
    expect(new Set(documented).size).toBe(documented.length); // no duplicates
    expect(documented.sort()).toEqual([...Object.keys(MsgKind)].sort());
  });

  test("channel table lists the four §6.1 channels", () => {
    for (const ch of ["ops", "ephemeral", "assets", "sim"]) {
      expect(doc).toContain(`| \`${ch}\``);
    }
  });
});
