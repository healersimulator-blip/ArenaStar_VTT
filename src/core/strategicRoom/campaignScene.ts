import {
  OWNERSHIP_LEVELS,
  type ActorDocument,
  type DocRef,
  type SceneDocument,
  type TokenDocument,
} from "../documents";
import { actionDocHash } from "../actionRevert";
import type { Op } from "../ops";
import type { DocumentStore } from "../store";
import { sceneDifficultCells } from "../rules";
import { deriveFromDocuments, parsePF1eActorSystem } from "../../packages/pf1e/actor";
import { readTacticalEffect, type PF1eActiveEffect } from "../../packages/pf1e/effects";
import {
  PF1E_ENTANGLE_DOCUMENT_ID,
  record,
  STRATEGIC_SPELL_CATALOG,
  type HostedJournal,
  type HostedLight,
  type HostedMacro,
  type HostedPlaylist,
  type HostedRegion,
  type HostedRollTable,
  type HostedTemplate,
  type StrategicFxCoalescence,
  type StrategicItemEffect,
  type StrategicModelStats,
  type StrategicSpellId,
} from "./protocol";
import { assertBattleScene, extractScenario } from "./worldExtract";
import {
  MAX_COMMANDERS,
  MAX_UNITS,
  MAX_UNITS_PER_COMMANDER,
  parseScenario,
  scenarioProjectionDigest,
  type Scenario,
  type ScenarioContent,
  type ScenarioDependency,
  type ScenarioUnit,
  type ScenarioUnitItem,
  type ScenarioUnitSpell,
  type ScenarioUnsupportedDiagnostic,
  type ScenarioWall,
} from "./scenario";

export type BattleBinding = {
  id: string;
  scene: string;
  world: string;
  armies: string[];
  factions: string[];
  seed: number;
  seats: number;
  strength: number;
};

export function battleOf(
  scene: SceneDocument,
  world: string,
): BattleBinding | null {
  const b = scene.flags?.core?.campaignBattle;
  if (
    !record(b) ||
    b.world !== world ||
    b.scene !== scene._id ||
    typeof b.id !== "string" ||
    !/^[0-9a-f-]{36}$/.test(b.id) ||
    !Array.isArray(b.armies) ||
    !Array.isArray(b.factions)
  )
    return null;
  return b as BattleBinding;
}

export function sourceArmies(store: DocumentStore, scene: string) {
  return store
    .getAll("armies")
    .filter((a) => a.units.some((u) => u.sceneId === scene));
}

/** Visible, explicitly sided scene tokens can seed a constrained hosted deployment. */
export function sourceStrategicTokens(scene: SceneDocument) {
  return scene.tokens.filter(
    (token) => !token.hidden && token.disposition !== "neutral",
  );
}

const SPELL_NAME_TO_ID: Readonly<Record<string, StrategicSpellId>> = Object.freeze({
  entangle: "entangle",
  "burning entanglement": "burning-entanglement",
  "burning-entanglement": "burning-entanglement",
  "black tentacles": "black-tentacles",
  "black-tentacles": "black-tentacles",
  fireball: "fireball",
  "burning hands": "burning-hands",
  "burning-hands": "burning-hands",
  "lightning bolt": "lightning-bolt",
  "lightning-bolt": "lightning-bolt",
  "cone of cold": "cone-of-cold",
  "cone-of-cold": "cone-of-cold",
});

function parseDamageDice(formula: string | null | undefined): { count: number; sides: number } | null {
  if (!formula) return null;
  const m = /^\s*(\d+)\s*d\s*(\d+)/i.exec(formula);
  if (!m) return null;
  const count = Number(m[1]);
  const sides = Number(m[2]);
  if (!Number.isInteger(count) || count < 1 || count > 20 || !Number.isInteger(sides) || sides < 2 || sides > 100)
    return null;
  return { count, sides };
}

function classifyProjectedItem(
  item: ActorDocument["items"][number],
): { effect: StrategicItemEffect; charges: number; potency: number } | null {
  const sys = record(item.system) ? item.system : {};
  const pf1e = record(sys.pf1e) ? sys.pf1e : sys;
  const qty =
    typeof pf1e.charges === "number" && Number.isInteger(pf1e.charges) && pf1e.charges > 0
      ? Math.min(200, pf1e.charges)
      : typeof pf1e.quantity === "number" && Number.isInteger(pf1e.quantity) && pf1e.quantity > 0
        ? Math.min(200, pf1e.quantity)
        : 1;
  const lower = item.name.trim().toLowerCase();
  const explicitEffect = typeof pf1e.strategicEffect === "string" ? pf1e.strategicEffect : "";
  if (
    explicitEffect === "heal" ||
    /\b(cure|heal|channel|restoration|aid)\b/.test(lower)
  ) {
    const potency =
      lower.includes("critical")
        ? 22
        : lower.includes("serious")
          ? 16
          : lower.includes("moderate")
            ? 11
            : 6;
    return { effect: "heal", charges: qty, potency };
  }
  if (explicitEffect === "bless" || /\b(bless|prayer|inspire|banner)\b/.test(lower)) {
    return { effect: "bless", charges: qty, potency: 1 };
  }
  if (explicitEffect === "haste" || /\b(haste|expeditious|fleet)\b/.test(lower)) {
    return { effect: "haste", charges: qty, potency: 2 };
  }
  if (explicitEffect === "shield" || /\b(shield of faith|barkskin|protection)\b/.test(lower)) {
    return { effect: "shield", charges: qty, potency: 2 };
  }
  return null;
}

