/** Browser input adapters for file/URL drag-and-drop and clipboard paste. */
export type ImageSource =
  | { kind: "file"; file: File; name: string }
  | { kind: "url"; url: string; name: string };

const IMAGE_NAME = /\.(?:png|jpe?g|webp|gif|avif|svg)$/i;

export function isPotentialImageFile(file: File): boolean {
  return file.type.toLowerCase().startsWith("image/") || IMAGE_NAME.test(file.name);
}

export function imageSourcesFromTransfer(transfer: DataTransfer | null | undefined): ImageSource[] {
  if (!transfer) return [];
  return collectSources(
    Array.from(transfer.files ?? []).filter(isPotentialImageFile),
    safeGetData(transfer, "text/uri-list"),
    safeGetData(transfer, "text/html"),
    safeGetData(transfer, "text/plain"),
  );
}

/** Clipboard paste deliberately reads the event payload, never navigator.clipboard.read(). */
export function imageSourcesFromClipboard(clipboard: DataTransfer | null | undefined): ImageSource[] {
  if (!clipboard) return [];
  const files: File[] = [];
  for (const item of Array.from(clipboard.items ?? [])) {
    if (item.kind !== "file") continue;
    const file = item.getAsFile();
    if (file && isPotentialImageFile(file)) files.push(file);
  }
  return collectSources(
    files,
    safeGetData(clipboard, "text/uri-list"),
    safeGetData(clipboard, "text/html"),
    safeGetData(clipboard, "text/plain"),
  );
}

function collectSources(files: readonly File[], uriList: string, html: string, plainText: string): ImageSource[] {
  const sources: ImageSource[] = files.map((file) => ({ kind: "file", file, name: file.name || "Image" }));
  if (html) {
    try {
      const parsed = new DOMParser().parseFromString(html, "text/html");
      for (const image of Array.from(parsed.querySelectorAll("img[src]"))) {
        const url = (image.getAttribute("src") ?? "").trim();
        if (url) sources.push({ kind: "url", url, name: image.getAttribute("alt")?.trim() || nameFromUrl(url) });
      }
      if (!parsed.querySelector("img[src]")) {
        for (const anchor of Array.from(parsed.querySelectorAll("a[href]"))) {
          const url = (anchor.getAttribute("href") ?? "").trim();
          if (/^https:\/\//i.test(url) && (IMAGE_NAME.test(url) || !parsed.body.textContent?.trim()))
            sources.push({ kind: "url", url, name: nameFromUrl(url) });
        }
      }
    } catch {
      // Malformed browser drag markup is ignored; uri-list/plain-text paths still apply.
    }
  }
  for (const raw of uriList.split(/\r?\n/)) {
    const url = raw.trim();
    if (!url || url.startsWith("#")) continue;
    sources.push({ kind: "url", url, name: nameFromUrl(url) });
  }
  const plain = plainText.trim();
  if (looksLikeUrl(plain)) sources.push({ kind: "url", url: plain, name: nameFromUrl(plain) });
  return deduplicate(sources);
}

function safeGetData(transfer: Pick<DataTransfer, "getData">, type: string): string {
  try { return transfer.getData(type) ?? ""; } catch { return ""; }
}

function looksLikeUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

function nameFromUrl(value: string): string {
  try {
    const url = new URL(value);
    const leaf = decodeURIComponent(url.pathname.split("/").pop() ?? "").trim();
    return leaf || "Image";
  } catch {
    return "Image";
  }
}

function deduplicate(sources: ImageSource[]): ImageSource[] {
  const seen = new Set<string>();
  const result: ImageSource[] = [];
  for (const source of sources) {
    const key = source.kind === "file" ? `file:${source.file.name}:${source.file.size}:${source.file.lastModified}` : `url:${source.url}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(source);
  }
  return result;
}
