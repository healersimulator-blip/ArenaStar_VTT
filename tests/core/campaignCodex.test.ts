import { describe, expect, test } from "vitest";
import type {
  ActorDocument,
  CodexSheet,
  ItemDocument,
  JournalDocument,
  JournalPageDocument,
  SceneDocument,
} from "../../src/core/documents";
import type { PermissionUser } from "../../src/core/ownership";
import {
  canReadCodexRef,
  codexArchiveJournalError,
  codexDocumentError,
  codexPageVisible,
  resolveCodexWorldRef,
} from "../../src/core/campaignCodex";
import { projectJournal } from "../../src/core/projection";

const gm: PermissionUser = { id: "gm", role: "GM" };
const player: PermissionUser = { id: "player-1", role: "PLAYER" };
const other: PermissionUser = { id: "player-2", role: "PLAYER" };

function page(
  id: string,
  over: Partial<JournalPageDocument> = {},
): JournalPageDocument {
  return {
    _id: id,
    type: "page",
    name: id,
    ownership: { default: 1 },
    flags: {},
    system: {},
    text: `# ${id}`,
    src: null,
    ...over,
  };
}

function codexOf(journal: JournalDocument): CodexSheet {
  if (!journal.codex) throw new Error("Expected a Codex journal");
  return journal.codex;
}

function sheet(
  id: string,
  over: Partial<JournalDocument> = {},
): JournalDocument {
  const codex: CodexSheet = {
    version: 1,
    kind: "entry",
    tabs: [
      { key: "info", label: "Info", order: 0 },
      {
        key: "secret",
        label: "Secrets",
        order: 1,
        audience: { kind: "gmOnly" },
      },
    ],
    links: [],
    widgets: [],
    quests: [],
  };
  return {
    _id: id,
    type: "journal",
    name: id,
    ownership: { default: 1 },
    flags: {},
    system: {},
    pages: [page(`${id}-page`, { codex: { tabKey: "info" } })],
    codex,
    ...over,
  };
}

function actor(
  id: string,
  access: ActorDocument["ownership"]["default"],
): ActorDocument {
  return {
    _id: id,
    type: "actor",
    name: id,
    ownership: { default: access },
    flags: {},
    system: {},
    items: [],
    effects: [],
  };
}

function scene(id: string): SceneDocument {
  return {
    _id: id,
    type: "scene",
    name: id,
    ownership: { default: 1 },
    flags: {},
    system: {},
    active: true,
    img: null,
    width: 100,
    height: 100,
    darkness: 0,
    grid: {
      type: "square",
      size: 100,
      distance: 5,
      units: "ft",
      diagonals: "555",
      hexLayout: "oddQ",
    },
    tokens: [],
    walls: [],
    lights: [],
    sounds: [],
    tiles: [],
    drawings: [],
    templates: [],
    notes: [],
  };
}

