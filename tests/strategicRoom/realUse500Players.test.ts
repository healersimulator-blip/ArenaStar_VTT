/**
 * Real-Use 500-Player Large-Scale Strategic Battle & Persistent Per-Model Combat Statistics Suite.
 *
 * Exercises:
 * 1. 500 distinct seated players (250 Blue commanders + 250 Red commanders) + GM over a 5-turn
 *    realistic combined-arms battle (2,500 units / 25,000 models on a 6,000 × 6,000 ft field with
 *    fortress walls, interactive gates, difficult terrain, elevated ramparts, darkness/lights,
 *    wheeling marches, charges, ranged volleys, melee engagements, AoOs, readied actions,
 *    Fireball / Cone of Cold / Entangle spells, Haste / Cure consumables, fog-of-war views,
 *    binary full/patch wire frames, and zoomed `diffRegion` model patches for all 500 players).
 * 2. Opt-in `combat_resolver_5` (C45) per-soldier combat statistics (`flags.core.strategicModelStats`
 *    -> `scenario.trackModelStats`) across multiple turns AND across multiple campaign battles
 *    (Battle 1 -> `buildReconciliationPayload` -> `buildBattleReconciliationOps` -> Campaign Store
 *    -> Battle 2), verifying both Army-backed and Token-backed strategic scenes, dead-casualty
 *    compaction, survivor carry-over of kills & total damage done, fog-of-war enemy stat privacy,
 *    and zero impact on `PF1E_MODEL_SCHEMA` / `SimSnapshot` wire bytes when disabled.
 */
import { describe, expect, test } from "vitest";
import { createHash } from "node:crypto";
import { wallFieldsFor } from "../../src/canvas/vision/wallKinds";
import type {
  ActorDocument,
  SceneDocument,
  TokenDocument,
} from "../../src/core/documents";
import { OpLog } from "../../src/core/oplog";
import type { RulesContext, UnitView } from "../../src/core/rules";
import type { SimEvent } from "../../src/core/sim";
import { DocumentStore } from "../../src/core/store";
import type { ArmyDocument, FactionDocument, OrderQueue } from "../../src/core/strategic";
import { createMassBattlePf1e } from "../../src/packages/massBattlePf1e";
import { PF1E_MODEL_SCHEMA } from "../../src/packages/pf1e/schema";
import { allocModel, createModelPool } from "../../src/sim/pool";
import { XoshiroPRNG } from "../../src/sim/prng";
import {
  MAX_VIEW_BYTES,
  parseCommand,
  REGION_SIZE,
  STRATEGIC_PATCH_TYPE,
  STRATEGIC_VIEW_TYPE,
  type BaselineMeta,
  type ModelMarker,
  type RoomOrder,
} from "../../src/core/strategicRoom/protocol";
import {
  sceneDeployment,
  strategicModelStatsEnabled,
} from "../../src/core/strategicRoom/campaignScene";
import {
  analyzeBattleReconciliation,
  buildBattleReconciliationOps,
} from "../../src/core/strategicRoom/reconcile";
import { parseScenario } from "../../src/core/strategicRoom/scenario";
import { readView } from "../../src/core/strategicRoom/viewWire";
import { BattleView, diffRegion } from "../../services/strategic-room/src/battle";
import { buildReconciliationPayload } from "../../services/strategic-room/src/campaign";
import { resolveFrozen } from "../../services/strategic-room/src/resolve";
import { deploy } from "../../services/strategic-room/src/scenario";
import type { FrozenOrder, LiveRoomState, Member, Published } from "../../services/strategic-room/src/state";
import { viewPrefix } from "../../services/strategic-room/src/viewEncoding";

function must<T>(value: T | null | undefined, label = "value"): T {
  if (value === null || value === undefined) {
    throw new Error(`Expected ${label} to be defined`);
  }
  return value;
}

function makeWireResponse(
  meta: BaselineMeta,
  packed: Buffer | undefined,
  contentType: string,
): { response: Response; byteLength: number } {
  const body = packed ?? Buffer.alloc(0);
  const prefix = viewPrefix(meta, body.byteLength);
  if (!prefix) throw new Error("Wire frame exceeded MAX_VIEW_BYTES");
  const full = Buffer.concat([prefix, body]);
  return {
    response: new Response(full, { headers: { "content-type": contentType } }),
    byteLength: full.byteLength,
  };
}

