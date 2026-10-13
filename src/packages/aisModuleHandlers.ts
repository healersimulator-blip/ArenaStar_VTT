import type { IDBPDatabase } from "idb";
import type {
  ActorDocument,
  Json,
  LightAnimation,
  MessageDocument,
  SceneDocument,
  TokenDocument,
} from "../core/documents";
import type { AisCapability, AisEventName, AisTokenLightSnapshot } from "../core/automationInterconnect";
import type { AisModuleCallContext } from "./aisModuleIframe";
import type { Op } from "../core/ops";
import { parseLightAnimation } from "../core/lightAnimation";
import { getAllSettings, getSetting, putSetting } from "../storage/idb";
import type { AisModuleHandlers } from "./aisModuleIframe";

const MAX_STORAGE_BYTES = 128 * 1024;
const MAX_STORAGE_KEYS = 256;
const MAX_STORAGE_VALUE_BYTES = 16 * 1024;
const STORAGE_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const EVENT_NAMES = new Set<AisEventName>([
  "world.snapshot",
  "world.ops.committed",
  "scene.token.light.changed",
  "turn.phase.changed",
  "turn.report.committed",
  "ui.token.action",
  "module.event",
]);

export interface AisModuleSelectOption {
  value: string;
  label: string;
  description?: string;
}

export interface AisModuleSelectRequest {
  title: string;
  description?: string;
  options: AisModuleSelectOption[];
}

export interface AisModuleHandlerContext {
  worldId: string;
  packageId: string;
  /** Package-local event ids declared by the exact, approved manifest. */
  emittedEvents: readonly string[];
  db: IDBPDatabase;
  user: () => { id: string; name: string };
  /** Private host-side scene view; each read API returns only an explicit projection. */
  activeScene: () => SceneDocument | null;
  /** Host-side actor lookup; module APIs expose only bounded inventory fields. */
  actorById: (id: string) => ActorDocument | undefined;
  /** Opens a host-rendered, text-only choice dialog; null means the user cancelled. */
  select: (request: AisModuleSelectRequest) => Promise<string | null>;
  submit: (ops: Op[]) => string;
  notify: (message: string, level: "info" | "warn" | "error") => void;
  emitModuleEvent: (eventId: string, payload: Json) => void;
  newId: (prefix: string) => string;
  /** Re-checks the exact profile lock and local hash-bound consent on each host request. */
  assertCapability: (capability: AisCapability) => Promise<void>;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function byteLength(value: unknown): number | null {
  try {
    const text = JSON.stringify(value);
    return text === undefined ? null : new TextEncoder().encode(text).byteLength;
  } catch {
    return null;
  }
}

function boundedJson(value: unknown, depth = 0, seen = new Set<object>()): value is Json {
  if (depth > 12) return false;
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object") return false;
  if (seen.has(value)) return false;
  seen.add(value);
  let valid: boolean;
  if (Array.isArray(value)) {
    valid = value.length <= 1024 && value.every((item) => boundedJson(item, depth + 1, seen));
  } else {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record);
    valid = keys.length <= 1024 && keys.every((key) =>
      key !== "__proto__" && key !== "constructor" && boundedJson(record[key], depth + 1, seen),
    );
  }
  seen.delete(value);
  return valid;
}

function storageScope(ctx: AisModuleHandlerContext): string {
  return `ais:${ctx.worldId}:${ctx.packageId}`;
}

function storageKey(value: unknown): string {
  if (typeof value !== "string" || !STORAGE_KEY_RE.test(value))
    throw new Error("module storage key must be 1–64 safe characters");
  return value;
}

function safeId(value: unknown, label: string): string {
  if (typeof value !== "string" || !SAFE_ID_RE.test(value))
    throw new Error(`${label} must be 1–128 safe characters`);
  return value;
}

function plainText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Identical bounded token-light projection for scene reads and post-commit light-change hooks. */
export function projectAisTokenLight(token: Pick<TokenDocument, "light">): AisTokenLightSnapshot {
  const raw = token.light as unknown as Record<string, unknown>;
  const radius = Math.max(0, Math.min(100_000, finite(raw.radius) ?? 0));
  const bright = Math.max(0, Math.min(radius, finite(raw.bright) ?? radius / 2));
  const alpha = Math.max(0, Math.min(1, finite(raw.alpha) ?? 0));
  const angle = Math.max(1, Math.min(360, finite(raw.angle) ?? 360));
  const animation = parseLightAnimation(raw.animation);
  return {
    radius, bright,
    color: typeof raw.color === "string" && /^#[0-9a-f]{6}$/i.test(raw.color) ? raw.color.toLowerCase() : "#ffffff",
    alpha, angle,
    ...(animation.ok && animation.value ? { animation: animation.value } : {}),
  };
}

