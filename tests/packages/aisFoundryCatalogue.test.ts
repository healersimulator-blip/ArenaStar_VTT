import { describe, expect, test } from "vitest";
import {
  createFoundryCatalogue,
  type CatalogueModule,
} from "../../src/packages/aisFoundryCatalogue";
import type { Json } from "../../src/core/documents";
function fixture(pack: Record<string, unknown> = {}): CatalogueModule & { resources: Record<string, string> } {
  const meta = {
    name: "feats",
    label: "Feats",
    path: "packs/feats.db",
    type: "Item",
    ...pack,
  };
  return {
    packageId: "content",
    resources: {
      "packs/feats.db": JSON.stringify({
        _id: "AbC123",
        name: "Acrobatic",
        type: "feat",
        system: { changes: [{ formula: "2" }] },
      }),
    },
    runtimeContext: {
      profile: "foundry-module",
      configuration: { packs: [meta] },
      distribution: { foundryId: "content", kind: "module", packs: [meta] },
    } as Json,
  };
}
describe("AIS shared Foundry catalogue", () => {
  test("preserves upstream IDs, types and data, with separate RPC and Foundry identities", () => {
    const [row] = createFoundryCatalogue()(fixture(), { isGM: true });
    expect(row?.collectionId).toBe("content.feats");
    expect(row?.packFile).toBe("packs/feats.db");
    expect(row?.pack.type).toBe("items");
    expect(row?.pack.entries[0]).toEqual({
      id: "AbC123",
      name: "Acrobatic",
      data: {
        name: "Acrobatic",
        type: "feat",
        system: { changes: [{ formula: "2" }] },
      },
    });
  });
  test("private and role-restricted packs are not disclosed to players, even after GM cache hydration", () => {
    const catalogue = createFoundryCatalogue();
    for (const module of [
      fixture({ private: true }),
      fixture({ ownership: { PLAYER: 0 } }),
    ]) {
      expect(catalogue(module, { isGM: true })).toHaveLength(1);
      expect(catalogue(module, { isGM: false, id: "alice" })).toEqual([]);
    }
    expect(
      catalogue(fixture({ ownership: { PLAYER: 2 } }), { isGM: false }),
    ).toHaveLength(1);
    expect(
      catalogue(fixture({ ownership: { alice: 3 } }), {
        isGM: false,
        id: "alice",
      }),
    ).toHaveLength(1);
    expect(
      catalogue(fixture({ ownership: { alice: 3 } }), {
        isGM: false,
        id: "bob",
      }),
    ).toEqual([]);
  });
  test("only declared data packs are exposed, never sibling scripts or undeclared files", () => {
    const module = fixture();
    module.resources["secret.db"] = JSON.stringify({
      _id: "secret",
      name: "Secret",
    });
    module.resources["execute.js"] = "throw new Error('never execute')";
    expect(
      createFoundryCatalogue()(module, { isGM: false })[0]?.pack.entries,
    ).toHaveLength(1);
    expect(
      createFoundryCatalogue()(
        { ...module, runtimeContext: {} },
        { isGM: true },
      ),
    ).toEqual([]);
  });
  test("split JSON and NDJSON handle duplicate IDs and deletion records without fabricating documents", () => {
    const module = fixture({ path: "packs/feats" });
    module.resources = {
      "packs/feats/a.json": JSON.stringify([
        { _id: "same", name: "Old" },
        { _id: "deleted", name: "Delete" },
      ]),
      "packs/feats/b.db": [
        { _id: "same", name: "New" },
        { _id: "deleted", $$deleted: true },
      ]
        .map((r) => JSON.stringify(r))
        .join("\n"),
    };
    expect(
      createFoundryCatalogue()(module, { isGM: true })[0]?.pack.entries.map(
        (e) => e.name,
      ),
    ).toEqual(["New"]);
  });
  test("replacement snapshots cannot reuse cached data from a previous version", () => {
    const catalogue = createFoundryCatalogue(),
      old = fixture(),
      next = fixture();
    next.resources["packs/feats.db"] = JSON.stringify({
      _id: "new",
      name: "Replacement",
    });
    expect(catalogue(old, { isGM: true })[0]?.pack.entries[0]?.name).toBe(
      "Acrobatic",
    );
    expect(catalogue(next, { isGM: true })[0]?.pack.entries[0]?.name).toBe(
      "Replacement",
    );
  });
});
