import { afterEach, describe, expect, test, vi } from "vitest";
import {
  imageSourcesFromClipboard,
  imageSourcesFromTransfer,
  isPotentialImageFile,
} from "../../src/ui/images/imageSources";

function transfer(data: Record<string, string>, files: File[] = [], items?: DataTransferItem[]): DataTransfer {
  return {
    files,
    items: items ?? [],
    types: Object.keys(data).concat(files.length ? ["Files"] : []),
    getData: (type: string) => data[type] ?? "",
  } as unknown as DataTransfer;
}

afterEach(() => vi.unstubAllGlobals());

describe("image file, URL drop and clipboard adapters", () => {
  test("keeps image files in a batch, reads URI-list and plain-text URLs, and deduplicates", () => {
    const map = new File([new Uint8Array([1, 2])], "my_map+v2.png", { type: "image/png", lastModified: 1 });
    const sources = imageSourcesFromTransfer(transfer({
      "text/uri-list": "# browser comment\r\nhttps://cdn.example/maps/cave%20map.png?size=2\r\nhttps://cdn.example/second.webp",
      "text/plain": "https://cdn.example/maps/cave%20map.png?size=2",
    }, [map]));
    expect(sources).toEqual([
      { kind: "file", file: map, name: "my_map+v2.png" },
      { kind: "url", url: "https://cdn.example/maps/cave%20map.png?size=2", name: "cave map.png" },
      { kind: "url", url: "https://cdn.example/second.webp", name: "second.webp" },
    ]);
  });

  test("clipboard reads image file items plus pasted URL text", () => {
    const image = new File([new Uint8Array([3, 4])], "clipboard.avif", { type: "image/avif", lastModified: 2 });
    const nonImage = new File(["text"], "notes.txt", { type: "text/plain", lastModified: 3 });
    const sources = imageSourcesFromClipboard(transfer({
      "text/plain": "https://example.org/handout.png",
    }, [], [
      { kind: "file", getAsFile: () => image } as unknown as DataTransferItem,
      { kind: "file", getAsFile: () => nonImage } as unknown as DataTransferItem,
      { kind: "string", getAsFile: () => null } as unknown as DataTransferItem,
    ]));
    expect(sources).toEqual([
      { kind: "file", file: image, name: "clipboard.avif" },
      { kind: "url", url: "https://example.org/handout.png", name: "handout.png" },
    ]);
  });

  test("extracts browser-dragged HTML image sources", () => {
    class TestDOMParser {
      parseFromString(html: string): Document {
        const images = [...html.matchAll(/<img\s+[^>]*src=["']([^"']+)["'][^>]*>/gi)].map((match) => ({
          getAttribute: (name: string) => name === "src" ? match[1] ?? ""
            : name === "alt" ? match[0]?.match(/alt=["']([^"']*)["']/i)?.[1] ?? "" : "",
        }));
        const anchors = [...html.matchAll(/<a\s+[^>]*href=["']([^"']+)["'][^>]*>/gi)].map((match) => ({
          getAttribute: (name: string) => name === "href" ? match[1] ?? "" : "",
        }));
        return {
          querySelectorAll: (selector: string) => selector === "img[src]" ? images : anchors,
          querySelector: (selector: string) => selector === "img[src]" ? images[0] ?? null : anchors[0] ?? null,
          body: { textContent: "" },
        } as unknown as Document;
      }
    }
    vi.stubGlobal("DOMParser", TestDOMParser);
    expect(imageSourcesFromTransfer(transfer({
      "text/html": '<p><img src="https://cdn.example/map.png" alt="Dungeon"></p>',
    }))).toEqual([{ kind: "url", url: "https://cdn.example/map.png", name: "Dungeon" }]);
  });

  test("filters likely image files but leaves byte validation to the import boundary", () => {
    expect(isPotentialImageFile(new File(["svg"], "drawing.svg", { type: "image/svg+xml" }))).toBe(true);
    expect(isPotentialImageFile(new File(["x"], "map.bin", { type: "application/octet-stream" }))).toBe(false);
  });
});