function projectActorIntoUnit(
  unit: ScenarioUnit,
  token: TokenDocument | undefined,
  actor: ActorDocument | undefined,
  leaderActorsOut: Record<string, Record<string, unknown>>,
): ScenarioUnit {
  let next: ScenarioUnit = { ...unit };
  const badge = token?.img && /^[0-9a-f]{64}$/.test(token.img) ? token.img : unit.badge;
  if (badge) next = { ...next, badge };

  if (token?.darkvision && Number.isInteger(token.darkvision) && token.darkvision >= 5) {
    next = {
      ...next,
      vision: { mode: "darkvision", rangeFt: Math.min(500, token.darkvision) },
    };
  }

  if (!actor) return next;
  const parsed = parsePF1eActorSystem(actor.system?.pf1e);
  if (!parsed.ok) return next;

  const activeEffects: PF1eActiveEffect[] = [];
  for (const eff of actor.effects ?? []) {
    const read = readTacticalEffect(eff._id, eff);
    if (read.ok) activeEffects.push(read.value);
  }
  const derived = deriveFromDocuments({
    actor: { system: actor.system },
    effects: activeEffects,
    items: actor.items,
  });

  if (actor.system && Object.keys(actor.system).length > 0) {
    const encoded = JSON.stringify({ system: actor.system });
    if (encoded.length <= 16_384) {
      leaderActorsOut[unit.id] = { system: JSON.parse(JSON.stringify(actor.system)) as Record<string, unknown> };
    }
  }

  const primaryAttack =
    derived.attacks.find((atk) => (unit.weapon === "shot" ? atk.ranged : !atk.ranged)) ??
    derived.attacks[0];
  const dice = parseDamageDice(primaryAttack?.damageDice);
  const hpVal = Math.max(1, Math.min(500, Math.round(parsed.value.hpMax ?? parsed.value.hp ?? 10)));
  const stats: Record<string, number> = {
    ...(unit.stats ?? {}),
    bab: derived.baseAttack,
    strMod: derived.abilityMods.str,
    dexMod: derived.abilityMods.dex,
    conMod: derived.abilityMods.con,
    sizeMod: derived.sizeEntry.attackAc,
    specialSizeMod: derived.sizeEntry.cmbCmd,
    ac: derived.ac.normal,
    touchAc: derived.ac.touch,
    flatFootedAc: derived.ac.flatFooted,
    fort: derived.saves.fort,
    ref: derived.saves.ref,
    will: derived.saves.will,
    cmb: derived.cmb,
    cmd: derived.cmd,
    hp: hpVal,
    maxAoos: Math.max(0, Math.min(10, derived.aooPerRound)),
    ...(parsed.value.spellResistance ? { sr: Math.max(0, Math.min(100, parsed.value.spellResistance)) } : {}),
    ...(parsed.value.dr ? { drVal: Math.max(0, Math.min(50, parsed.value.dr)) } : {}),
    ...(dice
      ? {
          weaponDamageDiceCount: dice.count,
          weaponDamageDiceSides: dice.sides,
          weaponDamageMod: primaryAttack?.damageBonus ?? derived.abilityMods.str,
          weaponCritMin: primaryAttack?.critThreatMin ?? 20,
          weaponCritMult: primaryAttack?.critMultiplier ?? 2,
        }
      : {}),
    ...(unit.weapon === "shot" || primaryAttack?.ranged
      ? {
          weaponIsRanged: 1,
          weaponRangeIncrement: 60,
          weaponMaxIncrements: 10,
          ...((parsed.value.feats ?? []).some((f) => /precise\s+shot/i.test(f))
            ? { preciseShot: 1 }
            : {}),
        }
      : primaryAttack && primaryAttack.reachSquares > derived.sizeEntry.reachSquares
        ? { weaponReachFt: primaryAttack.reachSquares * 5 }
        : {}),
  };

  // Vision traits from actor if not already darkvision from token
  const traits = (parsed.value.traits ?? []).map((t) => t.toLowerCase());
  let vision = next.vision;
  if (!vision) {
    if (traits.some((t) => t.includes("darkvision"))) {
      vision = { mode: "darkvision", rangeFt: 60 };
    } else if (traits.some((t) => t.includes("low-light"))) {
      vision = { mode: "lowLight" };
    }
  }

  // Conditions from actor sheet
  const conditionSet = new Set<string>();
  for (const c of parsed.value.conditions ?? []) {
    if (typeof c === "string" && c.trim().length > 0 && c.length <= 64) conditionSet.add(c.trim());
  }
  if (parsed.value.conditionApplications) {
    for (const app of Object.values(parsed.value.conditionApplications)) {
      if (app?.condition && app.condition.length <= 64) conditionSet.add(app.condition);
    }
  }
  const conditions = [...conditionSet].slice(0, 16);

  // Generalized PF1e spell projection across all 7 automated strategic spells
  const spellsBlock = parsed.value.spells;
  const projectedSpells: ScenarioUnitSpell[] = [];
  let legacyEntangle: ScenarioUnit["spellcasting"];
  if (spellsBlock) {
    const casterLevel = Math.max(1, (spellsBlock.casterLevel ?? 0) + (spellsBlock.casterLevelBonus ?? 0));
    const key = spellsBlock.keyAbility;
    const score = key ? derived.abilities[key] : undefined;
    const castingAbilityMod = typeof score === "number" ? Math.floor((score - 10) / 2) : 0;
    const spellPenetration = (parsed.value.feats ?? []).some((f) =>
      f.toLowerCase().includes("greater spell penetration"),
    )
      ? 4
      : (parsed.value.feats ?? []).some((f) => f.toLowerCase().includes("spell penetration"))
        ? 2
        : 0;

    if (spellsBlock.mode === "spontaneous") {
      const seenSpells = new Set<StrategicSpellId>();
      for (const entry of spellsBlock.known ?? []) {
        const spellId = SPELL_NAME_TO_ID[entry.name.trim().toLowerCase()];
        if (!spellId || seenSpells.has(spellId)) continue;
        const catalog = STRATEGIC_SPELL_CATALOG[spellId];
        const lvl = entry.level ?? catalog.level;
        const avail = Math.max(
          0,
          (spellsBlock.slotsPerDay?.[lvl] ?? 0) - (spellsBlock.slotsUsed?.[lvl] ?? 0),
        );
        if (avail < 1) continue;
        seenSpells.add(spellId);
        projectedSpells.push({
          id: spellId,
          itemId: catalog.itemId,
          actorId: actor._id,
          casterLevel,
          castingAbilityMod,
          ...(spellPenetration > 0 ? { spellPenetration } : {}),
          slots: avail,
        });
      }
    } else {
      const counts = new Map<StrategicSpellId, number>();
      for (const entry of spellsBlock.prepared ?? []) {
        if (entry.expended) continue;
        const spellId = SPELL_NAME_TO_ID[entry.name.trim().toLowerCase()];
        if (!spellId) continue;
        counts.set(spellId, (counts.get(spellId) ?? 0) + 1);
      }
      for (const [spellId, slots] of counts) {
        const catalog = STRATEGIC_SPELL_CATALOG[spellId];
        projectedSpells.push({
          id: spellId,
          itemId: catalog.itemId,
          actorId: actor._id,
          casterLevel,
          castingAbilityMod,
          ...(spellPenetration > 0 ? { spellPenetration } : {}),
          slots,
        });
      }
    }

    const entangleEntry = projectedSpells.find((s) => s.id === "entangle");
    if (entangleEntry) {
      legacyEntangle = {
        actorId: actor._id,
        itemId: PF1E_ENTANGLE_DOCUMENT_ID,
        casterLevel: entangleEntry.casterLevel,
        castingAbilityMod: entangleEntry.castingAbilityMod,
        entangleSlots: entangleEntry.slots,
      };
      stats.casterLevel = entangleEntry.casterLevel;
      stats.castingAbilityMod = entangleEntry.castingAbilityMod;
      stats.entangleSlots = entangleEntry.slots;
    } else if (projectedSpells[0]) {
      stats.casterLevel = projectedSpells[0].casterLevel;
      stats.castingStatMod = projectedSpells[0].castingAbilityMod;
    }
  }

  // Projected consumables / wands / scrolls from actor.items
  const projectedItems: ScenarioUnitItem[] = [];
  for (const item of actor.items ?? []) {
    if (projectedItems.length >= 16) break;
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(item._id) || !item.name.trim()) continue;
    const classified = classifyProjectedItem(item);
    if (!classified) continue;
    projectedItems.push({
      id: item._id,
      name: item.name.trim().slice(0, 64),
      actorId: actor._id,
      effect: classified.effect,
      charges: classified.charges,
      potency: classified.potency,
    });
  }

  return {
    ...next,
    weapon: stats.weaponIsRanged ? "shot" : unit.weapon,
    stats,
    ...(vision ? { vision } : {}),
    ...(projectedSpells.length ? { spells: projectedSpells } : {}),
    ...(projectedItems.length ? { items: projectedItems } : {}),
    ...(conditions.length ? { conditions } : {}),
    ...(legacyEntangle ? { spellcasting: legacyEntangle } : {}),
  };
}