function assertCommandActive(context?: AisModuleCallContext): void {
  context?.assertActive();
}

function inventoryQuantity(item: ActorDocument["items"][number]): number {
  const system = asRecord(item.system) ?? {};
  const foundry = asRecord(system.foundry) ?? {};
  const raw = system.quantity ?? foundry.quantity;
  const value = finite(raw);
  return value === null ? 1 : Math.max(0, Math.floor(value));
}

function selectRequest(args: Record<string, unknown>): AisModuleSelectRequest {
  if (typeof args.title !== "string" || args.title.trim().length === 0 || args.title.length > 120)
    throw new Error("ui.select title must be 1–120 characters");
  if (args.description !== undefined && (typeof args.description !== "string" || args.description.length > 400))
    throw new Error("ui.select description must be at most 400 characters");
  if (!Array.isArray(args.options) || args.options.length === 0 || args.options.length > 32)
    throw new Error("ui.select needs 1–32 choices");
  const seen = new Set<string>();
  const options: AisModuleSelectOption[] = [];
  for (const row of args.options) {
    const option = asRecord(row);
    if (!option || Object.keys(option).some((key) => !["value", "label", "description"].includes(key)))
      throw new Error("ui.select choice has an unsupported field");
    const value = safeId(option.value, "ui.select choice value");
    if (seen.has(value)) throw new Error(`ui.select repeats choice ${value}`);
    if (typeof option.label !== "string" || option.label.trim().length === 0 || option.label.length > 120)
      throw new Error("ui.select choice label must be 1–120 characters");
    if (option.description !== undefined && (typeof option.description !== "string" || option.description.length > 300))
      throw new Error("ui.select choice description must be at most 300 characters");
    seen.add(value);
    options.push({
      value,
      label: option.label,
      ...(option.description === undefined ? {} : { description: option.description }),
    });
  }
  return {
    title: args.title,
    ...(args.description === undefined ? {} : { description: args.description as string }),
    options,
  };
}

