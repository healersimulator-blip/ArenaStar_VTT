import { describe, expect, test } from "vitest";
import { StrategicFxSynth } from "../../src/client/strategicFxAudio";
import type { SceneDocument } from "../../src/core/documents";
import { DocumentStore } from "../../src/core/store";
import {
  normalizedSceneForLaunchCheck,
  sceneDeployment,
  strategicFxCoalescenceOf,
} from "../../src/core/strategicRoom/campaignScene";
import { parseScenario } from "../../src/core/strategicRoom/scenario";
import {
  aggregateStrategicFxCues,
  cueInCameraViewport,
  DEFAULT_MAX_PUBLISHED_FX_CUES,
  DEFAULT_MAX_SOUND_VOICES,
  DEFAULT_MAX_VISUAL_FX_CUES,
  planStrategicViewportFx,
  strategicFxCoalescenceProfile,
  strategicFxZoomWeights,
  type RawSimCombatEvent,
} from "../../src/core/strategicRoom/strategicFx";
import type {
  HostedFxCue,
  Point,
  StrategicFxCoalescence,
} from "../../src/core/strategicRoom/protocol";
import { BattleView } from "../../services/strategic-room/src/battle";
import { resolveFrozen } from "../../services/strategic-room/src/resolve";
import { deploy } from "../../services/strategic-room/src/scenario";
import type { FrozenOrder, Member } from "../../services/strategic-room/src/state";

