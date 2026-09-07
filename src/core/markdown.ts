/**
 * §10 markdown — tiny, SAFE renderer for chat and journal pages: the input is
 * HTML-escaped FIRST, then a fixed subset is transformed. No raw HTML ever
 * passes through. Supported: #/##/### headings, **bold**, *italic*, `code`,
 * ~~strike~~, > quotes, - lists, [text](https://…) links, paragraphs.
 */
const ESC: Array<[RegExp, string]> = [
  [/&/g, "&amp;"],
  [/</g, "&lt;"],
  [/>/g, "&gt;"],
  [/"/g, "&quot;"],
  [/'/g, "&#39;"],
];

export function escapeHtml(text: string): string {
  let out = text;
  for (const [re, sub] of ESC) out = out.replace(re, sub);
  return out;
}

function inline(escaped: string): string {
  return escaped
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>")
    .replace(/~~([^~]+)~~/g, "<del>$1</del>")
    .replace(
      /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
      '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>',
    );
}

/** Render markdown to a single HTML string (block elements joined). */
export function renderMarkdown(text: string): string {
  const lines = escapeHtml(text).split("\n");
  const out: string[] = [];
  let listOpen = false;
  let quoteOpen = false;
  let para: string[] = [];

  const flushPara = (): void => {
    if (para.length > 0) {
      out.push(`<p>${inline(para.join(" "))}</p>`);
      para = [];
    }
  };
  const closeBlocks = (): void => {
    if (listOpen) {
      out.push("</ul>");
      listOpen = false;
    }
    if (quoteOpen) {
      out.push("</blockquote>");
      quoteOpen = false;
    }
  };

  for (const raw of lines) {
    const line = raw ?? "";
    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    const bullet = /^\s*-\s+(.*)$/.exec(line);
    const quote = /^&gt;\s?(.*)$/.exec(line);
    if (heading) {
      flushPara();
      closeBlocks();
      const level = (heading[1] ?? "#").length;
      out.push(`<h${level}>${inline(heading[2] ?? "")}</h${level}>`);
    } else if (bullet) {
      flushPara();
      if (quoteOpen) {
        out.push("</blockquote>");
        quoteOpen = false;
      }
      if (!listOpen) {
        out.push("<ul>");
        listOpen = true;
      }
      out.push(`<li>${inline(bullet[1] ?? "")}</li>`);
    } else if (quote) {
      flushPara();
      if (listOpen) {
        out.push("</ul>");
        listOpen = false;
      }
      if (!quoteOpen) {
        out.push("<blockquote>");
        quoteOpen = true;
      }
      out.push(`<p>${inline(quote[1] ?? "")}</p>`);
    } else if (line.trim().length === 0) {
      flushPara();
      closeBlocks();
    } else {
      closeBlocks();
      para.push(line);
    }
  }
  flushPara();
  closeBlocks();
  return out.join("");
}

/** Split text into public/`<secret>` blocks (rendering + projection share it). */
export function splitSecretBlocks(text: string): Array<{ secret: boolean; text: string }> {
  const out: Array<{ secret: boolean; text: string }> = [];
  const re = /<secret>([\s\S]*?)<\/secret>/g;
  let last = 0;
  for (const m of text.matchAll(re)) {
    const at = m.index ?? 0;
    if (at > last) out.push({ secret: false, text: text.slice(last, at) });
    out.push({ secret: true, text: m[1] ?? "" });
    last = at + m[0].length;
  }
  if (last < text.length) out.push({ secret: false, text: text.slice(last) });
  return out;
}