/** Project authored geometry, doors, lighting, regions, and templates into battlefield feet. */
function sceneRulesProjection(scene: SceneDocument) {
  const feet = 5 / scene.grid.size;
  const walls: ScenarioWall[] = scene.walls.map((wall) => {
    const isWindow =
      wall.sight === 2 && wall.move === 0 && wall.sound === 0 && wall.light === 2;
    const isD257SolidWall =
      wall.move === 0 &&
      wall.sight === 0 &&
      wall.sound === 0 &&
      wall.light === 0 &&
      wall.door === 0;
    const isInteractiveDoor =
      (wall.move === 1 && wall.sight === 1 && wall.sound === 1 && wall.light === 1) ||
      wall.door !== 0 ||
      (record(wall.flags?.core) && wall.flags.core.door === true);

    let restriction: number;
    let openRestriction = 0;
    if (isWindow) {
      restriction = 1 | 4; // blocks move & sound; sight & light pass
    } else if (isD257SolidWall) {
      restriction = 1 | 2 | 4 | 8;
    } else if (isInteractiveDoor) {
      restriction =
        (wall.move !== 2 ? 1 : 0) |
        (wall.sight !== 2 ? 2 : 0) |
        (wall.sound !== 2 ? 4 : 0) |
        (wall.light !== 2 ? 8 : 0);
      openRestriction =
        (wall.move === 0 ? 1 : 0) |
        (wall.sight === 0 ? 2 : 0) |
        (wall.sound === 0 ? 4 : 0) |
        (wall.light === 0 ? 8 : 0);
    } else {
      // Legacy TurnChannel convention: >0 blocks that axis
      restriction =
        (wall.move > 0 ? 1 : 0) |
        (wall.sight > 0 ? 2 : 0) |
        (wall.sound > 0 ? 4 : 0) |
        (wall.light > 0 ? 8 : 0);
    }

    return {
      ...(isInteractiveDoor &&
      typeof wall._id === "string" &&
      /^[A-Za-z0-9_-]{1,64}$/.test(wall._id)
        ? { id: wall._id }
        : {}),
      x1: wall.c[0] * feet,
      y1: wall.c[1] * feet,
      x2: wall.c[2] * feet,
      y2: wall.c[3] * feet,
      restriction,
      ...(isInteractiveDoor
        ? {
            openRestriction,
            door: wall.door,
          }
        : {}),
    };
  });

  const lights: HostedLight[] = (scene.lights ?? []).slice(0, 500).flatMap((l) => {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(l._id)) return [];
    const color = /^#[0-9a-f]{6}$/i.test(l.color) ? l.color : "#ffd27d";
    const hidden = record(l.flags?.core) && l.flags.core.hidden === true;
    return [
      {
        id: l._id,
        x: Math.round(l.x * feet * 100) / 100,
        y: Math.round(l.y * feet * 100) / 100,
        dim: Math.max(0, Math.round(l.dim * 100) / 100),
        bright: Math.max(0, Math.round(l.bright * 100) / 100),
        color,
        alpha: Math.max(0, Math.min(1, Number.isFinite(l.alpha) ? l.alpha : 0.5)),
        ...(hidden ? { hidden: true } : {}),
      },
    ];
  });
  const darkness = Math.max(0, Math.min(1, Number.isFinite(scene.darkness) ? scene.darkness : 0));
  const lighting = darkness > 0 || lights.length > 0 ? { darkness, lights } : undefined;

  const regions: HostedRegion[] = (scene.regions ?? []).slice(0, 500).flatMap((reg): HostedRegion[] => {
    if (reg.hidden || !/^[A-Za-z0-9_-]{1,64}$/.test(reg._id)) return [];
    if (reg.raised && Number.isFinite(reg.raised.height) && reg.raised.height !== 0) {
      return [
        {
          id: reg._id,
          ...(reg.name.trim() ? { name: reg.name.trim().slice(0, 64) } : {}),
          x: Math.round(reg.x * feet * 100) / 100,
          y: Math.round(reg.y * feet * 100) / 100,
          width: Math.max(5, Math.round(reg.width * feet * 100) / 100),
          height: Math.max(5, Math.round(reg.height * feet * 100) / 100),
          elevationFt: Math.round(reg.raised.height * 100) / 100,
          kind: "raised" as const,
        },
      ];
    }
    if (reg.stairs) {
      return [
        {
          id: reg._id,
          ...(reg.name.trim() ? { name: reg.name.trim().slice(0, 64) } : {}),
          x: Math.round(reg.x * feet * 100) / 100,
          y: Math.round(reg.y * feet * 100) / 100,
          width: Math.max(5, Math.round(reg.width * feet * 100) / 100),
          height: Math.max(5, Math.round(reg.height * feet * 100) / 100),
          elevationFt: 10,
          kind: "stairs" as const,
        },
      ];
    }
    return [];
  });

  const templates: HostedTemplate[] = (scene.templates ?? []).slice(0, 256).flatMap((tpl) => {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(tpl._id) || !Number.isFinite(tpl.distance) || tpl.distance <= 0)
      return [];
    const shape = tpl.kind === "ray" ? "line" : tpl.kind;
    const rawColor = record(tpl.flags?.core) && typeof tpl.flags.core.color === "string" ? tpl.flags.core.color : "";
    const color = /^#[0-9a-f]{6}$/i.test(rawColor) ? rawColor : "#63d2c6";
    return [
      {
        id: tpl._id,
        shape,
        x: Math.round(tpl.x * feet * 100) / 100,
        y: Math.round(tpl.y * feet * 100) / 100,
        distance: Math.min(1000, Math.round(tpl.distance * 100) / 100),
        ...(Number.isFinite(tpl.direction) ? { direction: Math.round(tpl.direction * 100) / 100 } : {}),
        ...(Number.isFinite(tpl.width) && tpl.width > 0 ? { width: Math.min(200, Math.round(tpl.width * 100) / 100) } : {}),
        color,
        ...(tpl.name.trim() ? { label: tpl.name.trim().slice(0, 64) } : {}),
      },
    ];
  });

  const terrain = sceneDifficultCells(scene);
  return {
    ...(walls.length ? { walls } : {}),
    ...(lighting ? { lighting } : {}),
    ...(regions.length ? { regions } : {}),
    ...(templates.length ? { templates } : {}),
    ...(terrain ? { terrain } : {}),
  };
}

