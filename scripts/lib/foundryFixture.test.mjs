import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { transcodeYamlPacks } from "./foundryFixture.mjs";

test("YAML fixture conversion preserves complete Foundry spell data", () => {
  const result = transcodeYamlPacks({
    "packs/spells/fireball.yaml":
      "_id: fireball\nname: Fireball\nsystem:\n  actions:\n    use:\n      damage:\n        parts:\n          - formula: '(min(10, @cl))d6'\n            types: [fire]\n",
    "module/main.mjs": "export const original = true;",
  });
  assert.equal(result["module/main.mjs"], "export const original = true;");
  const spell = JSON.parse(result["packs/spells/fireball.json"]);
  assert.deepEqual(spell.system.actions.use.damage.parts, [
    { formula: "(min(10, @cl))d6", types: ["fire"] },
  ]);
  assert.equal(result["packs/spells/fireball.yaml"], undefined);
});
test("YAML fixture conversion rejects malformed, missing-ID and conflicting documents", () => {
  assert.throws(
    () => transcodeYamlPacks({ "packs/x/a.yaml": "x: [" }),
    /Invalid YAML/,
  );
  assert.throws(
    () => transcodeYamlPacks({ "packs/x/a.yaml": "name: anonymous" }),
    /no document _id/,
  );
  assert.throws(
    () =>
      transcodeYamlPacks({
        "packs/x/a.yaml": "_id: a",
        "packs/x/a.json": "{}",
      }),
    /overwrite/,
  );
});
test("all five source archives are pinned with original upstream and mirror provenance", async () => {
  const manifest = JSON.parse(
    await readFile(
      new URL("../../tools/content/foundry-fixtures.json", import.meta.url),
      "utf8",
    ),
  );
  assert.equal(manifest.sources.length, 5);
  assert.equal(new Set(manifest.sources.map((source) => source.id)).size, 5);
  for (const source of manifest.sources) {
    assert.match(source.commit, /^[a-f0-9]{40}$/);
    assert.match(source.upstream, /^https:\/\/gitlab.com\//);
    assert.match(source.archive, /^https:\/\/codeload.github.com\//);
    assert.ok(source.archive.endsWith(source.commit));
  }
});
