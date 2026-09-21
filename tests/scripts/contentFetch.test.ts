// G-44 (plan §1.1): the content sources are pinned data, and the fetch that materialises them is
// testable without a network. The manifest is the single source of truth (the converter's error
// message used to be the only copy of the recipe), `fetchCommands` is the recipe as pure argv
// data, and `verifyCheckout` is what decides "already there" versus "fetch/repair" — the logic
// that must not be wrong, because a wrong verdict either re-clones 262 MB or silently converts a
// stale checkout.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import {
  fetchCommands,
  readSources,
  verifyCheckout,
  GIT_ENV,
  type ContentSource,
} from "../../tools/content/fetch.mjs";

/** The first pinned source, narrowed once (the tests only need one). */
function source0(): ContentSource {
  const first = readSources()[0];
  if (!first) throw new Error("sources.json is empty");
  return first;
}

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, env: { ...process.env, ...GIT_ENV }, encoding: "utf8" }).trim();

/** A throwaway local repo — no network, real git semantics. */
function localRepo({ commits = 1, extra = null } = {}) {
  const root = mkdtempSync(join(tmpdir(), "content-fetch-"));
  const dir = join(root, "src");
  mkdirSync(join(dir, "packs", "spells"), { recursive: true });
  writeFileSync(join(dir, "packs", "spells", "fireball.yaml"), "name: Fireball\n");
  git(dir, "init", "--quiet", "-b", "main");
  git(dir, "config", "user.email", "test@example.invalid");
  git(dir, "config", "user.name", "Test");
  git(dir, "add", "-A");
  git(dir, "commit", "--quiet", "-m", "one");
  const first = git(dir, "rev-parse", "HEAD");
  let second = null;
  if (commits > 1) {
    writeFileSync(join(dir, "packs", "spells", "magic-missile.yaml"), "name: Magic Missile\n");
    if (extra) writeFileSync(join(dir, extra), "x\n");
    git(dir, "add", "-A");
    git(dir, "commit", "--quiet", "-m", "two");
    second = git(dir, "rev-parse", "HEAD");
  }
  return { root, dir, first, second, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

const tempDirs: string[] = [];
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

describe("content sources manifest (G-44)", () => {
  const sources = readSources();

  test("pins the two upstream sources by full commit, with sparse paths and licenses", () => {
    expect(sources.map((s) => s.id)).toEqual(["pf1-system", "pf1e-content"]);
    for (const s of sources) {
      expect(s.commit).toMatch(/^[0-9a-f]{40}$/);
      expect(s.url).toMatch(/^https:\/\//);
      expect(s.sparse.length).toBeGreaterThan(0);
      expect(s.license.length).toBeGreaterThan(10);
      expect(s.usage).toMatch(/data only/i);
    }
  });

  const byId = (id: string): ContentSource => {
    const found = sources.find((s) => s.id === id);
    if (!found) throw new Error(`sources.json has no ${id}`);
    return found;
  };

  test("the sparse sets are exactly what the converter reads", () => {
    // tools/convert/packs.mjs walks <vendor>/pf1-system/packs and <vendor>/pf1e-content/src/packs
    expect(byId("pf1-system").sparse).toEqual(["packs"]);
    expect(byId("pf1e-content").sparse).toEqual(["src/packs"]);
  });

  test("the pinned commits are the ones the inventory recorded (a pin change is a deliberate edit)", () => {
    expect(byId("pf1-system").commit).toBe("681929d1f5471178a99fc3285f94caa85d78e427");
    expect(byId("pf1e-content").commit).toBe("baf5232c5dc16af99d49ae1bf57ead6473b46bbb");
  });
});

describe("fetchCommands", () => {
  const source = source0();

  test("a fresh fetch is a blobless sparse clone at the pinned commit", () => {
    const dir = "/vendor/pf1-system";
    const cmds = fetchCommands(source, dir, { fresh: true });
    expect(cmds[0]).toEqual([
      "git",
      "clone",
      "--filter=blob:none",
      "--no-checkout",
      "--quiet",
      source.url,
      dir,
    ]);
    expect(cmds[1]).toEqual(["git", "-C", dir, "sparse-checkout", "init", "--cone"]);
    expect(cmds[2]).toEqual(["git", "-C", dir, "sparse-checkout", "set", ...source.sparse]);
    expect(cmds[3]).toEqual(["git", "-C", dir, "checkout", "--quiet", source.commit]);
  });

  test("a repair reuses the clone: set the sparse paths, fetch the commit, check it out", () => {
    const dir = "/vendor/pf1-system";
    const cmds = fetchCommands(source, dir, { fresh: false });
    expect(cmds).toHaveLength(4);
    expect(cmds[0]?.[3]).toBe("sparse-checkout");
    expect(cmds[2]).toEqual(["git", "-C", dir, "fetch", "--quiet", "--depth", "1", "origin", source.commit]);
    expect(cmds[3]).toEqual(["git", "-C", dir, "checkout", "--force", "--quiet", source.commit]);
    // never a prompt: a CI job must fail fast, not hang waiting for credentials
    expect(GIT_ENV.GIT_TERMINAL_PROMPT).toBe("0");
  });

  test("every command is git with the checkout as -C (no shell string is ever built)", () => {
    for (const fresh of [true, false]) {
      for (const argv of fetchCommands(source, "/vendor/pf1-system", { fresh })) {
        expect(argv[0]).toBe("git");
        expect(argv.every((a) => typeof a === "string")).toBe(true);
      }
    }
  });
});

describe("verifyCheckout", () => {
  test("an absent checkout is not ok and names every required path", () => {
    const repo = localRepo();
    tempDirs.push(repo.root);
    const source: ContentSource = { ...source0(), required: ["packs/spells", "packs/feats"] };
    const verdict = verifyCheckout(source, join(repo.root, "nothing-here"));
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toBe("not a checkout");
    expect(verdict.missing).toEqual(["packs/spells", "packs/feats"]);
  });

  test("the right commit with the required paths present is ok", () => {
    const repo = localRepo();
    tempDirs.push(repo.root);
    const source: ContentSource = { ...source0(), commit: repo.first, required: ["packs/spells"] };
    expect(verifyCheckout(source, repo.dir)).toMatchObject({ ok: true, commit: repo.first });
  });

  test("a checkout at the wrong commit is not ok, and says which commit it is at", () => {
    const repo = localRepo({ commits: 2 });
    tempDirs.push(repo.root);
    const source: ContentSource = { ...source0(), commit: repo.first, required: ["packs/spells"] };
    const verdict = verifyCheckout(source, repo.dir);
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain("want");
    expect(verdict.commit).toBe(repo.second);
  });

  test("a required directory that is empty counts as missing (a half-finished sparse checkout)", () => {
    const repo = localRepo();
    tempDirs.push(repo.root);
    mkdirSync(join(repo.dir, "packs", "feats"), { recursive: true });
    const source: ContentSource = { ...source0(), commit: repo.first, required: ["packs/spells", "packs/feats"] };
    const verdict = verifyCheckout(source, repo.dir);
    expect(verdict.ok).toBe(false);
    expect(verdict.missing).toEqual(["packs/feats"]);
  });

  test("a directory that is not a git checkout is rejected even when the paths exist", () => {
    const root = mkdtempSync(join(tmpdir(), "content-fetch-"));
    tempDirs.push(root);
    mkdirSync(join(root, "packs", "spells"), { recursive: true });
    const source: ContentSource = { ...source0(), required: ["packs/spells"] };
    expect(verifyCheckout(source, root)).toMatchObject({ ok: false, reason: "not a checkout" });
  });
});