function stripSecretBlocks(markdown: string): string {
  return markdown.replace(/<secret\b[^>]*>[\s\S]*?<\/secret>/gi, "").trim();
}

function projectCampaignContent(
  store: DocumentStore,
  depsOut: ScenarioDependency[],
  unsupportedOut: ScenarioUnsupportedDiagnostic[],
): ScenarioContent | undefined {
  const journals: HostedJournal[] = [];
  for (const j of store.getAll("journals").slice(0, 64)) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(j._id) || !j.name.trim()) continue;
    const isPublic = (j.ownership?.default ?? 0) >= OWNERSHIP_LEVELS.OBSERVER;
    const visibility = isPublic ? ("public" as const) : ("gm" as const);
    const rawText = (j.pages ?? [])
      .map((p) => (isPublic ? stripSecretBlocks(p.text ?? "") : (p.text ?? "")))
      .filter((s) => s.length > 0)
      .join("\n\n")
      .slice(0, 16_384);
    journals.push({
      id: j._id,
      name: j.name.trim().slice(0, 64),
      markdown: rawText,
      visibility,
    });
    const digest = actionDocHash(j);
    if (digest) depsOut.push({ coll: "journals", id: j._id, digest, visibility });
  }

  const rollTables: HostedRollTable[] = [];
  for (const t of store.getAll("rollTables").slice(0, 32)) {
    if (
      !/^[A-Za-z0-9_-]{1,64}$/.test(t._id) ||
      !t.name.trim() ||
      !/^[0-9dD+\-\s]{1,32}$/.test(t.formula ?? "") ||
      !(t.results ?? []).length
    )
      continue;
    const isPublic = (t.ownership?.default ?? 0) >= OWNERSHIP_LEVELS.OBSERVER;
    const visibility = isPublic ? ("public" as const) : ("gm" as const);
    const results = t.results.slice(0, 100).flatMap((r) => {
      if (
        !Array.isArray(r.range) ||
        r.range.length !== 2 ||
        !Number.isInteger(r.range[0]) ||
        !Number.isInteger(r.range[1]) ||
        r.range[0] < 1 ||
        r.range[1] < r.range[0]
      )
        return [];
      return [{ range: [r.range[0], r.range[1]] as [number, number], text: (r.text ?? "").slice(0, 240) }];
    });
    if (!results.length) continue;
    rollTables.push({
      id: t._id,
      name: t.name.trim().slice(0, 64),
      formula: t.formula.trim(),
      results,
      visibility,
    });
    const digest = actionDocHash(t);
    if (digest) depsOut.push({ coll: "rollTables", id: t._id, digest, visibility });
  }

  const playlists: HostedPlaylist[] = [];
  for (const p of store.getAll("playlists").slice(0, 16)) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(p._id) || !p.name.trim()) continue;
    const tracks = (p.sounds ?? []).slice(0, 32).flatMap((s) => {
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(s._id) || !s.name.trim()) return [];
      return [{ id: s._id, name: s.name.trim().slice(0, 64), loop: Boolean(s.loop) }];
    });
    playlists.push({ id: p._id, name: p.name.trim().slice(0, 64), tracks });
    const digest = actionDocHash(p);
    if (digest) depsOut.push({ coll: "playlists", id: p._id, digest, visibility: "public" });
  }

  const macros: HostedMacro[] = [];
  for (const m of store.getAll("macros").slice(0, 32)) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(m._id) || !m.name.trim()) continue;
    if (m.kind === "chat") {
      const cmd = (m.command ?? "").trim();
      const orderMatch = /^\/order\s+(hold|defend|reform)\s*$/i.exec(cmd);
      const rollMatch = /^\/r(?:oll)?\s+([0-9dD+\-\s]{1,32})(?:\s+(.*))?$/i.exec(cmd);
      if (orderMatch && orderMatch[1]) {
        macros.push({
          id: m._id,
          name: m.name.trim().slice(0, 64),
          executable: true,
          action: { kind: "order", orderKind: orderMatch[1].toLowerCase() as "hold" | "defend" | "reform" },
        });
      } else if (rollMatch && rollMatch[1]) {
        macros.push({
          id: m._id,
          name: m.name.trim().slice(0, 64),
          executable: true,
          action: {
            kind: "chat",
            text: (rollMatch[2] ?? m.name).trim().slice(0, 240),
            rollFormula: rollMatch[1].trim(),
          },
        });
      } else {
        macros.push({
          id: m._id,
          name: m.name.trim().slice(0, 64),
          executable: true,
          action: { kind: "chat", text: (cmd || m.name).slice(0, 240) },
        });
      }
    } else if (m.kind !== "fxPreset" && m.kind !== "sequence") {
      const reason =
        m.kind === "script"
          ? "Executable script macros require sandbox policy; use declarative chat or order macros in hosted strategic play."
          : `${m.kind} macros require host-local execution and are disabled in hosted strategic play.`;
      macros.push({
        id: m._id,
        name: m.name.trim().slice(0, 64),
        executable: false,
        disabledReason: reason,
      });
      unsupportedOut.push({
        feature: `macro.${m.kind}`,
        docId: m._id,
        reason,
      });
    }
    const digest = actionDocHash(m);
    if (digest) depsOut.push({ coll: "macros", id: m._id, digest, visibility: "public" });
  }

  if (!journals.length && !rollTables.length && !playlists.length && !macros.length) return undefined;
  return {
    ...(journals.length ? { journals } : {}),
    ...(rollTables.length ? { rollTables } : {}),
    ...(playlists.length ? { playlists } : {}),
    ...(macros.length ? { macros } : {}),
  };
}