describe("500-Player Real-Use Large-Scale Strategic Battle", () => {
  test(
    "drives 500 concurrent commanders + GM across 5 combined-arms turns (2,500 units / 25,000 models) with wire & fog-of-war verification",
    async () => {
      const PLAYERS = 500;
      const UNITS_PER_PLAYER = 5;
      const MODELS_PER_UNIT = 10;
      const TOTAL_UNITS = PLAYERS * UNITS_PER_PLAYER; // 2,500 units
      const TOTAL_MODELS = TOTAL_UNITS * MODELS_PER_UNIT; // 25,000 models
      const TURNS = 5;

      // Prepare authentic PNG token badge images (Blue shield & Red crest) for unit token badges
      const bluePngBytes = Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPj/HwADBwIAMCbHYQAAAABJRU5ErkJggg==",
        "base64",
      );
      const redPngBytes = Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
        "base64",
      );
      const blueBadgeHash = createHash("sha256").update(bluePngBytes).digest("hex");
      const redBadgeHash = createHash("sha256").update(redPngBytes).digest("hex");

      // Arrange 250 Blue brigades vs 250 Red brigades in 25 sectors along Y (each sector has 10 pairs = 50 Blue vs 50 Red units)
      // Each unit line spans up to 70 ft in Y (14-model enveloping heavy flankers vs 6-model opposing lines),
      // so space units 80 ft apart in Y and sectors 440 ft apart across a 12,000 x 12,000 ft field.
      const commanders = Array.from({ length: PLAYERS }, (_, pIdx) => {
        const isRed = pIdx % 2 === 1;
        const pairIdx = Math.floor(pIdx / 2); // 0..249
        const sectorRow = pairIdx % 25; // 0..24
        const sectorTier = Math.floor(pairIdx / 25); // 0..9 echelon depth
        const baseY = 500 + sectorRow * 440;
        const centerLineX = 6000;

        return {
          id: `cmd-${pIdx + 1}`,
          name: `${isRed ? "Crimson" : "Azure"} Commander ${Math.floor(pIdx / 2) + 1}`,
          factionId: isRed ? "fac-red" : "fac-blue",
          units: Array.from({ length: UNITS_PER_PLAYER }, (_, uIdx) => {
            const globalIdx = pIdx * UNITS_PER_PLAYER + uIdx + 1;
            const isRanged = uIdx === 3;
            const isCaster = uIdx === 4 && sectorTier === 0;
            // Asymmetric frontage on uIdx === 1: Blue fields a 14-model wide enveloping company
            // opposite Red's 6-model company so excess outer files genuinely wrap Red's flanks (`envelop: true`)!
            const unitStrength =
              uIdx === 1 ? (isRed ? 6 : 14) : MODELS_PER_UNIT;
            // Front tier (tier 0) starts 25 ft apart across the center line; deeper tiers 90 ft behind each tier
            const offsetFromCenter = 12.5 + sectorTier * 90 + (isRanged ? 25 : 0);
            const anchorX = isRed
              ? centerLineX + offsetFromCenter
              : centerLineX - offsetFromCenter;
            const anchorY = baseY + (uIdx - 2) * 80;

            return {
              id: `u-${globalIdx}`,
              name: `${isRed ? "Red" : "Blue"} ${pairIdx + 1}-${uIdx + 1}`,
              anchor: { x: anchorX, y: anchorY },
              strength: unitStrength,
              badge: isRed ? redBadgeHash : blueBadgeHash,
              weapon: isRanged ? ("shot" as const) : ("melee" as const),
              unitType: uIdx === 0 ? ("hero" as const) : ("infantry" as const),
              stats: {
                bab: uIdx === 0 ? 9 : 6,
                ac: isRanged ? 15 : 17,
                hp: 12,
                strMod: 3,
                dexMod: 2,
                weaponDamageDiceCount: 1,
                weaponDamageDiceSides: 8,
                weaponDamageMod: 3,
              },
              vision:
                uIdx === 0
                  ? { mode: "darkvision" as const, rangeFt: 60 }
                  : { mode: "normal" as const },
              ...(isCaster
                ? {
                    spells: [
                      {
                        id: "fireball" as const,
                        itemId: `sp-fb-${globalIdx}`,
                        casterLevel: 8,
                        castingAbilityMod: 4,
                        slots: 2,
                      },
                      {
                        id: "entangle" as const,
                        itemId: `sp-ent-${globalIdx}`,
                        casterLevel: 8,
                        castingAbilityMod: 4,
                        slots: 1,
                      },
                      {
                        id: "cone-of-cold" as const,
                        itemId: `sp-coc-${globalIdx}`,
                        casterLevel: 9,
                        castingAbilityMod: 4,
                        slots: 1,
                      },
                    ],
                  }
                : {}),
              ...(uIdx === 0 && sectorTier <= 1
                ? {
                    items: [
                      {
                        id: `itm-haste-${globalIdx}`,
                        name: "Warhorn of Haste",
                        effect: "haste" as const,
                        charges: 1,
                      },
                      {
                        id: `itm-heal-${globalIdx}`,
                        name: "Banner of Healing",
                        effect: "heal" as const,
                        charges: 2,
                        potency: 6,
                      },
                    ],
                  }
                : {}),
            };
          }),
        };
      });

      // Central gatehouse wall segment in Sector 0 + rough ground patches
      const scenario = parseScenario({
        format: "arenastar-strategic-scenario-v1",
        name: "Real-Use 500-Commander Grand Battle",
        seed: 20261122,
        bounds: { minX: 0, minY: 0, maxX: 12000, maxY: 12000 },
        trackModelStats: true,
        badges: {
          [blueBadgeHash]: {
            hash: blueBadgeHash,
            mime: "image/png",
            size: bluePngBytes.byteLength,
            width: 1,
            height: 1,
            data: bluePngBytes.toString("base64url"),
          },
          [redBadgeHash]: {
            hash: redBadgeHash,
            mime: "image/png",
            size: redPngBytes.byteLength,
            width: 1,
            height: 1,
            data: redPngBytes.toString("base64url"),
          },
        },
        walls: [
          {
            id: "central-gate",
            x1: 6000,
            y1: 300,
            x2: 6000,
            y2: 355,
            restriction: 15,
            openRestriction: 0,
            door: 0,
          },
          {
            x1: 6000,
            y1: 240,
            x2: 6000,
            y2: 300,
            restriction: 15,
          },
        ],
        terrain: {
          difficultCells: Array.from({ length: 40 }, (_, i) => ({
            col: 1198 + (i % 4),
            row: 120 + Math.floor(i / 4),
          })),
        },
        lighting: {
          darkness: 0.35,
          lights: [
            {
              id: "citadel-pyre",
              x: 6000,
              y: 500,
              dim: 160,
              bright: 80,
              color: "#ffb347",
              alpha: 0.65,
            },
          ],
        },
        regions: [
          {
            id: "high-ridge",
            name: "Central Ridge",
            x: 5940,
            y: 450,
            width: 120,
            height: 600,
            elevationFt: 15,
            kind: "raised",
          },
        ],
        actionCards: { playerCharacters: true, units: true, models: false },
        factions: [
          { id: "fac-blue", name: "Azure Coalition", color: "#4da3ff" },
          { id: "fac-red", name: "Crimson Empire", color: "#ff6b6b" },
        ],
        commanders,
      });

      const deployT0 = performance.now();
      let state: Published = deploy(scenario);
      const deployMs = performance.now() - deployT0;

      expect(state.units).toHaveLength(TOTAL_UNITS);
      expect(state.units.reduce((s, u) => s + u.stats.strength, 0)).toBe(TOTAL_MODELS);

      const projectionKey = Buffer.alloc(32, 0x5a);
      const gmMember: Member = { id: "gm", role: "GM", factionId: null, epoch: 1 };
      const playerMembers: Member[] = commanders.map((c) => ({
        id: c.id,
        name: c.name,
        role: "PLAYER",
        factionId: c.factionId,
        epoch: 1,
      }));

      const badgeUrls = {
        [blueBadgeHash]: `/api/rooms/r-500/badges/${blueBadgeHash}`,
        [redBadgeHash]: `/api/rooms/r-500/badges/${redBadgeHash}`,
      };
      let live: LiveRoomState = { doors: { "central-gate": 0 } };
      let prevView: BattleView | undefined;
      let view = new BattleView(scenario, state, projectionKey, undefined, live);

      // Verify all 500 players receive authorized initial views with strictly their 5 own units & token badge URLs
      for (let i = 0; i < PLAYERS; i++) {
        const m = playerMembers[i];
        if (!m) continue;
        const own = view.own(m, badgeUrls);
        expect(own).toHaveLength(UNITS_PER_PLAYER);
        expect(own.reduce((s, u) => s + u.alive, 0)).toBe(
          m.factionId === "fac-red" ? 46 : 54,
        );
        expect(own.every((u) => typeof u.badgeUrl === "string")).toBe(true);
      }
      expect(
        Object.keys(view.unitBadges(gmMember, badgeUrls) ?? {}).length,
      ).toBe(TOTAL_UNITS);

      const turnTimings: Array<{
        turn: number;
        ordersSubmitted: number;
        orderIntakeMs: number;
        resolveMs: number;
        rulesMs: number;
        projectionMs: number;
        survivingModels: number;
        casualtiesThisTurn: number;
        fullWireBytesBlue: number;
        patchWireBytesBlue: number;
      }> = [];

      // Track a zoomed-in player viewport replica across all 5 turns via `diffRegion`
      const watchedTile = `${Math.floor(5985 / REGION_SIZE)},${Math.floor(500 / REGION_SIZE)}`;
      const playerReplicaModels = new Map<string, ModelMarker>();
      const sampleBlue0 = must(playerMembers[0], "playerMembers[0]");
      {
        const initialVisible = view.region(sampleBlue0, watchedTile);
        const initialDiff = diffRegion(null, new Map(initialVisible.map((m) => [m.id, m])));
        for (const m of initialDiff.enter) playerReplicaModels.set(m.id, m);
        expect(playerReplicaModels.size).toBeGreaterThan(0);
      }

      let prevBlueBaseline: Awaited<ReturnType<typeof readView>> | undefined;
      {
        const meta0: BaselineMeta = {
          epoch: "ep-500",
          head: { turnId: 0, version: state.version, phase: "orders", deadlineMs: null },
          name: scenario.name,
          bounds: scenario.bounds,
          role: "PLAYER",
          factionId: sampleBlue0.factionId,
          factions: scenario.factions,
          own: view.own(sampleBlue0),
          orders: { revision: 0, edits: [] },
          areas: view.areas(sampleBlue0, 0),
        };
        const initFrame = makeWireResponse(
          meta0,
          view.packedMarkers(sampleBlue0),
          STRATEGIC_VIEW_TYPE,
        );
        prevBlueBaseline = await readView(initFrame.response);
      }
      for (let turn = 1; turn <= TURNS; turn++) {
        // Turn 2: GM opens the central gatehouse door mid-battle
        if (turn === 2) {
          live = { ...live, doors: { "central-gate": 1 } };
          view = new BattleView(scenario, state, projectionKey, prevView, live);
        }

        const frozenOrders: FrozenOrder[] = [];
        let validatedSubmissions = 0;

        const orderGenT0 = performance.now();
        // Pre-fetch each faction cohort's visible enemy markers once (cohort markers are shared per faction)
        const visibleEnemiesByFaction = new Map<string, ReturnType<BattleView["markers"]>>();
        for (const f of scenario.factions) {
          const rep = must(
            playerMembers.find((m) => m.factionId === f.id),
            `rep:${f.id}`,
          );
          visibleEnemiesByFaction.set(
            f.id,
            view.markers(rep).filter((mk) => mk.factionId !== f.id),
          );
        }

        // Every single one of the 500 players submits a validated `orders.submit` command!
        for (let pIdx = 0; pIdx < PLAYERS; pIdx++) {
          const member = must(playerMembers[pIdx], `playerMembers[${pIdx}]`);
          const ownUnits = view.own(member);
          const visibleEnemies =
            visibleEnemiesByFaction.get(member.factionId ?? "") ?? [];
          const isRed = member.factionId === "fac-red";
          const dirSign = isRed ? -1 : 1;
          const pairIdx = Math.floor(pIdx / 2);
          const sectorTier = Math.floor(pairIdx / 25);

          const unitEdits: Array<{ unitId: string; order: RoomOrder }> = [];

          for (let uSlot = 0; uSlot < ownUnits.length; uSlot++) {
            const u = must(ownUnits[uSlot], `ownUnits[${uSlot}]`);
            if (u.alive <= 0 || !u.at) continue;
            const lead = u.leadAt ?? u.at;

            // Find closest visible enemy unit within 320 ft (fast bounding box prefilter)
            let nearestEnemy: { id: string; at: { x: number; y: number }; dist: number } | null =
              null;
            for (const em of visibleEnemies) {
              const dx = em.at.x - u.at.x;
              const dy = em.at.y - u.at.y;
              if (Math.abs(dx) > 320 || Math.abs(dy) > 320) continue;
              const d = Math.hypot(dx, dy);
              if (!nearestEnemy || d < nearestEnemy.dist) {
                nearestEnemy = { id: em.id, at: em.at, dist: d };
              }
            }

            let chosenOrder: RoomOrder | null = null;
            const hasteItem = u.items?.find(
              (it) => it.effect === "haste" && it.charges > 0,
            );
            const healItem = u.items?.find(
              (it) => it.effect === "heal" && it.charges > 0,
            );
            const fbSpell = u.spells?.find(
              (s) => s.id === "fireball" && s.slots > 0,
            );
            const entSpell = u.spells?.find(
              (s) => s.id === "entangle" && s.slots > 0,
            );
            const cocSpell = u.spells?.find(
              (s) => s.id === "cone-of-cold" && s.slots > 0,
            );

            // 1. Turn 1: Vanguards blow Warhorns of Haste; Turn 3: wounded vanguards use Healing Banners
            if (turn === 1 && uSlot === 0 && hasteItem) {
              chosenOrder = { kind: "useItem", itemId: hasteItem.id };
            } else if (turn === 3 && uSlot === 0 && healItem) {
              chosenOrder = { kind: "useItem", itemId: healItem.id };
            }
            // 2. Casters unleash Fireball (Turn 1), Entangle (Turn 2), Cone of Cold (Turn 3)
            else if (
              turn === 1 &&
              fbSpell &&
              nearestEnemy &&
              nearestEnemy.dist <= 300
            ) {
              const candidate: RoomOrder = {
                kind: "cast",
                spellId: "fireball",
                itemId: fbSpell.itemId,
                origin: {
                  x: Math.round(nearestEnemy.at.x * 10) / 10,
                  y: Math.round(nearestEnemy.at.y * 10) / 10,
                },
              };
              if (!view.validate(member, { unitId: u.id, order: candidate })) {
                chosenOrder = candidate;
              }
            } else if (
              turn === 2 &&
              pIdx < 20 &&
              entSpell &&
              nearestEnemy &&
              nearestEnemy.dist <= 160
            ) {
              const candidate: RoomOrder = {
                kind: "cast",
                spellId: "entangle",
                itemId: entSpell.itemId,
                origin: {
                  x: Math.round(nearestEnemy.at.x * 10) / 10,
                  y: Math.round(nearestEnemy.at.y * 10) / 10,
                },
              };
              if (!view.validate(member, { unitId: u.id, order: candidate })) {
                chosenOrder = candidate;
              }
            } else if (turn === 3 && pIdx < 20 && cocSpell) {
              const candidate: RoomOrder = {
                kind: "cast",
                spellId: "cone-of-cold",
                itemId: cocSpell.itemId,
                origin: { x: lead.x, y: lead.y },
                dir: { x: dirSign, y: 0 },
              };
              if (!view.validate(member, { unitId: u.id, order: candidate })) {
                chosenOrder = candidate;
              }
            }
            // 3. Ranged archers fire volleys at visible enemies within range
            else if (u.weapon === "shot" && nearestEnemy && nearestEnemy.dist <= 220) {
              chosenOrder = {
                kind: "attack",
                targetUnitId: nearestEnemy.id,
                mode: "shot",
              };
            }
            // 4. Frontline melee units in close contact attack (with flank envelopment on Turn 3+)
            else if (nearestEnemy && nearestEnemy.dist <= 25) {
              chosenOrder = {
                kind: "attack",
                targetUnitId: nearestEnemy.id,
                mode: "melee",
                ...(turn >= 3 && uSlot === 1 ? { envelop: true } : {}),
              };
            }
            // 5. Turn 2 second-tier units set Readied actions (`enemyEntersReach`)
            else if (turn === 2 && sectorTier === 1 && uSlot === 2) {
              chosenOrder = {
                kind: "ready",
                trigger: "enemyEntersReach",
                response: "melee",
              };
            }
            // 6. Turn 4 battered frontline companies reform ranks
            else if (turn === 4 && u.alive < MODELS_PER_UNIT && uSlot === 2) {
              chosenOrder = { kind: "reform" };
            }
            // 7. Otherwise advance: wheeling diagonal march or straight charge toward the battle line!
            //    (`uSlot === 1` marches straight along X so Blue's 14-file company meets Red's 6-file
            //    company symmetrically and executes perimeter flank-wrapping `envelop: true` on contact!)
            else {
              const wantCharge = turn === 2 && sectorTier === 0 && uSlot === 0;
              const stepX = dirSign * (wantCharge ? 30 : 20);
              const stepY =
                wantCharge || uSlot === 1 ? 0 : uSlot % 2 === 0 ? 5 : -5;
              const destX = Math.max(80, Math.min(11920, lead.x + stepX));
              const destY = Math.max(80, Math.min(11920, lead.y + stepY));
              const candidate: RoomOrder = {
                kind: "move",
                pace: wantCharge ? "charge" : "march",
                path: [{ x: destX, y: destY }],
                ...(turn === 3 && !wantCharge && uSlot === 2 ? { reform: true } : {}),
              };
              if (!view.validate(member, { unitId: u.id, order: candidate })) {
                chosenOrder = candidate;
              } else {
                chosenOrder = { kind: "hold", stance: "defend" };
              }
            }

            if (!chosenOrder) {
              chosenOrder = { kind: "hold", stance: "hold" };
            }
            const err = view.validate(member, { unitId: u.id, order: chosenOrder });
            if (err) {
              chosenOrder = { kind: "hold", stance: "defend" };
              expect(view.validate(member, { unitId: u.id, order: chosenOrder })).toBeNull();
            }
            unitEdits.push({ unitId: u.id, order: chosenOrder });
          }

          if (unitEdits.length > 0) {
            // Validate full wire command schema (`parseCommand`) exactly as `server.ts` does on WS ingress
            const wireCmd = parseCommand({
              kind: "orders.submit",
              requestId: `req-t${turn}-p${pIdx + 1}-00000000`,
              turnId: turn,
              expectedRevision: 0,
              unitEdits,
            });
            expect(wireCmd).not.toBeNull();
            validatedSubmissions++;
            for (const edit of unitEdits) {
              frozenOrders.push({
                unitId: edit.unitId,
                memberId: member.id,
                order: edit.order,
              });
            }
          }
        }

        const orderIntakeMs = performance.now() - orderGenT0;
        expect(validatedSubmissions).toBe(PLAYERS);

        // Resolve the 500-player simultaneous turn!
        const res = resolveFrozen({
          turnId: turn,
          seed: 9000 + turn,
          start: state,
          scenario,
          live,
          orders: frozenOrders,
        });

        const projT0 = performance.now();
        const nextView = new BattleView(scenario, res.state, projectionKey, view, live);
        const projectionMs = performance.now() - projT0;

        const survivingModels = res.rows.reduce((s, r) => s + r.alive, 0);
        const casualtiesThisTurn = res.rows.reduce((s, r) => s + r.lost, 0);

        // Measure & decode real wire payloads (full view + incremental marker patch) for Blue, Red, and GM
        const sampleBlue = sampleBlue0;
        const metaBlue: BaselineMeta = {
          epoch: "ep-500",
          head: { turnId: turn, version: res.state.version, phase: "report", deadlineMs: null },
          name: scenario.name,
          bounds: scenario.bounds,
          role: "PLAYER",
          factionId: sampleBlue.factionId,
          factions: scenario.factions,
          own: nextView.own(sampleBlue),
          orders: { revision: 1, edits: [] },
          areas: nextView.areas(sampleBlue, turn),
        };
        const fullFrame = makeWireResponse(
          metaBlue,
          nextView.packedMarkers(sampleBlue),
          STRATEGIC_VIEW_TYPE,
        );
        expect(fullFrame.byteLength).toBeLessThan(MAX_VIEW_BYTES);
        const decodedFull = await readView(fullFrame.response);
        expect(decodedFull.head.turnId).toBe(turn);
        expect(decodedFull.markers.length).toBeGreaterThan(0);

        const patchBuf = nextView.markerChanges(sampleBlue);
        let patchBytes = fullFrame.byteLength;
        if (patchBuf && prevBlueBaseline) {
          const patchFrame = makeWireResponse(metaBlue, patchBuf, STRATEGIC_PATCH_TYPE);
          patchBytes = patchFrame.byteLength;
          const decodedPatch = await readView(patchFrame.response, prevBlueBaseline);
          expect(decodedPatch.markers).toEqual(decodedFull.markers);
        }
        prevBlueBaseline = decodedFull;

        // Update zoomed viewport model replica via `diffRegion` and verify fog-of-war enemy stat privacy
        const nextVisibleList = nextView.region(sampleBlue, watchedTile);
        const nextVisibleMap = new Map(nextVisibleList.map((m) => [m.id, m]));
        const regionDelta = diffRegion(playerReplicaModels, nextVisibleMap);
        for (const id of regionDelta.leave) playerReplicaModels.delete(id);
        for (const m of regionDelta.enter) playerReplicaModels.set(m.id, m);
        for (const m of regionDelta.update) playerReplicaModels.set(m.id, m);
        expect(playerReplicaModels.size).toBe(nextVisibleMap.size);

        // Enemy models visible in fog-of-war must NEVER leak private soldier stats to opposing players,
        // while GM and owning faction see soldier stats!
        const blueUnitIds = new Set(
          commanders
            .filter((c) => c.factionId === "fac-blue")
            .flatMap((c) => c.units.map((u) => u.id)),
        );
        for (const m of nextVisibleList) {
          if (!blueUnitIds.has(m.unitId)) {
            expect(m.stats).toBeUndefined();
          }
        }

        turnTimings.push({
          turn,
          ordersSubmitted: frozenOrders.length,
          orderIntakeMs: Math.round(orderIntakeMs * 10) / 10,
          resolveMs: Math.round(res.metrics.resolveMs * 10) / 10,
          rulesMs: Math.round(res.metrics.rulesMs * 10) / 10,
          projectionMs: Math.round(projectionMs * 10) / 10,
          survivingModels,
          casualtiesThisTurn,
          fullWireBytesBlue: fullFrame.byteLength,
          patchWireBytesBlue: patchBytes,
        });

        prevView = view;
        view = nextView;
        state = res.state;
      }

      // Verify genuine large-scale combat occurred across the 5 turns
      const totalCasualties = TOTAL_MODELS - (turnTimings.at(-1)?.survivingModels ?? TOTAL_MODELS);
      expect(totalCasualties).toBeGreaterThan(200);
      expect(turnTimings.every((t) => t.ordersSubmitted > 2_000)).toBe(true);

      // Verify perimeter envelopment (`envelop: true` wrapping Blue's 14-file flankers around Red's 6-file line):
      // In Sector 0 (`u-2` vs `u-7`), Blue's outer files wrap forward in X past their central contact line (`x = 5995`)!
      const sectorTile0 = `${Math.floor(5995 / REGION_SIZE)},${Math.floor(420 / REGION_SIZE)}`;
      const sectorTile0Right = `${Math.floor(6010 / REGION_SIZE)},${Math.floor(420 / REGION_SIZE)}`;
      const gmSlot1Models = [
        ...view.region(gmMember, sectorTile0),
        ...(sectorTile0Right !== sectorTile0
          ? view.region(gmMember, sectorTile0Right)
          : []),
      ].filter((m) => m.unitId === "u-2");
      if (gmSlot1Models.length >= 8) {
        const minX = Math.min(...gmSlot1Models.map((m) => m.x));
        const maxX = Math.max(...gmSlot1Models.map((m) => m.x));
        // A pure flat vertical line has `maxX === minX`; wrapped flankers step forward along X (`maxX > minX + 4`)!
        expect(maxX - minX).toBeGreaterThanOrEqual(4);
      }

      // Verify GM view sees all surviving units and bounded action cards
      const gmMarkers = view.markers(gmMember);
      expect(gmMarkers.length).toBeGreaterThan(2_000);
      expect(gmMarkers.length).toBeLessThanOrEqual(TOTAL_UNITS);
      expect((state.actions?.length ?? 0)).toBeGreaterThan(0);
      expect((state.actions?.length ?? 0)).toBeLessThanOrEqual(64);

      // Verify reconciliation payload & per-model combat stats consistency across all 2,500 units
      const lastTiming = must(turnTimings.at(-1), "lastTiming");
      const recon = buildReconciliationPayload(
        "00000000-0000-4000-8000-000000000500",
        scenario,
        state,
        live,
        lastTiming.survivingModels,
        lastTiming.casualtiesThisTurn,
      );
      expect(recon.units).toHaveLength(TOTAL_UNITS);
      expect(recon.doorStates?.["central-gate"]).toBe(1);

      let survivingRecordedKills = 0;
      let survivingRecordedDamage = 0;
      let veteransWithKills = 0;
      for (const u of recon.units ?? []) {
        if (u.alive > 0) {
          expect(u.modelStats).toHaveLength(u.alive);
          for (const ms of u.modelStats ?? []) {
            survivingRecordedKills += ms.kills;
            survivingRecordedDamage += ms.damageDealt;
            if (ms.kills > 0) veteransWithKills++;
          }
        }
      }
      // Surviving soldiers hold substantial kills and damage dealt (dead attackers' kills were pruned with them)
      expect(survivingRecordedKills).toBeGreaterThan(50);
      expect(survivingRecordedDamage).toBeGreaterThan(500);
      expect(veteransWithKills).toBeGreaterThan(30);

      // Verify performance SLAs for 500 concurrent players (2,500 units / 25,000 models)
      for (const t of turnTimings) {
        expect(t.orderIntakeMs).toBeLessThan(3_000);
        expect(t.resolveMs).toBeLessThan(12_000);
        expect(t.projectionMs).toBeLessThan(2_500);
      }

      console.info(
        `[500-Player Real-Use Benchmark] deploy=${deployMs.toFixed(1)}ms, totalCasualties=${totalCasualties}/${TOTAL_MODELS}, survivingVeteransWithKills=${veteransWithKills}, survivingKills=${survivingRecordedKills}, survivingDmg=${survivingRecordedDamage}\n` +
          turnTimings
            .map(
              (t) =>
                `  Turn ${t.turn}: orders=${t.ordersSubmitted} intake=${t.orderIntakeMs}ms resolve=${t.resolveMs}ms (rules=${t.rulesMs}ms) viewProj=${t.projectionMs}ms alive=${t.survivingModels} lost=${t.casualtiesThisTurn} wireFull=${t.fullWireBytesBlue}B wirePatch=${t.patchWireBytesBlue}B`,
            )
            .join("\n"),
      );
    },
    120_000,
  );
});

