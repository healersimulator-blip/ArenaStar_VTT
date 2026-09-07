import { describe, expect, test } from "vitest";
import { buildChatMessage, evaluateInlineRolls, parseChatCommand } from "../../src/core/chat";
import { renderMarkdown, escapeHtml } from "../../src/core/markdown";

/** Deterministic rng: returns queued values in order, then repeats the last. */
function seq(...values: number[]): () => number {
  let i = 0;
  return () => values[Math.min(i++, values.length - 1)] as number;
}

describe("chat commands (§10)", () => {
  test("plain text is /say", () => {
    const p = parseChatCommand("hello world");
    expect(p.kind).toBe("say");
    expect(p.text).toBe("hello world");
  });

  test("roll commands carry their mode", () => {
    for (const kind of ["roll", "gmroll", "blindroll", "selfroll"] as const) {
      const p = parseChatCommand(`/${kind} 1d20+5`);
      expect(p.kind).toBe(kind);
      expect(p.formula).toBe("1d20+5");
    }
  });

  test("/me and /emote are emotes; /ooc works", () => {
    expect(parseChatCommand("/me dances").kind).toBe("emote");
    expect(parseChatCommand("/me dances").text).toBe("dances");
    expect(parseChatCommand("/emote bows").text).toBe("bows");
    expect(parseChatCommand("/ooc brb").kind).toBe("ooc");
  });

  test("/w: first token names the recipient(s), rest is the message (D-077)", () => {
    const p = parseChatCommand("/w alice bob you there?");
    expect(p.kind).toBe("whisper");
    expect(p.whisperNames).toEqual(["alice"]);
    expect(p.text).toBe("bob you there?");
  });

  test("/w supports comma-separated recipients; name-only yields empty text", () => {
    const p = parseChatCommand("/w alice,bob secret plans");
    expect(p.whisperNames).toEqual(["alice", "bob"]);
    expect(p.text).toBe("secret plans");
    const solo = parseChatCommand("/w alice");
    expect(solo.whisperNames).toEqual(["alice"]);
    expect(solo.text).toBe("");
  });

  test("unknown slash command falls back to say", () => {
    const p = parseChatCommand("/frobnicate all the things");
    expect(p.kind).toBe("say");
    expect(p.text).toBe("/frobnicate all the things");
  });
});

describe("inline rolls (§10 [[formula]])", () => {
  test("a roll is rewritten to the total|formula chip", () => {
    const out = evaluateInlineRolls("I attack for [[1d4+1]] damage!", seq(0.999)); // 1d4 → 4
    expect(out.content).toBe("I attack for [[5|1d4+1]] damage!");
    expect(out.rolls).toHaveLength(1);
    expect(out.rolls[0]?.total).toBe(5);
    expect(out.errors).toEqual([]);
  });

  test("multiple rolls all evaluate, in order", () => {
    const out = evaluateInlineRolls("[[1d2]] then [[2d1]]", seq(0.9, 0.1)); // 2 then 2
    expect(out.rolls.map((r) => r.total)).toEqual([2, 2]);
    expect(out.content).toBe("[[2|1d2]] then [[2|2d1]]");
  });

  test("invalid formulas stay verbatim and are reported", () => {
    const out = evaluateInlineRolls("bad [[1d]] roll");
    expect(out.content).toBe("bad [[1d]] roll");
    expect(out.errors).toEqual(["1d"]);
  });
});

describe("message building (§10)", () => {
  test("roll command builds a roll card message", () => {
    const { message, errors } = buildChatMessage({
      author: "u1",
      parsed: parseChatCommand("/roll 1d20+5"),
      rng: seq(0.0), // 1d20 → 1
    });
    expect(errors).toEqual([]);
    expect(message.rollMode).toBe("roll");
    expect(message.roll?.total).toBe(6);
    expect(message.roll?.formula).toBe("1d20+5");
    expect(message.content).toBe("[[6|1d20+5]]");
    expect(message.author).toBe("u1");
  });

  test("gmroll marks the mode", () => {
    const { message } = buildChatMessage({
      author: "u1",
      parsed: parseChatCommand("/gmroll 1d6"),
      rng: seq(0.5), // → 4
    });
    expect(message.rollMode).toBe("gmroll");
    expect(message.roll?.total).toBe(4);
  });

  test("whisper resolves names to ids and flags unknowns", () => {
    const { message, errors } = buildChatMessage({
      author: "u1",
      parsed: parseChatCommand("/w alice hi"),
      resolveUser: (n) => (n === "alice" ? "u9" : null),
    });
    expect(message.whisper).toEqual(["u9"]);
    expect(errors).toEqual([]);
    const bad = buildChatMessage({
      author: "u1",
      parsed: parseChatCommand("/w nobody hi"),
      resolveUser: () => null,
    });
    expect(bad.errors).toContain("unknown whisper recipient");
  });

  test("emote flavor", () => {
    const { message } = buildChatMessage({ author: "u1", parsed: parseChatCommand("/me dances") });
    expect(message.flavor).toBe("emote");
    expect(message.content).toBe("dances");
  });
});

describe("markdown (§10 safe subset)", () => {
  test("HTML is escaped before anything else", () => {
    const html = renderMarkdown('<script>alert("x")</script>');
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  test("headings, bold, italic, code, strike", () => {
    expect(renderMarkdown("# Title")).toBe("<h1>Title</h1>");
    expect(renderMarkdown("### Deep")).toBe("<h3>Deep</h3>");
    expect(renderMarkdown("**bold** and *italic* and `code` and ~~gone~~")).toBe(
      "<p><strong>bold</strong> and <em>italic</em> and <code>code</code> and <del>gone</del></p>",
    );
  });

  test("lists and quotes become blocks", () => {
    expect(renderMarkdown("- one\n- two")).toBe("<ul><li>one</li><li>two</li></ul>");
    expect(renderMarkdown("> quoted")).toBe("<blockquote><p>quoted</p></blockquote>");
  });

  test("links only for http(s); javascript: stays inert text", () => {
    expect(renderMarkdown("[x](https://a.b)")).toContain('<a href="https://a.b"');
    const evil = renderMarkdown("[x](javascript:alert(1))");
    expect(evil).not.toContain("<a ");
    expect(evil).toContain("javascript:alert(1)"); // visible, escaped, inert
  });

  test("paragraphs split on blank lines", () => {
    expect(renderMarkdown("one\n\ntwo")).toBe("<p>one</p><p>two</p>");
  });

  test("roll chips survive markdown untouched", () => {
    expect(renderMarkdown("hit [[6|1d6]]!")).toBe("<p>hit [[6|1d6]]!</p>");
  });

  test("escapeHtml covers quotes", () => {
    expect(escapeHtml(`a"b'c<d`)).toBe("a&quot;b&#39;c&lt;d");
  });
});