function readStoredModelStats(
  raw: unknown,
  maxCount: number,
): StrategicModelStats[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const out: StrategicModelStats[] = [];
  for (const item of raw.slice(0, Math.min(120, Math.max(0, maxCount)))) {
    if (
      !record(item) ||
      typeof item.kills !== "number" ||
      !Number.isInteger(item.kills) ||
      item.kills < 0 ||
      typeof item.damageDealt !== "number" ||
      !Number.isInteger(item.damageDealt) ||
      item.damageDealt < 0
    ) {
      out.push({ kills: 0, damageDealt: 0 });
      continue;
    }
    const num = (v: unknown) =>
      typeof v === "number" && Number.isInteger(v) && v > 0 ? v : undefined;
    const damageTaken = num(item.damageTaken);
    const damageReduced = num(item.damageReduced);
    const healed = num(item.healed);
    const hits = num(item.hits);
    const misses = num(item.misses);
    const crits = num(item.crits);
    out.push({
      kills: Math.min(1_000_000, item.kills),
      damageDealt: Math.min(100_000_000, item.damageDealt),
      ...(damageTaken !== undefined ? { damageTaken: Math.min(100_000_000, damageTaken) } : {}),
      ...(damageReduced !== undefined
        ? { damageReduced: Math.min(100_000_000, damageReduced) }
        : {}),
      ...(healed !== undefined ? { healed: Math.min(100_000_000, healed) } : {}),
      ...(hits !== undefined ? { hits: Math.min(10_000_000, hits) } : {}),
      ...(misses !== undefined ? { misses: Math.min(10_000_000, misses) } : {}),
      ...(crits !== undefined ? { crits: Math.min(10_000_000, crits) } : {}),
    });
  }
  return out.length > 0 ? out : undefined;
}

export function strategicModelStatsEnabled(scene: SceneDocument): boolean {
  return Boolean(record(scene.flags?.core) && scene.flags.core.strategicModelStats === true);
}