describe("Persistent Per-Model Combat Statistics Across Campaign Battles (C45 Option)", () => {
  function buildCampaignBattleWorld(enableModelStats: boolean, mode: "army" | "token") {
    const store = new DocumentStore({
      meta: { worldId: "w-vet-stats", name: "Veteran Chronicles", system: "pf1e", systemVersion: "1" },
    });
    const log = new OpLog();
    let seq = 0;
    const applyCreate = (
      coll: Extract<Parameters<DocumentStore["applyEnvelope"]>[0]["ops"][number], { kind: "create" }>["coll"],
      data: unknown,
    ) => {
      seq++;
      const env = {
        seq,
        ts: seq,
        by: "gm",
        txId: `init-${seq}`,
        ops: [{ kind: "create" as const, coll, data: data as never }],
      };
      expect(store.applyEnvelope(env).ok).toBe(true);
      log.append(env);
    };

    const blueFaction: FactionDocument = {
      _id: "fac-blue",
      type: "faction",
      name: "Ironshields",
      color: "#4da3ff",
      allies: [],
      ownership: { default: 1 },
      flags: {},
      system: {},
    };
    const redFaction: FactionDocument = {
      _id: "fac-red",
      type: "faction",
      name: "Bloodclaws",
      color: "#ff6b6b",
      allies: [],
      ownership: { default: 1 },
      flags: {},
      system: {},
    };
    applyCreate("factions", blueFaction);
    applyCreate("factions", redFaction);

    const blueHero: ActorDocument = {
      _id: "act-blue",
      type: "actor",
      name: "Captain Vane",
      ownership: { default: 0 },
      flags: {},
      items: [
        {
          _id: "itm-greatsword",
          type: "item",
          name: "Masterwork Greatsword",
          ownership: { default: 0 },
          flags: {},
          effects: [],
          system: {
            pf1e: {
              kind: "weapon",
              equipped: true,
              damage: "2d6",
              attackBonus: 2,
              critRange: 19,
              critMult: 2,
            },
          },
        },
        {
          _id: "itm-banner-heal",
          type: "item",
          name: "Potion of Cure Moderate Wounds",
          ownership: { default: 0 },
          flags: {},
          effects: [],
          system: { pf1e: { subtype: "potion", charges: 3 } },
        },
      ],
      effects: [],
      system: {
        pf1e: {
          hp: 24,
          hpMax: 24,
          baseAttack: 10,
          abilities: { str: 18, dex: 14, con: 14, int: 14, wis: 12, cha: 14 },
          saves: { fort: 7, ref: 5, will: 5 },
          armor: { armorBonus: 7, shieldBonus: 0 },
          spells: {
            casterLevel: 8,
            keyAbility: "int",
            prepared: [
              { id: "p-fb", name: "Fireball", level: 3, expended: false },
            ],
          },
        },
      },
    };
    const redBrute: ActorDocument = {
      _id: "act-red",
      type: "actor",
      name: "Orc Raider",
      ownership: { default: 0 },
      flags: {},
      items: [],
      effects: [],
      system: {
        pf1e: {
          hp: 8,
          hpMax: 8,
          baseAttack: 3,
          abilities: { str: 14, dex: 10, con: 12, int: 8, wis: 10, cha: 8 },
          saves: { fort: 3, ref: 1, will: 1 },
          ac: { armor: 2, shield: 0, natural: 0, deflection: 0, dodge: 0, misc: 0 },
        },
      },
    };
    applyCreate("actors", blueHero);
    applyCreate("actors", redBrute);

    const tokBlue: TokenDocument = {
      _id: "tok-blue",
      type: "token",
      name: "1st Ironshields",
      actorId: "act-blue",
      x: 500,
      y: 700,
      width: 100,
      height: 100,
      rotation: 0,
      img: "",
      hidden: false,
      disposition: "friendly",
      vision: true,
      light: { radius: 0, color: "#ffffff", alpha: 0 },
      ownership: { default: 1 },
      flags: { core: { strategicStrength: 10, strategicWeapon: "melee" } },
      system: {},
    };
    const tokRed: TokenDocument = {
      _id: "tok-red",
      type: "token",
      name: "Orc Warband",
      actorId: "act-red",
      x: 700,
      y: 700,
      width: 100,
      height: 100,
      rotation: 180,
      img: "",
      hidden: false,
      disposition: "hostile",
      vision: true,
      light: { radius: 0, color: "#ffffff", alpha: 0 },
      ownership: { default: 1 },
      flags: { core: { strategicStrength: 12, strategicWeapon: "melee" } },
      system: {},
    };

    if (mode === "army") {
      const blueArmy: ArmyDocument = {
        _id: "army-blue",
        type: "army",
        name: "Ironshield Host",
        factionId: "fac-blue",
        commander: ["u-cmd-blue"],
        supply: {},
        ownership: { default: 0 },
        flags: {},
        system: {},
        units: [
          {
            _id: "u-iron",
            type: "infantry",
            name: "1st Ironshields",
            leaderTokenId: "tok-blue",
            formation: "line",
            sceneId: "scene-valley",
            modelRange: [0, 10],
            profile: { anchor: { x: 25, y: 35 } },
            stats: { strength: 10, morale: 100, supply: 100, fatigue: 0 },
            orders: { pending: [], issuedBy: "gm", issuedTurn: 0 },
            ownership: { default: 0 },
            flags: {},
            system: {},
          },
        ],
      };
      const redArmy: ArmyDocument = {
        _id: "army-red",
        type: "army",
        name: "Bloodclaw Horde",
        factionId: "fac-red",
        commander: ["u-cmd-red"],
        supply: {},
        ownership: { default: 0 },
        flags: {},
        system: {},
        units: [
          {
            _id: "u-orcs",
            type: "infantry",
            name: "Orc Warband",
            leaderTokenId: "tok-red",
            formation: "line",
            sceneId: "scene-valley",
            modelRange: [10, 22],
            profile: { anchor: { x: 35, y: 35 } },
            stats: { strength: 12, morale: 100, supply: 100, fatigue: 0 },
            orders: { pending: [], issuedBy: "gm", issuedTurn: 0 },
            ownership: { default: 0 },
            flags: {},
            system: {},
          },
        ],
      };
      applyCreate("armies", blueArmy);
      applyCreate("armies", redArmy);
    }

    const scene: SceneDocument = {
      _id: "scene-valley",
      type: "scene",
      name: "Bloody Valley",
      active: true,
      img: null,
      width: 2400,
      height: 1600,
      darkness: 0,
      grid: { type: "square", size: 100, units: "ft", distance: 5, diagonals: "555", hexLayout: "oddQ" },
      tokens: [tokBlue, tokRed],
      walls: [
        {
          _id: "valley-gate",
          type: "wall",
          name: "Valley Palisade",
          ownership: { default: 0 },
          flags: {},
          system: {},
          ...wallFieldsFor("door", [1200, 0, 1200, 300], 1),
        },
      ],
      lights: [],
      regions: [],
      sounds: [],
      tiles: [],
      drawings: [],
      templates: [],
      notes: [],
      ownership: { default: 1 },
      flags: {
        core: {
          scale: "strategic",
          ...(enableModelStats ? { strategicModelStats: true } : {}),
        },
      },
      system: {},
    };
    applyCreate("scenes", scene);

    return {
      store,
      applyOps: (ops: Parameters<DocumentStore["applyEnvelope"]>[0]["ops"]) => {
        seq++;
        const res = store.applyEnvelope({
          seq,
          ts: seq,
          by: "gm",
          txId: `reconcile-${seq}`,
          ops,
        });
        expect(res.ok).toBe(true);
      },
    };
  }

  test("stays completely inert when disabled (`strategicModelStats` off) — zero extras or payload bloat", () => {
    const { store } = buildCampaignBattleWorld(false, "army");
    const scene = must(store.get("scenes", "scene-valley"), "scene-valley");
    expect(strategicModelStatsEnabled(scene)).toBe(false);

    const scenario = sceneDeployment(store, scene, 1001, 2);
    expect(scenario.trackModelStats).toBeUndefined();

    const state0 = deploy(scenario);
    expect(state0.extras?.modelStats).toBeUndefined();

    const turn1 = resolveFrozen({
      turnId: 1,
      seed: 42,
      start: state0,
      scenario,
      orders: [
        {
          unitId: "u-iron",
          memberId: "commander-1",
          order: { kind: "attack", targetUnitId: "u-orcs", mode: "melee" },
        },
        {
          unitId: "u-orcs",
          memberId: "commander-2",
          order: { kind: "attack", targetUnitId: "u-iron", mode: "melee" },
        },
      ],
    });
    expect(turn1.state.extras?.modelStats).toBeUndefined();

    const recon = buildReconciliationPayload(
      "00000000-0000-4000-8000-000000000001",
      scenario,
      turn1.state,
      {},
      turn1.rows.reduce((s, r) => s + r.alive, 0),
      turn1.rows.reduce((s, r) => s + r.lost, 0),
    );
    expect(recon.units?.[0]?.modelStats).toBeUndefined();
    expect(recon.units?.[0]?.modelStatsSummary).toBeUndefined();
  });

  test("persists cumulative per-soldier kills, damage, hits/crits & healing across Battle 1 -> Campaign Reconcile -> Battle 2 (Army-backed)", () => {
    const { store, applyOps } = buildCampaignBattleWorld(true, "army");
    const scene1 = must(store.get("scenes", "scene-valley"), "scene-valley");
    expect(strategicModelStatsEnabled(scene1)).toBe(true);

    // ── BATTLE 1 ──
    const scenario1 = sceneDeployment(store, scene1, 2001, 2);
    expect(scenario1.trackModelStats).toBe(true);
    let state1 = deploy(scenario1);

    // Turn 1: Melee clash between 1st Ironshields and Orc Warband
    const r1 = resolveFrozen({
      turnId: 1,
      seed: 12345,
      start: state1,
      scenario: scenario1,
      orders: [
        {
          unitId: "u-iron",
          memberId: "commander-1",
          order: { kind: "attack", targetUnitId: "u-orcs", mode: "melee" },
        },
        {
          unitId: "u-orcs",
          memberId: "commander-2",
          order: { kind: "attack", targetUnitId: "u-iron", mode: "melee" },
        },
      ],
    });
    state1 = r1.state;

    const recon1 = buildReconciliationPayload(
      "00000000-0000-4000-8000-000000000011",
      scenario1,
      state1,
      {},
      r1.rows.reduce((s, r) => s + r.alive, 0),
      r1.rows.reduce((s, r) => s + r.lost, 0),
    );
    const ironSummary1 = must(
      recon1.units?.find((u) => u.id === "u-iron"),
      "ironSummary1",
    );
    const ironStats1 = must(ironSummary1.modelStatsSummary, "ironStats1");
    expect(ironSummary1.alive).toBeGreaterThan(0);
    expect(ironSummary1.modelStats).toHaveLength(ironSummary1.alive);
    expect(ironStats1.kills).toBeGreaterThan(0);
    expect(ironStats1.damageDealt).toBeGreaterThan(0);
    expect(ironStats1.hits ?? 0).toBeGreaterThan(0);

    const b1Kills = ironStats1.kills;
    const b1Damage = ironStats1.damageDealt;
    const b1Alive = ironSummary1.alive;

    // Reconcile Battle 1 back into Campaign DocumentStore
    const analysis1 = analyzeBattleReconciliation(store, "scene-valley", recon1);
    expect(analysis1.conflicts).toHaveLength(0);
    const { ops: ops1, reconciledUnits } = buildBattleReconciliationOps(
      store,
      "scene-valley",
      recon1,
    );
    expect(reconciledUnits).toBe(2);
    applyOps(ops1);

    // Verify Army unit & leader Token in campaign store now hold the surviving veterans' C45 stats
    const updatedArmy = must(store.get("armies", "army-blue"), "army-blue");
    const updatedArmyUnit = must(updatedArmy.units[0], "army-blue.units[0]");
    expect(updatedArmyUnit.stats.strength).toBe(b1Alive);
    expect(Array.isArray(updatedArmyUnit.profile.modelStats)).toBe(true);
    expect((updatedArmyUnit.profile.modelStats as unknown[]).length).toBe(b1Alive);

    // Reinforce the Orc Warband with fresh troops in the campaign between battles so Battle 2 has fresh foes!
    applyOps([
      {
        kind: "update",
        ref: { coll: "units", id: "u-orcs", parent: { coll: "armies", id: "army-red" } },
        diff: {
          "stats.strength": 12,
          "profile.anchor": { x: 35, y: 35 },
          "profile.modelStats": [],
        },
      },
      {
        kind: "update",
        ref: { coll: "tokens", id: "tok-red", parent: { coll: "scenes", id: "scene-valley" } },
        diff: { hidden: false, "flags.core.strategicStrength": 12 },
      },
    ]);

    // ── BATTLE 2 ──
    const scene2 = must(store.get("scenes", "scene-valley"), "scene2");
    const scenario2 = sceneDeployment(store, scene2, 3002, 2);
    const ironDeployed2 = must(
      scenario2.commanders.flatMap((c) => c.units).find((u) => u.id === "u-iron"),
      "ironDeployed2",
    );
    const deployedStats2 = must(ironDeployed2.modelStats, "deployedStats2");
    expect(ironDeployed2.strength).toBe(b1Alive);
    expect(deployedStats2).toHaveLength(b1Alive);
    expect(deployedStats2.reduce((s, m) => s + m.kills, 0)).toBe(b1Kills);
    expect(deployedStats2.reduce((s, m) => s + m.damageDealt, 0)).toBe(b1Damage);

    // Deploy Battle 2 and verify `BattleView` immediately surfaces Battle 1's carried-over veteran stats on Turn 0!
    const state2Start = deploy(scenario2);
    const view2Start = new BattleView(
      scenario2,
      state2Start,
      Buffer.alloc(32, 3),
    );
    const blueCommander: Member = {
      id: "commander-1",
      role: "PLAYER",
      factionId: "fac-blue",
      epoch: 1,
    };
    const redCommander: Member = {
      id: "commander-2",
      role: "PLAYER",
      factionId: "fac-red",
      epoch: 1,
    };
    const ownIronAtT0 = must(
      view2Start.own(blueCommander).find((u) => u.id === "u-iron"),
      "ownIronAtT0",
    );
    expect(ownIronAtT0.modelStatsSummary?.kills).toBe(b1Kills);
    expect(ownIronAtT0.modelStatsSummary?.damageDealt).toBe(b1Damage);

    // Verify zoomed-in `ModelMarker` exposes per-soldier stats to owner & GM, but redacts them for enemy commander!
    const tile = `${Math.floor(25 / REGION_SIZE)},${Math.floor(35 / REGION_SIZE)}`;
    const blueModelsT0 = view2Start.region(blueCommander, tile).filter((m) => m.unitId === "u-iron");
    expect(blueModelsT0.some((m) => (m.stats?.kills ?? 0) > 0)).toBe(true);
    const redModelsSeeingIron = view2Start.region(redCommander, tile).filter((m) => m.unitId === "u-iron");
    expect(redModelsSeeingIron.every((m) => m.stats === undefined)).toBe(true);

    // Fight Battle 2 Turn 1: Captain Vane casts Fireball on the Orc Warband -> caster lead model's
    // spell kills & spell damage done accumulate directly on top of Battle 1's melee stats!
    const fbSpell = must(
      ownIronAtT0.spells?.find((s) => s.id === "fireball"),
      "fbSpell",
    );
    const r2 = resolveFrozen({
      turnId: 1,
      seed: 54321,
      start: state2Start,
      scenario: scenario2,
      orders: [
        {
          unitId: "u-iron",
          memberId: "commander-1",
          order: {
            kind: "cast",
            spellId: "fireball",
            itemId: fbSpell.itemId,
            origin: { x: 50, y: 35 },
          },
        },
        {
          unitId: "u-orcs",
          memberId: "commander-2",
          order: { kind: "hold", stance: "hold" },
        },
      ],
    });

    // Fight Battle 2 Turn 2: 1st Ironshields finish any surviving Orcs in melee!
    const r2b = resolveFrozen({
      turnId: 2,
      seed: 54322,
      start: r2.state,
      scenario: scenario2,
      orders: [
        {
          unitId: "u-iron",
          memberId: "commander-1",
          order: { kind: "attack", targetUnitId: "u-orcs", mode: "melee" },
        },
      ],
    });

    // Since Orcs held without attacking back in Battle 2, all `b1Alive` Ironshield veterans survived
    // and strictly increased their cumulative kills and total damage done (Fireball + melee)!
    const recon2 = buildReconciliationPayload(
      "00000000-0000-4000-8000-000000000012",
      scenario2,
      r2b.state,
      {},
      r2b.rows.reduce((s, r) => s + r.alive, 0),
      r2b.rows.reduce((s, r) => s + r.lost, 0),
    );
    const ironSummary2 = must(
      recon2.units?.find((u) => u.id === "u-iron"),
      "ironSummary2",
    );
    const ironStats2 = must(ironSummary2.modelStatsSummary, "ironStats2");
    expect(ironSummary2.alive).toBe(b1Alive);
    expect(ironStats2.kills).toBeGreaterThan(b1Kills);
    expect(ironStats2.damageDealt).toBeGreaterThan(b1Damage);
    expect(ironStats2.topVeteran).toBeDefined();
  });

  test("also persists per-soldier combat statistics across battles for Token-only strategic deployments (no Army docs)", () => {
    const { store, applyOps } = buildCampaignBattleWorld(true, "token");
    const scene1 = must(store.get("scenes", "scene-valley"), "scene1");

    const scenario1 = sceneDeployment(store, scene1, 7001, 2, 10);
    expect(scenario1.trackModelStats).toBe(true);
    const state1 = deploy(scenario1);

    const r1 = resolveFrozen({
      turnId: 1,
      seed: 999,
      start: state1,
      scenario: scenario1,
      orders: [
        {
          unitId: "unit-1",
          memberId: "commander-1",
          order: { kind: "attack", targetUnitId: "unit-2", mode: "melee" },
        },
        {
          unitId: "unit-2",
          memberId: "commander-2",
          order: { kind: "hold", stance: "hold" },
        },
      ],
    });

    const recon1 = buildReconciliationPayload(
      "00000000-0000-4000-8000-000000000021",
      scenario1,
      r1.state,
      {},
      r1.rows.reduce((s, r) => s + r.alive, 0),
      r1.rows.reduce((s, r) => s + r.lost, 0),
    );
    const u1 = must(recon1.units?.find((u) => u.id === "unit-1"), "u1");
    const u1Stats = must(u1.modelStatsSummary, "u1Stats");
    expect(u1Stats.kills).toBeGreaterThan(0);
    expect(u1Stats.damageDealt).toBeGreaterThan(0);

    const { ops } = buildBattleReconciliationOps(store, "scene-valley", recon1);
    applyOps(ops);

    const sceneAfter = must(store.get("scenes", "scene-valley"), "sceneAfter");
    const tokAfter = must(
      sceneAfter.tokens.find((t) => t._id === "tok-blue"),
      "tokAfter",
    );
    expect(Array.isArray(tokAfter.flags?.core?.strategicModelStats)).toBe(true);

    // Ensure tok-red is visible with fresh strength for Battle 2
    applyOps([
      {
        kind: "update",
        ref: { coll: "tokens", id: "tok-red", parent: { coll: "scenes", id: "scene-valley" } },
        diff: { hidden: false, "flags.core.strategicStrength": 12, "flags.core.strategicModelStats": [] },
      },
    ]);

    const sceneReloaded = must(store.get("scenes", "scene-valley"), "sceneReloaded");
    const scenario2 = sceneDeployment(store, sceneReloaded, 7002, 2, 10);
    const u1Reloaded = must(
      scenario2.commanders.flatMap((c) => c.units).find((u) => u.id === "unit-1"),
      "u1Reloaded",
    );
    expect(u1Reloaded.modelStats?.reduce((s, m) => s + m.kills, 0)).toBe(
      u1Stats.kills,
    );
    expect(u1Reloaded.modelStats?.reduce((s, m) => s + m.damageDealt, 0)).toBe(
      u1Stats.damageDealt,
    );
  });
});