describe("Campaign Codex schema and projection", () => {
  test("filters page/tab, link, quest/objective, widget, and shop data before player projection", () => {
    const publicActor = actor("actor-public", 1);
    const privateActor = actor("actor-private", 0);
    const journal = sheet("codex", {
      pages: [
        page("public", {
          text: "Hello <secret>hidden prose</secret> world",
          codex: { tabKey: "info", audience: { kind: "inherit" } },
        }),
        page("private", {
          text: "GM page",
          codex: { tabKey: "secret", audience: { kind: "inherit" } },
        }),
        page("selected", {
          text: "Only another reader",
          codex: {
            tabKey: "info",
            audience: { kind: "selectedUsers", userIds: [other.id] },
          },
        }),
      ],
      codex: {
        version: 1,
        kind: "entry",
        tabs: [
          {
            key: "info",
            label: "Info",
            order: 0,
            audience: { kind: "inherit" },
          },
          {
            key: "secret",
            label: "Secrets",
            order: 1,
            audience: { kind: "gmOnly" },
          },
        ],
        links: [
          {
            id: "link-public",
            relation: "representsActor",
            target: { coll: "actors", id: publicActor._id },
            audience: { kind: "inherit" },
          },
          {
            id: "link-private",
            relation: "representsActor",
            target: { coll: "actors", id: privateActor._id },
            audience: { kind: "inherit" },
          },
        ],
        quests: [
          {
            id: "quest-public",
            title: "Public quest",
            description: "Visible",
            state: "active",
            pinned: true,
            order: 0,
            audience: { kind: "inherit" },
            objectives: [
              {
                id: "obj-public",
                title: "Find the gate",
                completed: false,
                order: 0,
                audience: { kind: "inherit" },
                children: [],
              },
              {
                id: "obj-secret",
                title: "Secret lever",
                completed: false,
                order: 1,
                audience: { kind: "gmOnly" },
                children: [],
              },
            ],
          },
          {
            id: "quest-secret",
            title: "GM quest",
            description: "Private",
            state: "active",
            pinned: false,
            order: 1,
            audience: { kind: "gmOnly" },
            objectives: [],
          },
        ],
        widgets: [
          {
            id: "widget-enabled",
            type: "quest-list",
            version: 1,
            tab: "info",
            order: 0,
            enabled: true,
            audience: { kind: "inherit" },
            config: { privateId: "must-not-cross" },
          },
          {
            id: "widget-disabled",
            type: "future-widget",
            version: 1,
            tab: "info",
            order: 1,
            enabled: false,
            audience: { kind: "inherit" },
            config: {},
          },
          {
            id: "widget-private",
            type: "timeline",
            version: 1,
            tab: "info",
            order: 2,
            enabled: true,
            audience: { kind: "gmOnly" },
            config: {},
          },
        ],
        shop: {
          mode: "loot",
          audience: { kind: "inherit" },
          markup: 3,
          stock: [
            {
              id: "row-public",
              item: { coll: "items", id: "item-public" },
              quantity: 2,
              unitPrice: "9 gp",
              order: 0,
            },
            {
              id: "row-private",
              item: { coll: "items", id: "item-private" },
              quantity: 1,
              unitPrice: "99 gp",
              order: 1,
            },
          ],
        },
      },
    });
    const itemPublic: ItemDocument = {
      _id: "item-public",
      type: "item",
      name: "Visible item",
      ownership: { default: 1 },
      flags: {},
      system: {},
      effects: [],
    };
    const itemPrivate: ItemDocument = {
      _id: "item-private",
      type: "item",
      name: "Secret item",
      ownership: { default: 0 },
      flags: {},
      system: {},
      effects: [],
    };
    const resolver = {
      resolve: (ref: { coll: string; id: string }) => {
        if (ref.coll === "actors")
          return ref.id === publicActor._id
            ? publicActor
            : ref.id === privateActor._id
              ? privateActor
              : undefined;
        if (ref.coll === "items")
          return ref.id === itemPublic._id
            ? itemPublic
            : ref.id === itemPrivate._id
              ? itemPrivate
              : undefined;
        return undefined;
      },
    };

    const projected = projectJournal(journal, player, resolver);
    expect(projected.pages.map((item) => item._id)).toEqual(["public"]);
    expect(projected.pages[0]?.text).toBe("Hello  world");
    expect(projected.pages[0]?.codex?.audience).toBeUndefined();
    expect(projected.codex?.tabs?.map((tab) => tab.key)).toEqual(["info"]);
    expect(projected.codex?.tabs?.[0]?.audience).toBeUndefined();
    expect(projected.codex?.links.map((link) => link.id)).toEqual([
      "link-public",
    ]);
    expect(projected.codex?.links[0]?.audience).toBeUndefined();
    expect(projected.codex?.quests?.map((quest) => quest.id)).toEqual([
      "quest-public",
    ]);
    expect(
      projected.codex?.quests?.[0]?.objectives.map((objective) => objective.id),
    ).toEqual(["obj-public"]);
    expect(projected.codex?.quests?.[0]?.audience).toBeUndefined();
    expect(projected.codex?.widgets.map((widget) => widget.id)).toEqual([
      "widget-enabled",
    ]);
    expect(projected.codex?.widgets[0]?.config).toEqual({});
    expect(projected.codex?.widgets[0]?.audience).toBeUndefined();
    expect(projected.codex?.shop?.stock.map((row) => row.id)).toEqual([
      "row-public",
    ]);
    expect(projected.codex?.shop?.stock[0]).not.toHaveProperty("unitPrice");
    expect(projected.codex?.shop).not.toHaveProperty("markup");
    expect(projected.codex?.shop).not.toHaveProperty("audience");
    expect(
      projected.codex?.links.some(
        (link) => link.target.id === privateActor._id,
      ),
    ).toBe(false);
  });

  test("sanitizes first-party widget config and local media references before player delivery", () => {
    const image = "c".repeat(64);
    const hiddenImage = "d".repeat(64);
    const base = sheet("widget-projection");
    const journal: JournalDocument = {
      ...base,
      codex: {
        ...codexOf(base),
        links: [{ id: "visible-link", relation: "relatedTo", target: { coll: "journals", id: "related" } }],
        quests: [
          { id: "visible-quest", title: "Visible", description: "", state: "active", pinned: false, order: 0, objectives: [] },
        ],
        widgets: [
          { id: "links", type: "linked-entities", version: 1, tab: "info", order: 0, enabled: true,
            config: { linkIds: ["visible-link", "hidden-link"] } },
          { id: "quests", type: "quest-list", version: 1, tab: "info", order: 1, enabled: true,
            config: { questIds: ["visible-quest", "secret-quest"] } },
          { id: "gallery", type: "image-gallery", version: 1, tab: "info", order: 2, enabled: true,
            config: { images: [{ assetId: image, caption: "Known" }, { assetId: hiddenImage, caption: "Unknown" }] } },
        ],
      },
    };
    const projected = projectJournal(journal, player, {
      resolve: () => undefined,
      canReadAsset: (assetId) => assetId === image,
    });
    expect(projected.codex?.links).toEqual([]); // The link target could not be resolved.
    expect(projected.codex?.widgets.find((widget) => widget.id === "links")?.config).toEqual({ linkIds: [] });
    expect(projected.codex?.widgets.find((widget) => widget.id === "quests")?.config).toEqual({ questIds: ["visible-quest"] });
    expect(projected.codex?.widgets.find((widget) => widget.id === "gallery")?.config).toEqual({
      images: [{ assetId: image, caption: "Known" }],
    });
  });

  test("checks page and linked-document access as an intersection, including parent access", () => {
    const journal = sheet("journal", { ownership: { default: 0 } });
    const pageDoc = journal.pages[0];
    if (!pageDoc) throw new Error("Expected a journal page");
    const ref = {
      coll: "pages",
      id: pageDoc._id,
      parent: { coll: "journals", id: journal._id },
    } as const;
    const resolver = {
      resolve: (target: typeof ref | { coll: string; id: string }) => {
        if (target.coll === "pages") return pageDoc;
        if (target.coll === "journals") return journal;
        if (target.coll === "actors") return actor("actor", 1);
        return undefined;
      },
    };
    expect(canReadCodexRef(player, ref, resolver)).toBe(false);
    expect(canReadCodexRef(gm, ref, resolver)).toBe(true);
    expect(
      codexPageVisible(
        {
          ...pageDoc,
          codex: { audience: { kind: "selectedUsers", userIds: [other.id] } },
        },
        { ...journal, ownership: { default: 1 } },
        player,
      ),
    ).toBe(false);
    const defaultPrivateTab = sheet("default-private-tab", {
      pages: [page("implicit-private-page")],
      codex: {
        ...codexOf(sheet("tmp")),
        tabs: [
          {
            key: "notes",
            label: "Notes",
            order: 0,
            audience: { kind: "gmOnly" },
          },
        ],
      },
    });
    expect(projectJournal(defaultPrivateTab, player).pages).toEqual([]);
    expect(
      canReadCodexRef(player, { coll: "actors", id: "actor" }, resolver),
    ).toBe(true);
  });

  test("validates relations and rejects containment cycles while allowing dangling archive data to remain repairable", () => {
    const parent = sheet("parent");
    const child = sheet("child", {
      codex: {
        ...codexOf(sheet("tmp")),
        links: [
          {
            id: "to-parent",
            relation: "contains",
            target: { coll: "journals", id: parent._id },
          },
        ],
      },
    });
    expect(
      codexDocumentError(child, undefined, [parent], () => undefined),
    ).toContain("does not exist");
    const parentWithChild = {
      ...parent,
      codex: {
        ...codexOf(parent),
        links: [
          {
            id: "to-child",
            relation: "contains" as const,
            target: { coll: "journals" as const, id: child._id },
          },
        ],
      },
    };
    const childWithParent = {
      ...child,
      codex: {
        ...codexOf(child),
        links: [
          {
            id: "to-parent",
            relation: "contains" as const,
            target: { coll: "journals" as const, id: parent._id },
          },
        ],
      },
    };
    const resolver = (ref: { coll: string; id: string }) =>
      ref.coll === "journals"
        ? ref.id === parent._id
          ? parentWithChild
          : ref.id === child._id
            ? childWithParent
            : undefined
        : undefined;
    expect(
      codexDocumentError(
        parentWithChild,
        parent,
        [parent, childWithParent],
        resolver,
      ),
    ).toContain("cycle");
    const malformed = {
      ...sheet("bad"),
      codex: {
        ...codexOf(sheet("bad")),
        links: [
          {
            id: "bad-relation",
            relation: "representsActor" as const,
            target: { coll: "scenes" as const, id: "missing" },
          },
        ],
      },
    };
    expect(
      codexDocumentError(malformed, undefined, [], () => scene("missing")),
    ).toContain("cannot target");
  });

  test("archive validation accepts bounded unknown future metadata but rejects malformed known data", () => {
    const future = {
      ...sheet("future"),
      codex: { version: 2, opaque: { preserve: true } },
    } as unknown as JournalDocument;
    expect(codexArchiveJournalError(future)).toBeNull();
    const invalid = {
      ...sheet("bad"),
      codex: { version: 1, kind: "entry", links: "not-an-array", widgets: [] },
    } as unknown as JournalDocument;
    expect(codexArchiveJournalError(invalid)).toContain("supported version");
    const tooLarge = {
      ...sheet("large"),
      codex: { version: 2, payload: "x".repeat(1_048_600) },
    } as unknown as JournalDocument;
    expect(codexArchiveJournalError(tooLarge)).toContain("too large");
  });

  test("resolves ordinary world-relative references to journals, pages, actors, and scenes", () => {
    const journal = sheet("j1");
    const actorDoc = actor("a1", 1);
    const sceneDoc = scene("s1");
    const world = {
      journals: [journal],
      actors: [actorDoc],
      scenes: [sceneDoc],
      items: [],
      users: [],
      folders: [],
      rollTables: [],
      encounterTables: [],
      playlists: [],
      macros: [],
      automations: [],
      actionReceipts: [],
      prefabs: [],
      fxInstances: [],
      cards: [],
      combats: [],
      messages: [],
      settings: [],
      compendia: [],
      factions: [],
      armies: [],
      turns: [],
      depots: [],
      routes: [],
      reinforcements: [],
      assetManifest: {},
    } as never;
    expect(resolveCodexWorldRef(world, { coll: "journals", id: "j1" })).toBe(
      journal,
    );
    expect(
      resolveCodexWorldRef(world, {
        coll: "pages",
        id: "j1-page",
        parent: { coll: "journals", id: "j1" },
      }),
    ).toBe(journal.pages[0]);
    expect(resolveCodexWorldRef(world, { coll: "actors", id: "a1" })).toBe(
      actorDoc,
    );
    expect(resolveCodexWorldRef(world, { coll: "scenes", id: "s1" })).toBe(
      sceneDoc,
    );
  });
});
