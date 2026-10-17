import { test } from "node:test";
import assert from "node:assert/strict";
import {
  archiveOuterRoot,
  foundryManifestPath,
  packageContentHashFromMap,
} from "./packageFixture.mjs";

test("fixture hashes are independent of insertion order and distinguish path/content boundaries", () => {
  assert.equal(
    packageContentHashFromMap({ a: "one", b: "two" }),
    packageContentHashFromMap({ b: "two", a: "one" }),
  );
  assert.notEqual(
    packageContentHashFromMap({ ab: "c" }),
    packageContentHashFromMap({ a: "bc" }),
  );
});
test("archive rooting handles root, nested release, and public/system.json layouts", () => {
  assert.equal(
    archiveOuterRoot(["module.json", "scripts/main.js"], "module.json"),
    "",
  );
  assert.equal(
    archiveOuterRoot(
      ["release/module.json", "release/scripts/main.js"],
      "release/module.json",
    ),
    "release/",
  );
  assert.equal(
    archiveOuterRoot(
      ["release/deep/public/system.json", "release/deep/module/main.js"],
      "release/deep/public/system.json",
    ),
    "release/deep/",
  );
  assert.equal(
    archiveOuterRoot(
      ["public/system.json", "module/main.js"],
      "public/system.json",
    ),
    "",
  );
});

test("manifest discovery recognizes flat and nested source archives", () => {
  assert.equal(
    foundryManifestPath(["module.json", "module/main.js"]),
    "module.json",
  );
  assert.equal(
    foundryManifestPath([
      "release/public/system.json",
      "release/node_modules/pkg/module.json",
    ]),
    "release/public/system.json",
  );
  assert.equal(foundryManifestPath(["README.md"]), null);
});