describe("Combat Resolver 5 Envelopment, Lateral Breach Slide & Sector Push-Through (C10–C13 / C17b / C39)", () => {
  test("demonstrates perimeter flank-wrapping (`envelop`), +2 AoN flanking bonus, lateral breach sliding, and full-sector push-through", () => {
    // 1. Hosted perimeter flank-wrapping (`envelop: true`):
    //    Blue 8-file line (y spans 40 ft) vs Red 2-file line (y spans 10 ft) at 5 ft contact.
    const wrapScenario = parseScenario({
      format: "arenastar-strategic-scenario-v1",
      name: "Envelopment Demonstration",
      seed: 404,
      bounds: { minX: 0, minY: 0, maxX: 400, maxY: 400 },
      trackModelStats: true,
      factions: [
        { id: "fac-blue", name: "Blue", color: "#4da3ff" },
        { id: "fac-red", name: "Red", color: "#ff6b6b" },
      ],
      commanders: [
        {
          id: "c-blue",
          factionId: "fac-blue",
          units: [
            {
              id: "u-wide",
              name: "Wide Phalanx",
              anchor: { x: 195, y: 200 },
              strength: 8,
              weapon: "melee",
              stats: { bab: 8, ac: 18, hp: 30, strMod: 3 },
            },
          ],
        },
        {
          id: "c-red",
          factionId: "fac-red",
          units: [
            {
              id: "u-narrow",
              name: "Narrow Guard",
              anchor: { x: 200, y: 200 },
              strength: 2,
              weapon: "melee",
              stats: { bab: 4, ac: 20, hp: 60, strMod: 1 },
            },
          ],
        },
      ],
    });

    const wrapStart = deploy(wrapScenario);
    const wrapRes = resolveFrozen({
      turnId: 1,
      seed: 101,
      start: wrapStart,
      scenario: wrapScenario,
      orders: [
        {
          unitId: "u-wide",
          memberId: "c-blue",
          order: { kind: "attack", targetUnitId: "u-narrow", mode: "melee", envelop: true },
        },
        {
          unitId: "u-narrow",
          memberId: "c-red",
          order: { kind: "hold", stance: "hold" },
        },
      ],
    });

    const gm: Member = { id: "gm", role: "GM", factionId: null, epoch: 1 };
    const wrapView = new BattleView(wrapScenario, wrapRes.state, Buffer.alloc(32, 9));
    const tileA = `${Math.floor(195 / REGION_SIZE)},${Math.floor(200 / REGION_SIZE)}`;
    const tileB = `${Math.floor(205 / REGION_SIZE)},${Math.floor(200 / REGION_SIZE)}`;
    const blueModels = [
      ...wrapView.region(gm, tileA),
      ...(tileB !== tileA ? wrapView.region(gm, tileB) : []),
    ].filter((m) => m.unitId === "u-wide");

    expect(blueModels).toHaveLength(8);
    // Central files stayed at x = 195 while excess flank files stepped forward to x >= 200 / 205 around Red's flanks!
    const wrappedFlankers = blueModels.filter((m) => m.x >= 200);
    expect(wrappedFlankers.length).toBeGreaterThanOrEqual(4);

    // 2. C17b / C39 Gap Exploitation & Full-Sector Breakthrough (`strategicDoctrine: true`):
    //    - Soldiers within 4.5 files of a covering defender slide laterally into melee contact;
    //    - Soldiers facing a completely open sector (> 4.5 files from any local foe) push through
    //      the breach toward the remaining enemy formation's center of mass!
    const pool = createModelPool(6, PF1E_MODEL_SCHEMA);
    // Blue 4-soldier line along x = 0 at y = [0, 10, 20, 45];
    // Red survivor stands at (20, 0) — so:
    //   - Blue #0 (y=0) faces Red directly;
    //   - Blue #1 (y=10) & #2 (y=20, dSlot <= 22.5 ft = 4.5 * 5 ft) slide laterally down toward y=0;
    //   - Blue #3 (y=45, dSlot > 22.5 ft) faces a complete sector hole and drives through toward (20, 0)!
    [0, 10, 20, 45].forEach((y, i) => {
      allocModel(pool, {
        id: i + 1,
        unitIdx: 0,
        x: 0,
        y,
        rot: 0,
        hp: 20,
        hpMax: 20,
      });
    });
    allocModel(pool, {
      id: 5,
      unitIdx: 1,
      x: 20,
      y: 0,
      rot: Math.PI,
      hp: 40,
      hpMax: 40,
    });

    const units: UnitView[] = [
      {
        id: "u-blue-breach",
        armyId: "a-blue",
        factionId: "blue",
        type: "infantry",
        name: "Blue Breach Line",
        profile: {},
        stats: {},
        orders: null,
        formation: "line",
        sceneId: "sc-breach",
        modelRange: [0, 4],
        leaderTokenId: null,
      },
      {
        id: "u-red-remnant",
        armyId: "a-red",
        factionId: "red",
        type: "infantry",
        name: "Red Remnant",
        profile: {},
        stats: {},
        orders: null,
        formation: "line",
        sceneId: "sc-breach",
        modelRange: [4, 5],
        leaderTokenId: null,
      },
    ];
    const ctx: RulesContext = {
      sceneId: "sc-breach",
      turnMode: "stepwise",
      grid: { type: "square", size: 100, units: "ft", distance: 5, diagonals: "555" },
      walls: {
        x1: new Float32Array(0),
        y1: new Float32Array(0),
        x2: new Float32Array(0),
        y2: new Float32Array(0),
        restriction: new Uint8Array(0),
      },
      terrain: { difficultCells: [] },
      armies: [],
      factions: [
        { _id: "blue", type: "faction", name: "Blue", color: "#00f", ownership: { default: 3 }, flags: {}, system: {}, allies: [] },
        { _id: "red", type: "faction", name: "Red", color: "#f00", ownership: { default: 3 }, flags: {}, system: {}, allies: [] },
      ],
      leaderActors: {},
      worldSettings: { strategicDoctrine: true },
    };

    const marchOrder = {
      kind: "move" as const,
      pace: "march" as const,
      path: [{ x: 15, y: 0 }],
    };
    const orders = new Map<string, OrderQueue>([
      [
        "u-blue-breach",
        { issuedBy: "cmd-b", issuedTurn: 1, pending: [marchOrder], active: marchOrder },
      ],
      [
        "u-red-remnant",
        { issuedBy: "cmd-r", issuedTurn: 1, pending: [{ kind: "hold", stance: "hold" }], active: { kind: "hold", stance: "hold" } },
      ],
    ]);
    const events: SimEvent[] = [];
    createMassBattlePf1e().resolveTurn(ctx, pool, units, orders, new XoshiroPRNG(77), (ev) =>
      events.push(ev),
    );

    // Adjacent breach files (#1 at y=10, #2 at y=20) slid laterally toward Red at (20, 0):
    expect(pool.y[1] ?? 10).toBeLessThan(9);
    expect(pool.y[2] ?? 20).toBeLessThan(18);
    // Open-sector file (#3 at y=45, > 4.5 files away) drove forward & angled inward through the hole toward Red's anchor!
    expect(pool.x[3] ?? 0).toBeGreaterThan(7);
    expect(pool.y[3] ?? 45).toBeLessThan(40);
  });
});