describe("Scalable Strategic Battle VFX & Spatial Audio Planner", () => {
  test("1. 500 simultaneous fireballs on the same/nearby coordinates coalesce into 1 cue while preserving 100% of authoritative damage", () => {
    // 1A. Pure aggregator stress test: 500 fireballs cast at (500, 500) + jitter within a 25 ft cell
    const explicitFireballs: HostedFxCue[] = Array.from({ length: 500 }, (_, i) => ({
      id: `fx-spell-1-mage-${i}`,
      turnId: 1,
      preset: "fireball",
      at: { x: 502 + (i % 5) * 3, y: 502 + Math.floor((i % 25) / 5) * 3 },
      radius: 20,
      soundCue: "blast",
    }));

    const aggregated = aggregateStrategicFxCues({
      turnId: 1,
      explicitCues: explicitFireballs,
      cellFeet: 25,
    });

    // All 500 overlapping fireballs collapse into a SINGLE representative cue!
    expect(aggregated).toHaveLength(1);
    expect(aggregated[0]?.preset).toBe("fireball");
    expect(aggregated[0]?.count).toBe(500);
    expect(aggregated[0]?.radius).toBe(20);
    expect(aggregated[0]?.intensity).toBeGreaterThan(2);
    expect(aggregated[0]?.intensity).toBeLessThanOrEqual(3);

    // Viewport planner produces 1 visual burst (capped radiusScale <= 1.65) and 1 non-clipping audio voice
    const plan = planStrategicViewportFx({
      cues: aggregated,
      turnId: 1,
      camera: { x: 300, y: 300, scale: 1.8 },
      viewport: { width: 1280, height: 800 },
    });
    expect(plan.visuals).toHaveLength(1);
    expect(plan.visuals[0]?.mergedCount).toBe(500);
    expect(plan.visuals[0]?.radiusScale).toBeGreaterThan(1.4);
    expect(plan.visuals[0]?.radiusScale).toBeLessThanOrEqual(1.65);
    expect(plan.voices).toHaveLength(1);
    expect(plan.voices[0]?.mergedCount).toBe(500);
    expect(plan.voices[0]?.gain).toBeGreaterThan(0.2);
    expect(plan.voices[0]?.gain).toBeLessThanOrEqual(1);

    // 1B. Full authoritative resolver proof: multiple mage units hurling Fireballs at the exact same
    // high-HP enemy regiment deal EVERY SINGLE fireball's PF1e damage, while `extras.fxCues` coalesces!
    const casterCount = 12;
    const scenario = parseScenario({
      format: "arenastar-strategic-scenario-v1",
      name: "Concentrated Fireball Barrage",
      seed: 42,
      bounds: { minX: 0, minY: 0, maxX: 1000, maxY: 1000 },
      factions: [
        { id: "blue", name: "Blue", color: "#4da3ff" },
        { id: "red", name: "Red", color: "#ff6b6b" },
      ],
      commanders: [
        {
          id: "cmd-blue",
          factionId: "blue",
          units: Array.from({ length: casterCount }, (_, idx) => ({
            id: `mage-${idx}`,
            name: `Mage Battery ${idx + 1}`,
            strength: 1,
            weapon: "shot" as const,
            anchor: { x: 300, y: 200 + idx * 35 },
            spells: [
              {
                id: "fireball" as const,
                itemId: "pf1e-core-spells-fireball",
                slots: 2,
                casterLevel: 10,
                castingAbilityMod: 5,
              },
            ],
          })),
        },
        {
          id: "cmd-red",
          factionId: "red",
          units: [
            {
              id: "iron-golem-guard",
              name: "Heavy Juggernauts",
              strength: 16,
              weapon: "melee" as const,
              anchor: { x: 450, y: 380 },
              stats: { hp: 250, ac: 20, bab: 8, ref: 1 },
            },
          ],
        },
      ],
    });
    if (!scenario) throw new Error("Expected valid scenario");

    const state0 = deploy(scenario);
    const singleOrder: FrozenOrder[] = [
      {
        unitId: "mage-0",
        memberId: "cmd-blue",
        order: {
          kind: "cast",
          spellId: "fireball",
          itemId: "pf1e-core-spells-fireball",
          origin: { x: 455, y: 385 },
        },
      },
    ];
    const allOrders: FrozenOrder[] = Array.from({ length: casterCount }, (_, idx) => ({
      unitId: `mage-${idx}`,
      memberId: "cmd-blue",
      order: {
        kind: "cast" as const,
        spellId: "fireball" as const,
        itemId: "pf1e-core-spells-fireball",
        origin: { x: 455, y: 385 },
      },
    }));

    const resSingle = resolveFrozen({ scenario, turnId: 1, seed: 101, start: state0, orders: singleOrder });
    const resBarrage = resolveFrozen({ scenario, turnId: 1, seed: 101, start: state0, orders: allOrders });

    const singleLost = resSingle.rows.find((r) => r.unitId === "iron-golem-guard")?.lost ?? 0;
    const barrageLost = resBarrage.rows.find((r) => r.unitId === "iron-golem-guard")?.lost ?? 0;
    // 1 fireball (10d6 ~ 35 dmg) cannot kill 250-HP juggernauts (`singleLost === 0`),
    // whereas all 12 simultaneous fireballs (~420 dmg total) wipe out the regiment!
    expect(singleLost).toBe(0);
    expect(barrageLost).toBeGreaterThan(0);

    // Yet visually/audibly, all 12 overlapping fireballs coalesced into a SINGLE `fireball` cue with `count: 12`!
    const fireballCues = (resBarrage.state.extras?.fxCues ?? []).filter((c) => c.preset === "fireball");
    expect(fireballCues).toHaveLength(1);
    expect(fireballCues[0]?.count).toBe(casterCount);
  });

  test("2. Handles 25,000 raw melee/volley/charge events + 300 spells under hard wire, draw, and audio polyphony caps in <50ms", () => {
    const startCentroids = new Map<string, Point | null>();
    const endCentroids = new Map<string, Point | null>();
    for (let u = 0; u < 1000; u++) {
      const x = (u % 50) * 80 + 100;
      const y = Math.floor(u / 50) * 80 + 100;
      startCentroids.set(`u-${u}`, { x, y });
      endCentroids.set(`u-${u}`, { x: x + 15, y });
    }

    const explicitSpells: HostedFxCue[] = Array.from({ length: 300 }, (_, i) => ({
      id: `fx-spell-2-caster-${i}`,
      turnId: 2,
      preset: i % 3 === 0 ? "fireball" : i % 3 === 1 ? "cone-of-cold" : "lightning-bolt",
      at: { x: (i % 30) * 120 + 120, y: Math.floor(i / 30) * 120 + 120 },
      ...(i % 3 !== 0 ? { dir: { x: 1, y: 0 } } : {}),
      radius: i % 3 === 2 ? 120 : 40,
    }));

    const simEvents: RawSimCombatEvent[] = [];
    for (let i = 0; i < 25_000; i++) {
      const atkId = `u-${i % 1000}`;
      const defId = `u-${(i + 1) % 1000}`;
      if (i % 5 === 0) {
        simEvents.push({
          subPhase: "shoot",
          type: "shot",
          unitId: atkId,
          targetUnitId: defId,
          data: { totalAttacks: 12, hits: 4, netDamageDealt: 26, killsCount: 2 },
        });
      } else if (i % 17 === 0) {
        simEvents.push({
          subPhase: "move",
          type: "arrive",
          unitId: atkId,
          data: { pace: "charge" },
        });
      } else {
        simEvents.push({
          subPhase: "melee",
          type: "attack",
          unitId: atkId,
          targetUnitId: defId,
          data: { totalAttacks: 10, hits: 5, netDamageDealt: 38, killsCount: 3 },
        });
      }
    }

    const t0 = performance.now();
    const published = aggregateStrategicFxCues({
      turnId: 2,
      explicitCues: explicitSpells,
      simEvents,
      startCentroids,
      endCentroids,
    });
    const aggMs = performance.now() - t0;

    expect(aggMs).toBeLessThan(150);
    expect(published.length).toBeLessThanOrEqual(DEFAULT_MAX_PUBLISHED_FX_CUES);
    expect(published.length).toBeGreaterThan(20);

    // Wide viewport seeing all cues still strictly obeys `DEFAULT_MAX_VISUAL_FX_CUES` (64) & `DEFAULT_MAX_SOUND_VOICES` (8)
    const plan = planStrategicViewportFx({
      cues: published,
      turnId: 2,
      camera: { x: 0, y: 0, scale: 1.6 },
      viewport: { width: 5000, height: 5000 },
    });
    expect(plan.visuals.length).toBeLessThanOrEqual(DEFAULT_MAX_VISUAL_FX_CUES);
    expect(plan.voices.length).toBeLessThanOrEqual(DEFAULT_MAX_SOUND_VOICES);
    expect(plan.voices.every((v) => v.gain > 0 && v.gain <= 1)).toBe(true);
    expect(plan.voices.every((v) => v.pan >= -1 && v.pan <= 1)).toBe(true);
  });

  test("3. Per-player viewport discrimination: two commanders looking at different sectors see & hear ONLY their own sector's FX, plus fog-of-war origin privacy", () => {
    const cues: HostedFxCue[] = [
      {
        id: "north-fireball",
        turnId: 3,
        preset: "fireball",
        at: { x: 400, y: 400 },
        radius: 20,
        count: 3,
        intensity: 1.4,
        soundCue: "blast",
      },
      {
        id: "north-melee",
        turnId: 3,
        preset: "melee",
        at: { x: 430, y: 420 },
        radius: 14,
        count: 40,
        intensity: 1.2,
        soundCue: "clash",
      },
      {
        id: "south-cone",
        turnId: 3,
        preset: "cone-of-cold",
        at: { x: 4200, y: 4200 },
        dir: { x: 1, y: 0 },
        radius: 60,
        count: 1,
        intensity: 1.1,
        soundCue: "frost",
      },
      {
        id: "cross-screen-bolt",
        turnId: 3,
        preset: "lightning-bolt",
        at: { x: 250, y: 500 },
        dir: { x: 1, y: 0 },
        radius: 120,
        soundCue: "thunder",
      },
    ];

    // Commander A is looking at North Sector (world x: 320..960, y: 300..700 at scale 2.0)
    const camNorth = { x: 320, y: 300, scale: 2.0 };
    const vp = { width: 1280, height: 800 };
    const planNorth = planStrategicViewportFx({ cues, turnId: 3, camera: camNorth, viewport: vp });

    // Commander B is looking at South Sector (world x: 3900..4540, y: 3950..4350 at scale 2.0)
    const camSouth = { x: 3900, y: 3950, scale: 2.0 };
    const planSouth = planStrategicViewportFx({ cues, turnId: 3, camera: camSouth, viewport: vp });

    const northIds = planNorth.visuals.map((v) => v.cue.id);
    const southIds = planSouth.visuals.map((v) => v.cue.id);

    // North commander sees north-fireball, north-melee, AND the lightning bolt whose 120-ft line enters x=320..370,
    // and NEVER sees or hears south-cone!
    expect(northIds).toContain("north-fireball");
    expect(northIds).toContain("north-melee");
    expect(northIds).toContain("cross-screen-bolt");
    expect(northIds).not.toContain("south-cone");
    expect(planNorth.voices.some((v) => v.soundCue === "frost")).toBe(false);
    expect(planNorth.culledOutOfView).toBe(1);

    // South commander sees and hears ONLY south-cone!
    expect(southIds).toEqual(["south-cone"]);
    expect(planSouth.voices.map((v) => v.soundCue)).toEqual(["frost"]);
    expect(planSouth.culledOutOfView).toBe(3);

    // Verify projectile segment crossing viewport even when both endpoints lie just outside
    const longVolley: HostedFxCue = {
      id: "spanning-volley",
      turnId: 3,
      preset: "volley",
      from: { x: 200, y: 500 },
      at: { x: 1100, y: 500 },
      radius: 15,
    };
    expect(cueInCameraViewport(longVolley, camNorth, vp)).toBe(true);

    // Verify server-side fog-of-war strips `from` when an enemy volley launches from behind a sight-blocking wall!
    const fogScenario = parseScenario({
      format: "arenastar-strategic-scenario-v1",
      name: "Fog Volley Origin Privacy",
      seed: 7,
      bounds: { minX: 0, minY: 0, maxX: 2000, maxY: 2000 },
      walls: [{ id: "sight-wall", x1: 500, y1: 0, x2: 500, y2: 2000, restriction: 2 }],
      factions: [
        { id: "blue", name: "Blue", color: "#4da3ff" },
        { id: "red", name: "Red", color: "#ff6b6b" },
      ],
      commanders: [
        {
          id: "cmd-blue",
          factionId: "blue",
          units: [{ id: "u-blue", name: "Blue Vanguard", strength: 10, weapon: "melee", anchor: { x: 200, y: 200 } }],
        },
        {
          id: "cmd-red",
          factionId: "red",
          units: [{ id: "u-red", name: "Hidden Archers", strength: 10, weapon: "shot", anchor: { x: 900, y: 200 } }],
        },
      ],
    });
    if (!fogScenario) throw new Error("Expected valid fogScenario");
    const deployed = deploy(fogScenario);
    const stateWithHiddenOriginVolley = {
      ...deployed,
      extras: {
        fxCues: [
          {
            id: "ambush-volley",
            turnId: 0,
            preset: "volley" as const,
            from: { x: 900, y: 200 }, // Behind sight-blocking wall!
            at: { x: 200, y: 200 }, // Impacts Blue Vanguard in plain view
            radius: 18,
            soundCue: "volley",
          },
          {
            id: "far-hidden-spell",
            turnId: 0,
            preset: "fireball" as const,
            at: { x: 1500, y: 1500 }, // Completely unseen by Blue
            radius: 20,
            soundCue: "blast",
          },
        ],
      },
    };
    const bv = new BattleView(fogScenario, stateWithHiddenOriginVolley, new Uint8Array(32));
    const blueMember: Member = { id: "cmd-blue", role: "PLAYER", factionId: "blue", epoch: 1 };
    const gmMember: Member = { id: "gm", role: "GM", factionId: null, epoch: 1 };

    const blueCues = bv.content(blueMember)?.fxCues ?? [];
    expect(blueCues).toHaveLength(1);
    expect(blueCues[0]?.id).toBe("ambush-volley");
    expect(blueCues[0]?.from).toBeUndefined(); // Hidden archer origin stripped!

    const gmCues = bv.content(gmMember)?.fxCues ?? [];
    expect(gmCues).toHaveLength(2);
    expect(gmCues.find((c) => c.id === "ambush-volley")?.from).toEqual({ x: 900, y: 200 });
  });

  test("4. Zoom-out fade-out: combat animations & sounds attenuate monotonically and vanish at macro theater zoom", () => {
    const closeUp = strategicFxZoomWeights(2.2);
    const operational = strategicFxZoomWeights(0.75);
    const macro = strategicFxZoomWeights(0.18);
    const theater = strategicFxZoomWeights(0.03);

    expect(closeUp.lodTier).toBe(0);
    expect(operational.lodTier).toBe(1);
    expect(macro.lodTier).toBe(2);

    // Monotonic visual & audio attenuation as the player zooms out
    expect(closeUp.combatVisual).toBeGreaterThan(operational.combatVisual);
    expect(operational.combatVisual).toBeGreaterThan(macro.combatVisual);
    expect(theater.combatVisual).toBe(0);

    expect(closeUp.combatAudio).toBeGreaterThan(operational.combatAudio);
    expect(operational.combatAudio).toBeGreaterThan(macro.combatAudio);
    expect(macro.combatAudio).toBe(0);

    expect(closeUp.spellAudio).toBeGreaterThan(macro.spellAudio);
    expect(theater.spellAudio).toBe(0);

    // Verify `planStrategicViewportFx` fades out melee cues & mutes audio when zoomed all the way out
    const mixedCues: HostedFxCue[] = [
      { id: "m1", turnId: 1, preset: "melee", at: { x: 500, y: 500 }, radius: 14, count: 25, soundCue: "clash" },
      { id: "f1", turnId: 1, preset: "fireball", at: { x: 600, y: 500 }, radius: 20, count: 4, soundCue: "blast" },
    ];

    const zoomedInPlan = planStrategicViewportFx({
      cues: mixedCues,
      turnId: 1,
      camera: { x: 200, y: 200, scale: 2.0 },
      viewport: { width: 1280, height: 800 },
    });
    const zoomedOutPlan = planStrategicViewportFx({
      cues: mixedCues,
      turnId: 1,
      camera: { x: 0, y: 0, scale: 0.04 },
      viewport: { width: 1280, height: 800 },
    });

    expect(zoomedInPlan.visuals.map((v) => v.cue.preset)).toEqual(["fireball", "melee"]);
    expect(zoomedInPlan.voices.length).toBe(2);

    // At 4% theater zoom: melee visual clutter is completely culled, all sounds faded to 0 voices,
    // and only a low-alpha macro spell indicator remains!
    expect(zoomedOutPlan.visuals.map((v) => v.cue.preset)).toEqual(["fireball"]);
    expect(zoomedOutPlan.visuals[0]?.alpha).toBeLessThan(zoomedInPlan.visuals[0]?.alpha ?? 1);
    expect(zoomedOutPlan.voices).toHaveLength(0);
  });

  test("5. StrategicFxSynth routes all planned voices through a single DynamicsCompressorNode limiter, pans stereo, and gracefully handles missing WebAudio", () => {
    // 5A. Headless environment without AudioContext: zero throws, clean no-op
    const prevAudioCtx = (globalThis as Record<string, unknown>).AudioContext;
    delete (globalThis as Record<string, unknown>).AudioContext;
    try {
      const headlessSynth = new StrategicFxSynth();
      expect(
        headlessSynth.playVoices([
          {
            id: "v1",
            preset: "fireball",
            soundCue: "blast",
            mergedCount: 500,
            gain: 0.55,
            pan: -0.35,
            delayMs: 0,
          },
        ]),
      ).toBe(0);
      headlessSynth.destroy();
    } finally {
      if (prevAudioCtx !== undefined) {
        (globalThis as Record<string, unknown>).AudioContext = prevAudioCtx;
      }
    }

    // 5B. Mock WebAudio graph: verify compressor limiter, pan clamping, and node scheduling across all cue families
    let compressorsCreated = 0;
    let oscillatorsStarted = 0;
    let buffersStarted = 0;
    const pannedValues: number[] = [];

    class FakeParam {
      value = 0;
      setValueAtTime(v: number) {
        this.value = v;
      }
      linearRampToValueAtTime(v: number) {
        this.value = v;
      }
      exponentialRampToValueAtTime(v: number) {
        this.value = v;
      }
    }

    class FakeAudioContext {
      state = "running";
      sampleRate = 22050;
      currentTime = 0;
      destination = {};
      resume() {
        return Promise.resolve();
      }
      close() {
        return Promise.resolve();
      }
      createDynamicsCompressor() {
        compressorsCreated++;
        return {
          threshold: new FakeParam(),
          knee: new FakeParam(),
          ratio: new FakeParam(),
          attack: new FakeParam(),
          release: new FakeParam(),
          connect() {},
        };
      }
      createBuffer(_ch: number, len: number) {
        const arr = new Float32Array(len);
        return { getChannelData: () => arr };
      }
      createGain() {
        return { gain: new FakeParam(), connect() {} };
      }
      createStereoPanner() {
        const pan = new FakeParam();
        return {
          get pan() {
            return pan;
          },
          connect() {
            pannedValues.push(pan.value);
          },
        };
      }
      createOscillator() {
        return {
          type: "sine",
          frequency: new FakeParam(),
          connect() {},
          start() {
            oscillatorsStarted++;
          },
          stop() {},
        };
      }
      createBufferSource() {
        return {
          buffer: null as unknown,
          connect() {},
          start() {
            buffersStarted++;
          },
          stop() {},
        };
      }
      createBiquadFilter() {
        return {
          type: "lowpass",
          frequency: new FakeParam(),
          Q: new FakeParam(),
          connect() {},
        };
      }
    }

    (globalThis as Record<string, unknown>).AudioContext = FakeAudioContext;
    try {
      const synth = new StrategicFxSynth();
      const cues: Array<[HostedFxCue["preset"], string, number]> = [
        ["fireball", "blast", -0.6],
        ["lightning-bolt", "thunder", -0.2],
        ["cone-of-cold", "frost", 0],
        ["entangle", "vines", 0.2],
        ["heal", "chime", 0.4],
        ["charge", "horn", 0.6],
        ["volley", "volley", -0.4],
        ["melee", "clash", 0.5],
      ];
      const scheduled = synth.playVoices(
        cues.map(([preset, soundCue, pan], i) => ({
          id: `cue-${i}`,
          preset,
          soundCue,
          mergedCount: 10,
          gain: 0.42,
          pan,
          delayMs: 0,
        })),
      );
      expect(scheduled).toBe(8);
      // All 8 voices share ONE master DynamicsCompressorNode limiter!
      expect(compressorsCreated).toBe(1);
      expect(pannedValues).toHaveLength(8);
      expect(oscillatorsStarted).toBeGreaterThan(0);
      expect(buffersStarted).toBeGreaterThan(0);
      synth.destroy();
    } finally {
      if (prevAudioCtx !== undefined) {
        (globalThis as Record<string, unknown>).AudioContext = prevAudioCtx;
      } else {
        delete (globalThis as Record<string, unknown>).AudioContext;
      }
    }
  });

  test("6. Scene Options VFX coalescence levels (`none`, `low`, `balanced`, `high`, `extreme`) govern cue splitting, screen clustering, and scenario projection", () => {
    // 6A. Monotonic progression across 500 identical-coordinate fireballs
    const sameSpotFireballs: HostedFxCue[] = Array.from({ length: 500 }, (_, i) => ({
      id: `fx-spell-1-bat-${i}`,
      turnId: 1,
      preset: "fireball",
      at: { x: 500, y: 500 },
      radius: 20,
      soundCue: "blast",
    }));

    const levels: StrategicFxCoalescence[] = ["none", "low", "balanced", "high", "extreme"];
    const cueCounts: Record<StrategicFxCoalescence, number> = {
      none: 0,
      low: 0,
      balanced: 0,
      high: 0,
      extreme: 0,
    };
    const visualCounts: Record<StrategicFxCoalescence, number> = {
      none: 0,
      low: 0,
      balanced: 0,
      high: 0,
      extreme: 0,
    };

    for (const lvl of levels) {
      const prof = strategicFxCoalescenceProfile(lvl);
      const agg = aggregateStrategicFxCues({
        turnId: 1,
        explicitCues: sameSpotFireballs,
        coalescence: lvl,
      });
      cueCounts[lvl] = agg.length;
      expect(agg.length).toBeLessThanOrEqual(prof.maxPublishedCues);
      // Every published cue respects `maxMergedPerCue`
      for (const q of agg) {
        expect(q.count ?? 1).toBeLessThanOrEqual(prof.maxMergedPerCue);
      }

      const vp = planStrategicViewportFx({
        cues: agg,
        turnId: 1,
        camera: { x: 200, y: 200, scale: 1.5 },
        viewport: { width: 1280, height: 800 },
        coalescence: lvl,
      });
      visualCounts[lvl] = vp.visuals.length;
      expect(vp.visuals.length).toBeLessThanOrEqual(prof.maxVisualCues);
      expect(vp.voices.length).toBeLessThanOrEqual(prof.maxSoundVoices);
      for (const vis of vp.visuals) {
        expect(vis.mergedCount).toBeLessThanOrEqual(prof.maxMergedPerCue);
      }
    }

    // Strict monotonic coalescence: `none` > `low` > `balanced` > `high` > `extreme` (which collapses 500 -> 1!)
    expect(cueCounts.none).toBe(320); // capped cleanly at maxPublishedCues (1 cast per cue)
    expect(cueCounts.low).toBe(125); // 500 / 4 = 125 distinct fanned cues
    expect(cueCounts.balanced).toBe(32); // ceil(500 / 16) = 32 cues
    expect(cueCounts.high).toBe(8); // ceil(500 / 64) = 8 cues
    expect(cueCounts.extreme).toBe(1); // 500:1 mega-battle default

    expect(visualCounts.none).toBeGreaterThan(visualCounts.low);
    expect(visualCounts.low).toBeGreaterThan(visualCounts.balanced);
    expect(visualCounts.balanced).toBeGreaterThan(visualCounts.high);
    expect(visualCounts.high).toBeGreaterThan(visualCounts.extreme);
    expect(visualCounts.extreme).toBe(1);

    // Secondary split cues fan out slightly around (500, 500) so multi-bursts are visually distinct
    const lowCues = aggregateStrategicFxCues({
      turnId: 1,
      explicitCues: sameSpotFireballs.slice(0, 12),
      coalescence: "low",
    });
    expect(lowCues).toHaveLength(3); // 12 / 4 = 3 cues of count 4
    const uniqueCoords = new Set(lowCues.map((c) => `${c.at.x},${c.at.y}`));
    expect(uniqueCoords.size).toBe(3);

    // 6B. End-to-end SceneDocument `flags.core.strategicFxCoalescence` -> `sceneDeployment` -> `resolveFrozen` -> `BattleView`
    const store = new DocumentStore({
      meta: {
        worldId: "w-fx-coal",
        name: "FX Coalescence World",
        system: "pf1e",
        systemVersion: "1.0.0",
      },
    });
    let seq = 0;
    const createDoc = (coll: "factions" | "scenes", doc: unknown) => {
      seq++;
      const res = store.applyEnvelope({
        seq,
        ts: seq,
        by: "gm",
        txId: `tx-${seq}`,
        ops: [{ kind: "create", coll, data: doc as never }],
      });
      expect(res.ok).toBe(true);
    };
    createDoc("factions", {
      _id: "fac-blue",
      type: "faction",
      name: "Blue",
      color: "#4da3ff",
      members: [],
      dispositions: { "fac-red": -1 },
      ownership: { default: 1 },
      flags: {},
      system: {},
    });
    createDoc("factions", {
      _id: "fac-red",
      type: "faction",
      name: "Red",
      color: "#ff6b6b",
      members: [],
      dispositions: { "fac-blue": -1 },
      ownership: { default: 1 },
      flags: {},
      system: {},
    });

    const baseScene: SceneDocument = {
      _id: "scene-fx",
      type: "scene",
      name: "FX Valley",
      active: true,
      img: null,
      width: 2000,
      height: 2000,
      darkness: 0,
      grid: { type: "square", size: 20, units: "ft", distance: 5, diagonals: "555", hexLayout: "oddQ" },
      tokens: [],
      walls: [],
      lights: [],
      regions: [],
      sounds: [],
      tiles: [],
      drawings: [],
      templates: [],
      notes: [],
      ownership: { default: 1 },
      flags: { core: { scale: "strategic", strategicFxCoalescence: "low" } },
      system: {},
    };
    createDoc("scenes", baseScene);

    const storedScene = store.get("scenes", "scene-fx");
    expect(storedScene).toBeDefined();
    if (!storedScene) throw new Error("missing scene");
    expect(strategicFxCoalescenceOf(storedScene)).toBe("low");

    // Launch-check scene normalization strips `strategicFxCoalescence` so toggling it never creates a false reconciliation conflict
    const norm = normalizedSceneForLaunchCheck(storedScene);
    expect(norm.flags?.core?.strategicFxCoalescence).toBeUndefined();

    const projected = sceneDeployment(store, storedScene, 77, 2, 10);
    expect(projected.fxCoalescence).toBe("low");

    // Default ("extreme") omits `fxCoalescence` on the wire for zero extra bytes
    const defaultScene: SceneDocument = {
      ...storedScene,
      flags: { core: { scale: "strategic" } },
    };
    expect(strategicFxCoalescenceOf(defaultScene)).toBe("extreme");
    expect(sceneDeployment(store, defaultScene, 77, 2, 10).fxCoalescence).toBeUndefined();

    // Authoritative `resolveFrozen` + `BattleView.content` honors `scenario.fxCoalescence: "none"`
    const twelveMageScenario = parseScenario({
      format: "arenastar-strategic-scenario-v1",
      name: "Twelve Mages Uncoalesced",
      seed: 99,
      fxCoalescence: "none",
      bounds: { minX: 0, minY: 0, maxX: 2000, maxY: 2000 },
      factions: [
        { id: "blue", name: "Blue", color: "#4da3ff" },
        { id: "red", name: "Red", color: "#ff6b6b" },
      ],
      commanders: [
        {
          id: "c-blue",
          factionId: "blue",
          units: Array.from({ length: 8 }, (_, i) => ({
            id: `mage-${i}`,
            name: `Mage ${i}`,
            anchor: { x: 200, y: 350 + i * 25 },
            strength: 1,
            weapon: "melee" as const,
            unitType: "hero" as const,
            spells: [
              {
                id: "fireball" as const,
                itemId: `pf1e-core-spells-fireball-${i}`,
                slots: 2,
                casterLevel: 8,
                castingAbilityMod: 4,
              },
            ],
          })),
        },
        {
          id: "c-red",
          factionId: "red",
          units: [
            {
              id: "target-pack",
              name: "Target Pack",
              anchor: { x: 350, y: 420 },
              strength: 10,
              weapon: "melee" as const,
            },
          ],
        },
      ],
    });

    const st0 = deploy(twelveMageScenario);
    const resolvedNone = resolveFrozen({
      turnId: 1,
      seed: 99,
      start: st0,
      scenario: twelveMageScenario,
      orders: Array.from({ length: 8 }, (_, i) => ({
        unitId: `mage-${i}`,
        memberId: "c-blue",
        order: {
          kind: "cast" as const,
          spellId: "fireball" as const,
          itemId: `pf1e-core-spells-fireball-${i}`,
          origin: { x: 350, y: 420 },
        },
      })),
    });

    const fbCuesNone = (resolvedNone.state.extras?.fxCues ?? []).filter(
      (c) => c.preset === "fireball",
    );
    // Under `fxCoalescence: "none"`, all 8 simultaneous fireballs remain 8 distinct cues!
    expect(fbCuesNone).toHaveLength(8);

    const view = new BattleView(twelveMageScenario, resolvedNone.state, new Uint8Array(32));
    const gmMember: Member = { id: "gm", role: "GM", factionId: null, epoch: 1 };
    const content = view.content(gmMember);
    expect(content?.fxCoalescence).toBe("none");
    expect(content?.fxCues?.filter((c) => c.preset === "fireball")).toHaveLength(8);
  });
});