function lightSpec(args: Record<string, unknown>): {
  radius: number;
  bright: number;
  color: string;
  alpha: number;
  angle: number;
  animation: LightAnimation | null;
} {
  const raw = asRecord(args.light);
  if (!raw || Object.keys(raw).some((key) => !["radius", "bright", "color", "alpha", "angle", "animation"].includes(key)))
    throw new Error("token light must contain only radius, bright, color, alpha, angle, and animation");
  const radius = finite(raw.radius);
  const bright = finite(raw.bright);
  const alpha = finite(raw.alpha);
  const angle = finite(raw.angle);
  if (radius === null || radius < 0 || radius > 100_000)
    throw new Error("token light radius must be between 0 and 100000 scene pixels");
  if (bright === null || bright < 0 || bright > radius)
    throw new Error("token light bright radius must be between 0 and its dim radius");
  if (typeof raw.color !== "string" || !/^#[0-9a-f]{6}$/i.test(raw.color))
    throw new Error("token light colour must be #rrggbb");
  if (alpha === null || alpha < 0 || alpha > 1)
    throw new Error("token light alpha must be between 0 and 1");
  if (angle === null || angle < 1 || angle > 360)
    throw new Error("token light angle must be between 1 and 360 degrees");
  const animation = parseLightAnimation(raw.animation);
  if (!animation.ok) throw new Error(animation.error);
  return { radius, bright, color: raw.color.toLowerCase(), alpha, angle, animation: animation.value };
}

/** Capability-checked AIS APIs shared by all approved module iframes. */
export function createAisModuleHandlers(ctx: AisModuleHandlerContext): AisModuleHandlers {
  return {
    "events.subscribe": async ({ event }, commandContext) => {
      await ctx.assertCapability("action.observe");
      assertCommandActive(commandContext);
      if (typeof event !== "string" || !EVENT_NAMES.has(event as AisEventName))
        throw new Error("event is not part of the AIS v1 catalog");
      return { ok: true };
    },
    "events.emit": async ({ eventId: rawEventId, payload }, commandContext) => {
      await ctx.assertCapability("event.emit");
      assertCommandActive(commandContext);
      const eventId = safeId(rawEventId, "eventId");
      if (!ctx.emittedEvents.includes(eventId))
        throw new Error(`event ${eventId} is not declared by ${ctx.packageId}`);
      if (!boundedJson(payload) || (byteLength(payload) ?? Infinity) > 16 * 1024)
        throw new Error("event payload must be bounded JSON no larger than 16 KiB");
      ctx.emitModuleEvent(eventId, payload);
      return { ok: true };
    },
    "scene.read.visible": async (_args, commandContext) => {
      await ctx.assertCapability("scene.read.visible");
      assertCommandActive(commandContext);
      const scene = ctx.activeScene();
      if (!scene) return null;
      return {
        id: scene._id,
        name: scene.name,
        grid: {
          size: Number.isFinite(scene.grid?.size) && scene.grid.size > 0 ? scene.grid.size : 100,
          distance: Number.isFinite(scene.grid?.distance) && scene.grid.distance > 0 ? scene.grid.distance : 5,
          units: typeof scene.grid?.units === "string" ? scene.grid.units : "ft",
        },
        tokens: scene.tokens.filter((token) => !token.hidden).map((token) => {
          const ais = asRecord(token.flags?.ais) ?? {};
          const state = ais[ctx.packageId];
          return {
            id: token._id,
            name: token.name,
            x: token.x,
            y: token.y,
            rotation: Number.isFinite(token.rotation) ? token.rotation : 0,
            ...(token.actorId ? { actorId: token.actorId } : {}),
            light: projectAisTokenLight(token),
            state: boundedJson(state) ? state : null,
          };
        }),
      };
    },
    "actor.inventory.read": async ({ actorId: rawActorId }, commandContext) => {
      await ctx.assertCapability("actor.inventory.read");
      assertCommandActive(commandContext);
      const actorId = safeId(rawActorId, "actorId");
      const actor = ctx.actorById(actorId);
      if (!actor) throw new Error(`unknown actor ${actorId}`);
      return {
        actorId: actor._id,
        actorName: actor.name,
        items: actor.items.slice(0, 1000).map((item) => ({
          id: item._id,
          name: item.name,
          quantity: inventoryQuantity(item),
        })),
      };
    },
    "scene.token.light.apply": async (args, commandContext) => {
      await ctx.assertCapability("scene.token.light.manage");
      assertCommandActive(commandContext);
      const sceneId = safeId(args.sceneId, "sceneId");
      const tokenId = safeId(args.tokenId, "tokenId");
      const sourceId = safeId(args.sourceId, "sourceId");
      if (typeof args.sourceName !== "string" || args.sourceName.trim().length === 0 || args.sourceName.length > 80)
        throw new Error("sourceName must be 1–80 characters");
      if (!Number.isSafeInteger(args.stateIndex) || Number(args.stateIndex) < 0 || Number(args.stateIndex) > 8)
        throw new Error("stateIndex must be an integer from 0 to 8");
      if (typeof args.active !== "boolean") throw new Error("active must be a boolean");
      const light = lightSpec(args);
      if (args.active !== (light.radius > 0))
        throw new Error("active must match whether the token light radius is non-zero");
      const scene = ctx.activeScene();
      if (!scene || scene._id !== sceneId) throw new Error("light action scene is no longer active");
      const token = scene.tokens.find((row) => row._id === tokenId && !row.hidden);
      if (!token) throw new Error("light action token is not visible in the active scene");
      const sourceItemId = args.sourceItemId === undefined || args.sourceItemId === null
        ? undefined
        : safeId(args.sourceItemId, "sourceItemId");
      const consumeItemId = args.consumeItemId === undefined || args.consumeItemId === null
        ? undefined
        : safeId(args.consumeItemId, "consumeItemId");
      if (consumeItemId && (!sourceItemId || sourceItemId !== consumeItemId || !token.actorId))
        throw new Error("a consumed light source must be the selected item on the token's linked actor");

      const ops: Op[] = [];
      if (consumeItemId) {
        await ctx.assertCapability("actor.inventory.consume");
        assertCommandActive(commandContext);
        const actor = token.actorId ? ctx.actorById(token.actorId) : undefined;
        const item = actor?.items.find((row) => row._id === consumeItemId);
        if (!actor || !item) throw new Error("consumable light source is no longer in the token's inventory");
        const quantity = inventoryQuantity(item);
        if (quantity <= 0) throw new Error("light source is exhausted");
        ops.push({
          kind: "update",
          ref: { coll: "items", id: item._id, parent: { coll: "actors", id: actor._id } },
          diff: { "system.quantity": quantity - 1 },
        });
      }

      const state = {
        sourceId,
        sourceName: args.sourceName,
        stateIndex: Number(args.stateIndex),
        active: args.active,
        ...(sourceItemId ? { sourceItemId } : {}),
      } as unknown as Json;
      const flags = structuredClone(token.flags) as unknown as Record<string, Json>;
      const ais = asRecord(flags.ais) as Record<string, Json> | null;
      flags.ais = { ...(ais ?? {}), [ctx.packageId]: state };
      ops.push({
        kind: "update",
        ref: { coll: "tokens", id: token._id, parent: { coll: "scenes", id: scene._id } },
        diff: {
          light: {
            radius: light.radius,
            bright: light.bright,
            color: light.color,
            alpha: light.alpha,
            angle: light.angle,
            animation: light.animation as unknown as Json,
          },
          flags,
        },
      });
      assertCommandActive(commandContext);
      const txId = ctx.submit(ops);
      return { ok: true, txId, active: args.active, sourceName: args.sourceName, stateIndex: Number(args.stateIndex) };
    },
    "module.storage.get": async ({ key: rawKey }, commandContext) => {
      await ctx.assertCapability("module.storage.read");
      assertCommandActive(commandContext);
      const key = storageKey(rawKey);
      const setting = await getSetting(ctx.db, storageScope(ctx), key);
      assertCommandActive(commandContext);
      return setting?.value ?? null;
    },
    "module.storage.set": async ({ key: rawKey, value }, commandContext) => {
      await ctx.assertCapability("module.storage.write");
      assertCommandActive(commandContext);
      const key = storageKey(rawKey);
      if (!boundedJson(value) || byteLength(value) === null || (byteLength(value) ?? Infinity) > MAX_STORAGE_VALUE_BYTES)
        throw new Error(`module storage values are limited to ${MAX_STORAGE_VALUE_BYTES} bytes of JSON`);
      const scope = storageScope(ctx);
      const existing = await getAllSettings(ctx.db, scope);
      assertCommandActive(commandContext);
      if (!existing.some((row) => row.key === key) && existing.length >= MAX_STORAGE_KEYS)
        throw new Error(`module storage is limited to ${MAX_STORAGE_KEYS} keys`);
      const total = existing.reduce((sum, row) => sum + (byteLength(row.value) ?? MAX_STORAGE_BYTES), 0) -
        (byteLength(existing.find((row) => row.key === key)?.value) ?? 0) + (byteLength(value) ?? 0);
      if (total > MAX_STORAGE_BYTES) throw new Error(`module storage is limited to ${MAX_STORAGE_BYTES} bytes per module`);
      assertCommandActive(commandContext);
      await putSetting(ctx.db, { scope, key, value });
      return { ok: true };
    },
    "chat.post": async ({ content }, commandContext) => {
      await ctx.assertCapability("chat.post");
      assertCommandActive(commandContext);
      if (typeof content !== "string" || content.trim().length === 0 || content.length > 2000)
        throw new Error("chat.post requires 1–2000 characters of text");
      const user = ctx.user();
      const id = ctx.newId("ais-msg-");
      const doc: MessageDocument = {
        _id: id,
        type: "message",
        name: "message",
        ownership: { default: 1 },
        flags: {},
        system: {},
        author: user.id,
        content: plainText(content),
        whisper: [],
        roll: null,
        flavor: `AIS module ${ctx.packageId}`,
      };
      assertCommandActive(commandContext);
      const txId = ctx.submit([{ kind: "create", coll: "messages", data: doc }]);
      return { id, txId };
    },
    "ui.notify": async ({ message, level }, commandContext) => {
      await ctx.assertCapability("ui.notify");
      assertCommandActive(commandContext);
      if (typeof message !== "string" || message.length === 0 || message.length > 500)
        throw new Error("ui.notify message must be 1–500 characters");
      const normalizedLevel = level === "warn" || level === "error" ? level : "info";
      ctx.notify(message, normalizedLevel);
      return { ok: true };
    },
    "ui.select": async (args, commandContext) => {
      await ctx.assertCapability("ui.interaction");
      if (commandContext) throw new Error("ui.select cannot be used inside a script-macro command");
      const request = selectRequest(args);
      const selected = await ctx.select(request);
      if (selected === null) return { selected: null };
      if (!request.options.some((option) => option.value === selected))
        throw new Error("host returned a choice not present in the request");
      return { selected };
    },
  };
}
