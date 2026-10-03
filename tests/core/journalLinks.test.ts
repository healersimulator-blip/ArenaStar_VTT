import { describe, expect, test } from "vitest";
import {
  journalLinks,
  journalSegments,
  maskJournalLinkTargets,
  visibleJournalLinks,
} from "../../src/core/journalLinks";

/** The page shape a handout uses: prose, a couple of links, one inside a secret block. */
const PAGE = [
  "# The gate",
  "",
  "Read this aloud, then @Tile[gate-tile]{open the gate}.",
  "",
  "Emergency: @Tile[Scene.s2.Tile.far-gate]{the far gate}",
  "",
  "Do not mention the key: <secret>the key is under @Tile[hidden-plate landing:vault]{the loose stone}</secret>",
  "",
  "And finally @Tile[Tile.bell active:true]{ring the bell}.",
].join("\n");

describe("journal tile links (TR-12)", () => {
  test("a link names its anchor, landing, scene and label", () => {
    const links = journalLinks("A @Tile[plate-1]{Open} B @Tile[Tile.plate-2 landing:vault active:true]{Vault} C");
    expect(links).toHaveLength(2);
    expect(links[0]).toMatchObject({ index: 0, tileId: "plate-1", label: "Open", activeOnly: false,
      hidden: false });
    expect(links[1]).toMatchObject({ index: 1, tileId: "plate-2", landing: "vault", activeOnly: true,
      label: "Vault" });
    expect(links[0]?.sceneId).toBeUndefined();
  });

  test("the scene-qualified form carries the scene and keeps the label order", () => {
    const links = journalLinks("@Tile[Scene.town.Tile.gate]{Far gate}");
    expect(links[0]).toMatchObject({ sceneId: "town", tileId: "gate", label: "Far gate" });
  });

  test("the bare Tile. prefix works like MATT's tile page shows it", () => {
    const links = journalLinks("@Tile[Tile.abc-1]{Go}");
    expect(links[0]).toMatchObject({ tileId: "abc-1", label: "Go" });
    expect(links[0]?.error).toBeUndefined();
  });

  test("a malformed payload stays a link (ordinals stay stable) and carries an error", () => {
    const links = journalLinks("@Tile[landing:]{Bad} then @Tile[good-1]{Good}");
    expect(links).toHaveLength(2);
    expect(links[0]?.error).toBe("malformed landing");
    expect(links[0]?.index).toBe(0);
    expect(links[1]).toMatchObject({ index: 1, tileId: "good-1", label: "Good" });
    expect(links[1]?.error).toBeUndefined();
    expect(journalLinks("@Tile[]{Empty}")[0]?.error).toBe("missing tile id");
    // The masked form a player receives is well-formed on purpose: it renders as a button.
    const delivered = journalLinks("@Tile[masked]{Open}");
    expect(delivered[0]).toMatchObject({ tileId: "masked", label: "Open" });
    expect(delivered[0]?.error).toBeUndefined();
    expect(journalLinks("@Tile[Scene.s2.Tile.]{Noname}")[0]?.error).toBe("malformed scene target");
    expect(journalLinks("@Tile[bad id!]{No}")[0]?.error).toBe("unknown link option id!");
    // A link without a `{label}` is plain text (never a button, never an ordinal).
    expect(journalLinks("see @Tile[abc] for details")).toEqual([]);
  });

  test("a link inside <secret> is flagged hidden and drops out of the visible list", () => {
    const links = journalLinks(PAGE);
    expect(links.map((link) => link.hidden)).toEqual([false, false, true, false]);
    const visible = visibleJournalLinks(PAGE);
    expect(visible.map((link) => [link.index, link.tileId]))
      .toEqual([[0, "gate-tile"], [1, "far-gate"], [2, "bell"]]);
  });

  test("masking preserves link count and order, so an ordinal means the same link for everyone", () => {
    const masked = maskJournalLinkTargets(PAGE);
    expect(masked).toContain("@Tile[masked]{open the gate}");
    expect(masked).not.toContain("gate-tile");
    expect(masked).not.toContain("hidden-plate");
    // A player's replica also loses the secret block; the visible list still lines up.
    const delivered = maskJournalLinkTargets(PAGE.replace(/<secret>[\s\S]*?<\/secret>/g, ""));
    expect(journalLinks(delivered).map((link) => [link.index, link.label]))
      .toEqual([[0, "open the gate"], [1, "the far gate"], [2, "ring the bell"]]);
    expect(visibleJournalLinks(PAGE).map((link) => [link.index, link.label]))
      .toEqual(journalLinks(delivered).map((link) => [link.index, link.label]));
  });

  test("segments keep page-absolute ordinals, including a link inside a secret block", () => {
    const segments = journalSegments(PAGE);
    const links = segments.filter((segment) => segment.kind === "link");
    expect(links.map((segment) => (segment.kind === "link" ? segment.index : -1))).toEqual([0, 1, 2, 3]);
    expect(links.map((segment) => (segment.kind === "link" ? segment.hidden : false)))
      .toEqual([false, false, true, false]);
    expect(links.map((segment) => (segment.kind === "link" ? segment.label : "")))
      .toEqual(["open the gate", "the far gate", "the loose stone", "ring the bell"]);
    // The prose around the links is still text, and the secret body stays its own block.
    expect(segments.some((segment) => segment.kind === "secret")).toBe(true);
    expect(segments.filter((segment) => segment.kind === "text").map((segment) => segment.text).join(""))
      .toContain("The gate");
  });

  test("a player's delivered text renders the same ordinals it was handed", () => {
    const delivered = maskJournalLinkTargets(PAGE.replace(/<secret>[\s\S]*?<\/secret>/g, ""));
    const links = journalSegments(delivered).filter((segment) => segment.kind === "link");
    expect(links).toHaveLength(3);
    expect(links.map((segment) => (segment.kind === "link" ? segment.index : -1))).toEqual([0, 1, 2]);
    expect(links.every((segment) => segment.kind !== "link" || segment.hidden === false)).toBe(true);
    expect(links.map((segment) => (segment.kind === "link" ? segment.label : "")))
      .toEqual(["open the gate", "the far gate", "ring the bell"]);
  });

  test("plain pages have no links and are otherwise untouched", () => {
    expect(journalLinks("Just prose with @Tiles and [links](https://x) but no trigger.")).toEqual([]);
    expect(maskJournalLinkTargets("nothing here")).toBe("nothing here");
  });
});