export function strategicFxCoalescenceOf(scene: SceneDocument): StrategicFxCoalescence {
  const raw = record(scene.flags?.core) ? scene.flags.core.strategicFxCoalescence : undefined;
  return raw === "none" || raw === "low" || raw === "balanced" || raw === "high"
    ? raw
    : "extreme";
}

function projectArmyActorsAndProvenance(
  store: DocumentStore,
  scene: SceneDocument,
  scenario: Scenario,
  leaderActorsOut: Record<string, Record<string, unknown>>,
  actorIdsOut: Set<string>,
): Scenario {
  const trackModelStats = strategicModelStatsEnabled(scene);
  const armies = sourceArmies(store, scene._id);
  const byUnit = new Map(
    armies.flatMap((army) =>
      army.units.map((unit) => [unit._id, { army, unit }] as const),
    ),
  );
  const commanders = scenario.commanders.map((commander) => ({
    ...commander,
    units: commander.units.map((unit) => {
      const found = byUnit.get(unit.id);
      const sourceUnit = found?.unit;
      const token = sourceUnit?.leaderTokenId
        ? scene.tokens.find((candidate) => candidate._id === sourceUnit.leaderTokenId)
        : undefined;
      const actor = token?.actorId ? store.get("actors", token.actorId) : undefined;
      if (actor) actorIdsOut.add(actor._id);
      const storedModelStats = trackModelStats
        ? readStoredModelStats(
            sourceUnit?.profile.modelStats ??
              (record(token?.flags?.core) ? token.flags.core.strategicModelStats : undefined),
            unit.strength,
          )
        : undefined;
      const unitWithProv: ScenarioUnit = {
        ...unit,
        ...(sourceUnit && ["infantry", "cavalry", "artillery", "hero"].includes(sourceUnit.type)
          ? { unitType: sourceUnit.type as NonNullable<ScenarioUnit["unitType"]> }
          : {}),
        ...(storedModelStats ? { modelStats: storedModelStats } : {}),
        ...(found
          ? {
              source: {
                kind: "armyUnit",
                armyId: found.army._id,
                unitId: found.unit._id,
                ...(token ? { tokenId: token._id } : {}),
                ...(actor ? { actorId: actor._id } : {}),
              },
            }
          : {}),
      };
      return projectActorIntoUnit(unitWithProv, token, actor, leaderActorsOut);
    }),
  }));
  return { ...scenario, commanders };
}

export function normalizedSceneForLaunchCheck(scene: SceneDocument): SceneDocument {
  const core = record(scene.flags?.core) ? { ...scene.flags.core } : {};
  delete core.campaignBattle;
  delete core.strategicActionCards;
  delete core.strategicModelStats;
  delete core.strategicFxCoalescence;
  delete core.lastHostedBattle;
  const next: SceneDocument = {
    ...scene,
    active: false,
    flags: {
      ...scene.flags,
      ...(Object.keys(core).length ? { core } : {}),
    },
  };
  return next;
}

export function strategicActionCardPolicy(scene: SceneDocument) {
  const configured = scene.flags?.core?.strategicActionCards;
  if (
    record(configured) &&
    typeof configured.playerCharacters === "boolean" &&
    typeof configured.units === "boolean" &&
    typeof configured.models === "boolean"
  )
    return {
      playerCharacters: configured.playerCharacters,
      units: configured.units,
      models: configured.models,
    };
  // Safe scale default: hero/unit events may publish; never emit one card per model unless opted in.
  return { playerCharacters: true, units: true, models: false };
}

function refreshManifest(scenario: Scenario, projection: Scenario["projection"]): Scenario {
  if (!projection) return scenario;
  const rest = { ...scenario };
  delete rest.projection;
  return parseScenario({
    ...rest,
    projection: {
      ...projection,
      digest: scenarioProjectionDigest(rest),
    },
  });
}

/** Attach validated background art and refresh `projection.digest` so launch validation agrees. */
export function withScenarioBackground(
  scenario: Scenario,
  background: NonNullable<Scenario["background"]>,
): Scenario {
  const { projection, ...rest } = scenario;
  const withArt = parseScenario({ ...rest, background });
  return refreshManifest(withArt, projection);
}

/** Attach validated unit token badge art and refresh `projection.digest`. */
export function withScenarioBadges(
  scenario: Scenario,
  badges: NonNullable<Scenario["badges"]>,
): Scenario {
  if (!Object.keys(badges).length) return scenario;
  const { projection, ...rest } = scenario;
  const withArt = parseScenario({ ...rest, badges });
  return refreshManifest(withArt, projection);
}

/** Attach validated stitched background tiles & assets and refresh `projection.digest`. */
export function withScenarioBackgroundTiles(
  scenario: Scenario,
  backgroundTiles: NonNullable<Scenario["backgroundTiles"]>,
  backgroundAssets: NonNullable<Scenario["backgroundAssets"]>,
): Scenario {
  if (!backgroundTiles.length || !Object.keys(backgroundAssets).length) return scenario;
  const { projection, ...rest } = scenario;
  const withArt = parseScenario({ ...rest, backgroundTiles, backgroundAssets });
  return refreshManifest(withArt, projection);
}

/** Send a validated battle projection, never the unrelated campaign graph or executable scripts. */
export function sceneDeployment(
  store: DocumentStore,
  scene: SceneDocument,
  seed: number,
  seats: number,
  strength = 1,
) {
  assertBattleScene(scene);
  const armies = sourceArmies(store, scene._id);
  const bounds = {
    minX: 0,
    minY: 0,
    maxX: (scene.width / scene.grid.size) * 5,
    maxY: (scene.height / scene.grid.size) * 5,
  };
  const docs = [
    { coll: "scenes", id: scene._id, doc: scene },
    ...store
      .getAll("factions")
      .map((doc) => ({ coll: "factions", id: doc._id, doc })),
    ...armies.map((doc) => ({ coll: "armies", id: doc._id, doc })),
  ];
  const layout = { sceneId: scene._id, name: scene.name, bounds, seed };
  const rulesProjection = sceneRulesProjection(scene);
  const leaderActors: Record<string, Record<string, unknown>> = {};
  const referencedActorIds = new Set<string>();
  const contentDeps: ScenarioDependency[] = [];
  const unsupported: ScenarioUnsupportedDiagnostic[] = [];
  const content = projectCampaignContent(store, contentDeps, unsupported);

  const buildDependencies = (): ScenarioDependency[] => {
    const deps: ScenarioDependency[] = [];
    const sceneDigest = actionDocHash(normalizedSceneForLaunchCheck(scene));
    if (sceneDigest) deps.push({ coll: "scenes", id: scene._id, digest: sceneDigest, visibility: "public" });
    for (const f of store.getAll("factions")) {
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(f._id)) continue;
      const d = actionDocHash(f);
      if (d) deps.push({ coll: "factions", id: f._id, digest: d, visibility: "public" });
    }
    for (const a of armies) {
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(a._id)) continue;
      const d = actionDocHash(a);
      if (d) deps.push({ coll: "armies", id: a._id, digest: d, visibility: "faction" });
    }
    for (const actorId of [...referencedActorIds].sort()) {
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(actorId)) continue;
      const actor = store.get("actors", actorId);
      const d = actionDocHash(actor);
      if (d) deps.push({ coll: "actors", id: actorId, digest: d, visibility: "owner" });
    }
    deps.push(...contentDeps);
    return deps.slice(0, 2_000);
  };

  const projected = (input: unknown): Scenario => {
    const fxCoalescence = strategicFxCoalescenceOf(scene);
    const payload = parseScenario({
      ...(input as object),
      ...(Object.keys(leaderActors).length ? { leaderActors } : {}),
      ...(content ? { content } : {}),
      actionCards: strategicActionCardPolicy(scene),
      ...(strategicModelStatsEnabled(scene) ? { trackModelStats: true } : {}),
      ...(fxCoalescence !== "extreme" ? { fxCoalescence } : {}),
    });
    const digest = scenarioProjectionDigest(payload);
    const dependencies = buildDependencies();
    return parseScenario({
      ...payload,
      projection: {
        format: "arenastar-battle-projection-v1",
        worldId: store.meta.worldId,
        sceneId: scene._id,
        sourceSeq: store.seq,
        systemId: store.meta.system,
        systemVersion: store.meta.systemVersion,
        digest,
        ...(dependencies.length ? { dependencies } : {}),
        ...(unsupported.length ? { unsupported } : {}),
      },
    });
  };

  if (armies.length) {
    const extracted = extractScenario(
      { docs },
      {
        ...layout,
        slots: Object.fromEntries(
          armies.map((a, i) => [`commander-${i + 1}`, a._id]),
        ),
      },
    );
    return projected(
      projectArmyActorsAndProvenance(
        store,
        scene,
        parseScenario({ ...extracted, ...rulesProjection }),
        leaderActors,
        referencedActorIds,
      ),
    );
  }
  if (!Number.isInteger(strength) || strength < 1 || strength > 120)
    throw new Error("Choose 1–120 models per unit.");
  const tokens = sourceStrategicTokens(scene);
  if (tokens.length) {
    if (tokens.length < 2 || tokens.length > MAX_UNITS)
      throw new Error(`Use 2–${MAX_UNITS} visible friendly/hostile tokens for a hosted deployment.`);
    const sides = new Set(tokens.map((token) => token.disposition));
    if (!sides.has("friendly") || !sides.has("hostile"))
      throw new Error("Token deployment needs at least one friendly and one hostile token.");
    const teamFlags = record(scene.flags?.core?.strategicTeams)
      ? scene.flags.core.strategicTeams
      : undefined;
    const friendlyName =
      typeof teamFlags?.friendlyName === "string" &&
      teamFlags.friendlyName.trim().length > 0 &&
      teamFlags.friendlyName.trim().length <= 64
        ? teamFlags.friendlyName.trim()
        : "Friendly";
    const hostileName =
      typeof teamFlags?.hostileName === "string" &&
      teamFlags.hostileName.trim().length > 0 &&
      teamFlags.hostileName.trim().length <= 64
        ? teamFlags.hostileName.trim()
        : "Hostile";
    const friendlyColor =
      typeof teamFlags?.friendlyColor === "string" && /^#[0-9a-f]{6}$/i.test(teamFlags.friendlyColor)
        ? teamFlags.friendlyColor
        : "#72bbff";
    const hostileColor =
      typeof teamFlags?.hostileColor === "string" && /^#[0-9a-f]{6}$/i.test(teamFlags.hostileColor)
        ? teamFlags.hostileColor
        : "#ff887e";
    const factions = [
      { id: "friendly", name: friendlyName, color: friendlyColor },
      { id: "hostile", name: hostileName, color: hostileColor },
    ];
    const maxSeats = Math.min(MAX_COMMANDERS, tokens.length);
    if (!Number.isInteger(seats) || seats < 2 || seats > maxSeats)
      throw new Error(`Choose 2–${maxSeats} commander seats for this token deployment.`);
    const friendlyCount = tokens.reduce((n, token) => n + (token.disposition === "friendly" ? 1 : 0), 0);
    const hostileCount = tokens.length - friendlyCount;
    const minFriendlySeats = Math.max(1, Math.ceil(friendlyCount / MAX_UNITS_PER_COMMANDER));
    const minHostileSeats = Math.max(1, Math.ceil(hostileCount / MAX_UNITS_PER_COMMANDER));
    if (minFriendlySeats + minHostileSeats > seats) {
      throw new Error(
        `Increase commander seats to at least ${minFriendlySeats + minHostileSeats} (max ${MAX_UNITS_PER_COMMANDER} units per seat).`,
      );
    }
    const friendlySeats = Math.max(
      minFriendlySeats,
      Math.min(seats - minHostileSeats, Math.round((seats * friendlyCount) / tokens.length)),
    );
    const sideSeats = { friendly: friendlySeats, hostile: seats - friendlySeats };
    const tokenIndex = new Map(tokens.map((t, i) => [t, i]));
    const commanders = ["friendly", "hostile"].flatMap((factionId) => {
      const side = tokens.filter((token) => token.disposition === factionId);
      const count = sideSeats[factionId as keyof typeof sideSeats];
      if (side.length < count)
        throw new Error(`${factionId} needs at least ${count} visible tokens for ${seats} seats.`);
      const labelPrefix = factionId === "friendly" ? friendlyName : hostileName;
      return Array.from({ length: count }, (_, seatIndex) => ({
        id: "",
        name: `${labelPrefix} commander ${seatIndex + 1}`,
        factionId,
        units: side
          .filter((_, unitIndex) => unitIndex % count === seatIndex)
          .map((token) => {
            const index = tokenIndex.get(token) ?? 0;
            const tokCore = record(token.flags?.core) ? token.flags.core : undefined;
            const unitStrength =
              typeof tokCore?.strategicStrength === "number" &&
              Number.isInteger(tokCore.strategicStrength) &&
              tokCore.strategicStrength >= 1 &&
              tokCore.strategicStrength <= 120
                ? tokCore.strategicStrength
                : strength;
            const unitWeapon = tokCore?.strategicWeapon === "shot" ? ("shot" as const) : ("melee" as const);
            const actor = token.actorId ? store.get("actors", token.actorId) : undefined;
            if (actor) referencedActorIds.add(actor._id);
            const storedModelStats = strategicModelStatsEnabled(scene)
              ? readStoredModelStats(tokCore?.strategicModelStats, unitStrength)
              : undefined;
            const baseUnit: ScenarioUnit = {
              id: `unit-${index + 1}`,
              name: token.name,
              strength: unitStrength,
              weapon: unitWeapon,
              ...(storedModelStats ? { modelStats: storedModelStats } : {}),
              ...( /^[A-Za-z0-9_-]{1,64}$/.test(token._id)
                ? {
                    source: {
                      kind: "token",
                      tokenId: token._id,
                      ...(actor && /^[A-Za-z0-9_-]{1,64}$/.test(actor._id)
                        ? { actorId: actor._id }
                        : {}),
                    },
                  }
                : {}),
              // Token x/y is the CENTER (tokenRect); anchor is the unit's centre in ft.
              anchor: {
                x: (token.x / scene.grid.size) * 5,
                y: (token.y / scene.grid.size) * 5,
              },
            };
            return projectActorIntoUnit(baseUnit, token, actor, leaderActors);
          }),
      }));
    });
    commanders.forEach((commander, index) => {
      commander.id = `commander-${index + 1}`;
    });
    return projected({
      format: "arenastar-strategic-scenario-v1",
      name: scene.name,
      bounds,
      seed,
      ...rulesProjection,
      factions,
      commanders,
    });
  }
  // Arrange the same files/ranks as deploySnapshot, without overlapping boundary cells.
  if (!Number.isInteger(seats) || seats < 2 || seats > 500)
    throw new Error("Choose 2–500 commander seats.");
  const files = Math.min(strength, 10),
    ranks = Math.ceil(strength / 10);
  const cols = Math.floor(bounds.maxX / (5 * ranks)),
    rows = Math.floor(bounds.maxY / (5 * files));
  if (cols * rows < seats)
    throw new Error("Enlarge the scene: the selected formations do not fit.");
  const factions = [
    { id: "blue", name: "Blue", color: "#72bbff" },
    { id: "red", name: "Red", color: "#ff887e" },
  ];
  return projected({
    format: "arenastar-strategic-scenario-v1",
    name: scene.name,
    bounds,
    seed,
    ...rulesProjection,
    factions,
    commanders: Array.from({ length: seats }, (_, i) => {
      const red = i >= Math.ceil(seats / 2),
        j = red ? cols * rows - 1 - (i - Math.ceil(seats / 2)) : i;
      return {
        id: `commander-${i + 1}`,
        name: `Commander ${i + 1}`,
        factionId: red ? "red" : "blue",
        units: [
          {
            id: `unit-${i + 1}`,
            name: `${red ? "Red" : "Blue"} company ${i + 1}`,
            strength,
            weapon: "melee",
            anchor: {
              x: ((j % cols) * ranks + ranks - 0.5) * 5,
              y: (Math.floor(j / cols) * files + files / 2) * 5,
            },
          },
        ],
      };
    }),
  });
}

/** Host commit fence: embedded unit/scene operations count as writes to their parent. */
export function battleBlocks(b: BattleBinding, op: Op): boolean {
  let root: DocRef =
    op.kind === "create"
      ? (op.parent ?? { coll: op.coll, id: op.data._id })
      : op.ref;
  while (root.parent) root = root.parent;
  if (
    (root.coll === "armies" && b.armies.includes(root.id)) ||
    (root.coll === "factions" && b.factions.includes(root.id))
  )
    return true;
  return (
    root.coll === "scenes" &&
    root.id === b.scene &&
    !(
      op.kind === "update" &&
      !op.ref.parent &&
      Object.keys(op.diff).every((k) => k === "active")
    )
  );
}
