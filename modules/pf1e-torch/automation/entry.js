/* global AIS */
/* PF1e token-light controls for ArenaStar AIS v1. This is an independent package entry point;
 * it receives only the typed, capability-gated AIS facade and never imports Foundry globals. */
(function () {
  "use strict";

  const SOURCES = [
    {
      id: "candle",
      name: "Candle",
      aliases: ["candles"],
      consumable: true,
      states: [
        { brightFt: 0, dimFt: 5, angle: 360, color: "#ffe9b8", alpha: 0.72, animation: { type: "torch", speed: 3.4, intensity: 0.22 } },
      ],
    },
    {
      id: "lamp",
      name: "Lamp",
      aliases: ["oil lamp", "lamp (oil)", "common lamp"],
      consumable: false,
      states: [
        { brightFt: 15, dimFt: 30, angle: 360, color: "#ffd47d", alpha: 0.75, animation: { type: "torch", speed: 2.5, intensity: 0.16 } },
      ],
    },
    {
      id: "lantern",
      name: "Lantern",
      aliases: ["common lantern", "lantern (common)", "lantern, common"],
      consumable: false,
      states: [
        { mode: "High", brightFt: 30, dimFt: 60, angle: 360, color: "#ffe2a0", alpha: 0.78, animation: { type: "torch", speed: 2.8, intensity: 0.2 } },
        { mode: "Low", brightFt: 15, dimFt: 30, angle: 360, color: "#ffe2a0", alpha: 0.7, animation: { type: "torch", speed: 2.4, intensity: 0.12 } },
      ],
    },
    {
      id: "bullseye-lantern",
      name: "Bullseye Lantern",
      aliases: [
        "bull's-eye lantern",
        "bulls-eye lantern",
        "lantern (bullseye)",
        "lantern, bullseye",
        "lantern (bull's eye)",
      ],
      consumable: false,
      states: [
        { brightFt: 60, dimFt: 120, angle: 90, color: "#fff0bf", alpha: 0.82, animation: { type: "torch", speed: 2.4, intensity: 0.14 } },
      ],
    },
    {
      id: "hooded-lantern",
      name: "Hooded Lantern",
      aliases: ["lantern (hooded)", "lantern, hooded"],
      consumable: false,
      states: [
        { brightFt: 30, dimFt: 60, angle: 360, color: "#ffe2a0", alpha: 0.78, animation: { type: "torch", speed: 2.8, intensity: 0.2 } },
      ],
    },
    {
      id: "miners-lantern",
      name: "Miner's Lantern",
      aliases: [
        "miner's lantern",
        "miners lantern",
        "miner's helmet lamp",
        "miner's headlamp",
        "mining lantern",
      ],
      consumable: false,
      states: [
        { brightFt: 30, dimFt: 60, angle: 90, color: "#fff0bf", alpha: 0.82, animation: { type: "torch", speed: 2.6, intensity: 0.18 } },
      ],
    },
    {
      id: "torch",
      name: "Torch",
      aliases: ["torches", "standard torch", "wooden torch", "torch (wood)"],
      consumable: true,
      states: [
        { brightFt: 20, dimFt: 40, angle: 360, color: "#ffcf82", alpha: 0.82, animation: { type: "torch", speed: 4.1, intensity: 0.32 } },
      ],
    },
  ];

  const DEFAULTS = Object.freeze({
    ignoreInventory: false,
    consumeConsumables: true,
    fallbackBrightFt: 20,
    fallbackDimFt: 40,
    defaultSourceId: "torch",
  });
  const FALLBACK_ID = "personal-light";
  const LOCKED_TOKENS = new Set();

  function asRecord(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? value
      : {};
  }

  function normalizeName(value) {
    return String(value || "")
      .toLowerCase()
      .replace(/[’‘]/g, "'")
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  }

  function sourceForItemName(name) {
    const key = normalizeName(name);
    return (
      SOURCES.find((source) =>
        [source.name]
          .concat(source.aliases)
          .some((alias) => normalizeName(alias) === key),
      ) || null
    );
  }

  function cleanPreferences(value) {
    const raw = asRecord(value);
    const bright = Number(raw.fallbackBrightFt);
    const dim = Number(raw.fallbackDimFt);
    const defaultSourceId =
      typeof raw.defaultSourceId === "string" &&
      SOURCES.some((source) => source.id === raw.defaultSourceId)
        ? raw.defaultSourceId
        : DEFAULTS.defaultSourceId;
    return {
      ignoreInventory: raw.ignoreInventory === true,
      consumeConsumables: raw.consumeConsumables !== false,
      fallbackBrightFt: Number.isFinite(bright)
        ? Math.min(120, Math.max(0, bright))
        : DEFAULTS.fallbackBrightFt,
      fallbackDimFt: Number.isFinite(dim)
        ? Math.min(240, Math.max(1, dim))
        : DEFAULTS.fallbackDimFt,
      defaultSourceId,
    };
  }

  async function readPreferences(api) {
    try {
      return cleanPreferences(await (api || AIS).storage.get("preferences"));
    } catch {
      return cleanPreferences(null);
    }
  }

  async function writePreferences(value) {
    try {
      await AIS.storage.set("preferences", cleanPreferences(value));
      return true;
    } catch (error) {
      await AIS.ui.notify(
        "Torch preferences could not be saved: " +
          String((error && error.message) || error),
        "warn",
      );
      return false;
    }
  }

  function fallbackSource(preferences) {
    return {
      id: FALLBACK_ID,
      name: "Personal light (fallback)",
      consumable: false,
      states: [
        {
          brightFt: preferences.fallbackBrightFt,
          dimFt: preferences.fallbackDimFt,
          angle: 360,
          color: "#ffcf82",
          alpha: 0.82,
          animation: { type: "torch", speed: 4.1, intensity: 0.32 },
        },
      ],
    };
  }

  function availableSources(inventory, preferences) {
    const items = Array.isArray(inventory && inventory.items)
      ? inventory.items
      : [];
    if (preferences.ignoreInventory) {
      return SOURCES.map((source) => ({
        source,
        itemId: null,
        quantity: null,
        key: "source:" + source.id,
      })).concat([
        {
          source: fallbackSource(preferences),
          itemId: null,
          quantity: null,
          key: "fallback",
        },
      ]);
    }
    const rows = [];
    const seenSources = new Set();
    for (const item of items) {
      const source = sourceForItemName(item.name);
      if (!source || seenSources.has(source.id)) continue;
      const quantity = Number.isFinite(item.quantity)
        ? Math.max(0, Math.floor(item.quantity))
        : 1;
      if (source.consumable && quantity <= 0) continue;
      seenSources.add(source.id);
      rows.push({
        source,
        itemId: item.id,
        quantity,
        key: "item-" + rows.length,
      });
    }
    rows.push({
      source: fallbackSource(preferences),
      itemId: null,
      quantity: null,
      key: "fallback",
    });
    return rows;
  }

  function sourceById(sourceId, preferences) {
    if (sourceId === FALLBACK_ID) return fallbackSource(preferences);
    return SOURCES.find((source) => source.id === sourceId) || null;
  }

  function chosenEntry(state, entries, preferences, allowStored) {
    const row = asRecord(state);
    if (typeof row.sourceItemId === "string") {
      const byItem = entries.find((entry) => entry.itemId === row.sourceItemId);
      if (byItem) return byItem;
    }
    if (typeof row.sourceId === "string") {
      const bySource = entries.find(
        (entry) => entry.source.id === row.sourceId,
      );
      if (bySource) return bySource;
      if (allowStored) {
        const source = sourceById(row.sourceId, preferences);
        if (source)
          return {
            source,
            itemId:
              typeof row.sourceItemId === "string" ? row.sourceItemId : null,
            quantity: null,
            key: "stored:" + source.id,
          };
      }
    }
    const preferred = entries.find(
      (entry) => entry.source.id === preferences.defaultSourceId,
    );
    return (
      preferred ||
      entries.find((entry) => entry.source.id !== FALLBACK_ID) ||
      entries[entries.length - 1] || {
        source: fallbackSource(preferences),
        itemId: null,
        quantity: null,
        key: "fallback",
      }
    );
  }

  function pixelsPerFoot(scene) {
    const grid = asRecord(scene && scene.grid);
    const size = Number(grid.size);
    const distance = Number(grid.distance);
    const units = normalizeName(grid.units || "ft");
    const unitScale =
      units === "m" || units === "meter" || units === "meters"
        ? 0.3048
        : units === "cm" || units === "centimeter" || units === "centimeters"
          ? 30.48
          : units === "yd" || units === "yard" || units === "yards"
            ? 1 / 3
            : units === "in" || units === "inch" || units === "inches"
              ? 12
              : 1;
    return (
      ((Number.isFinite(size) && size > 0 ? size : 100) * unitScale) /
      (Number.isFinite(distance) && distance > 0 ? distance : 5)
    );
  }

  function lightAtState(scene, source, stateIndex) {
    const state =
      source.states[
        Math.max(0, Math.min(source.states.length - 1, stateIndex - 1))
      ] || source.states[0];
    if (!state || stateIndex <= 0) {
      const off = source.states[0] || {
        angle: 360,
        color: "#ffcf82",
        alpha: 0.82,
      };
      return {
        radius: 0,
        bright: 0,
        color: off.color,
        alpha: off.alpha,
        angle: off.angle,
        animation: null,
      };
    }
    const scale = pixelsPerFoot(scene);
    const radius = Math.max(0, state.dimFt * scale);
    return {
      radius,
      bright: Math.max(0, Math.min(radius, state.brightFt * scale)),
      color: state.color,
      alpha: state.alpha,
      angle: state.angle,
      animation: state.animation || null,
    };
  }

  function tokenState(token) {
    return asRecord(token && token.state);
  }

  async function apply(
    scene,
    token,
    entry,
    stateIndex,
    active,
    preferences,
    consume,
    api,
  ) {
    const bridge = api || AIS;
    const source = entry.source;
    const light = lightAtState(scene, source, stateIndex);
    const request = {
      sceneId: scene.id,
      tokenId: token.id,
      sourceId: source.id,
      sourceName: source.name,
      sourceItemId: entry.itemId || null,
      stateIndex,
      active,
      light,
      ...(consume && entry.itemId ? { consumeItemId: entry.itemId } : {}),
    };
    return bridge.lighting.applyTokenLight(request);
  }

  function optionFor(entry) {
    const state = entry.source.states[0] || { brightFt: 0, dimFt: 0 };
    const quantity =
      entry.quantity === null
        ? "not item-counted"
        : `quantity ${entry.quantity}`;
    return {
      value: entry.key,
      label: entry.source.name + (entry.itemId ? ` · ${quantity}` : ""),
      description: `${state.brightFt} ft. bright / ${state.dimFt} ft. dim${state.angle < 360 ? ` · ${state.angle}° beam` : ""}`,
    };
  }

  async function selectSource(scene, token, inventory, preferences) {
    const entries = availableSources(inventory, preferences);
    const result = await AIS.ui.select({
      title: "Choose a carried light source",
      description: preferences.ignoreInventory
        ? "Inventory is ignored; any PF1e source or the fallback light may be selected."
        : "Choose a matching inventory item or the configured fallback light.",
      options: entries.map(optionFor),
    });
    const selected = result && result.selected;
    if (typeof selected !== "string") return;
    const entry = entries.find((row) => row.key === selected);
    if (!entry) return;
    const state = tokenState(token);
    const current = asRecord(token.light);
    const active =
      state.active === true ||
      (state.active === undefined && Number(current.radius) > 0);
    const stateIndex = active ? 1 : 0;
    const consume =
      active &&
      entry.source.consumable &&
      preferences.consumeConsumables &&
      !!entry.itemId;
    await apply(scene, token, entry, stateIndex, active, preferences, consume);
    await AIS.events.emit("torch.selected", {
      sceneId: scene.id,
      tokenId: token.id,
      sourceId: entry.source.id,
      sourceName: entry.source.name,
      sourceItemId: entry.itemId || null,
      active,
    });
    await AIS.ui.notify(
      `${entry.source.name} selected${active ? " and lit" : ""} for ${token.name}.`,
      "info",
    );
  }

  async function configure(preferences) {
    const result = await AIS.ui.select({
      title: "Torch settings",
      description:
        "Preferences are stored for this module on this host/browser. Source inventory remains on each PF1e actor.",
      options: [
        {
          value: "inventory:required",
          label: "Require a matching carried item",
          description: preferences.ignoreInventory
            ? "Currently: inventory is ignored."
            : "Currently selected.",
        },
        {
          value: "inventory:ignored",
          label: "Allow any listed light source",
          description: preferences.ignoreInventory
            ? "Currently selected."
            : "Currently: inventory is required.",
        },
        {
          value: "consume:on",
          label: "Consume candles/torches when lit",
          description: preferences.consumeConsumables
            ? "Currently selected."
            : "Currently disabled.",
        },
        {
          value: "consume:off",
          label: "Do not consume inventory",
          description: preferences.consumeConsumables
            ? "Currently enabled."
            : "Currently selected.",
        },
        {
          value: "fallback:10:20",
          label: "Fallback light: 10 / 20 ft.",
          description: "Bright / dim radius.",
        },
        {
          value: "fallback:20:40",
          label: "Fallback light: 20 / 40 ft.",
          description: "Bright / dim radius (default).",
        },
        {
          value: "fallback:30:60",
          label: "Fallback light: 30 / 60 ft.",
          description: "Bright / dim radius.",
        },
        {
          value: "fallback:60:120",
          label: "Fallback light: 60 / 120 ft.",
          description: "Bright / dim radius.",
        },
        { value: "default:torch", label: "Default source: Torch" },
        { value: "default:candle", label: "Default source: Candle" },
        { value: "default:lantern", label: "Default source: Lantern" },
        { value: "reset", label: "Restore defaults" },
      ],
    });
    if (!result || typeof result.selected !== "string") return;
    const next = Object.assign({}, preferences);
    if (result.selected === "inventory:required") next.ignoreInventory = false;
    else if (result.selected === "inventory:ignored")
      next.ignoreInventory = true;
    else if (result.selected === "consume:on") next.consumeConsumables = true;
    else if (result.selected === "consume:off") next.consumeConsumables = false;
    else if (result.selected === "fallback:10:20") {
      next.fallbackBrightFt = 10;
      next.fallbackDimFt = 20;
    } else if (result.selected === "fallback:20:40") {
      next.fallbackBrightFt = 20;
      next.fallbackDimFt = 40;
    } else if (result.selected === "fallback:30:60") {
      next.fallbackBrightFt = 30;
      next.fallbackDimFt = 60;
    } else if (result.selected === "fallback:60:120") {
      next.fallbackBrightFt = 60;
      next.fallbackDimFt = 120;
    } else if (result.selected.indexOf("default:") === 0)
      next.defaultSourceId = result.selected.slice("default:".length);
    else if (result.selected === "reset") return writePreferences(DEFAULTS);
    if (await writePreferences(next))
      await AIS.ui.notify("Torch settings saved.", "info");
  }

  async function sourceAction(action, scene, token, inventory, preferences) {
    const state = tokenState(token);
    const entries = availableSources(inventory, preferences);
    const active =
      state.active === true ||
      (state.active === undefined && Number(asRecord(token.light).radius) > 0);
    const current = chosenEntry(
      state,
      entries,
      preferences,
      action === "off" || (action === "toggle" && active),
    );
    if (action === "select")
      return selectSource(scene, token, inventory, preferences);
    if (action === "settings") return configure(preferences);
    if (action === "off") {
      await apply(scene, token, current, 0, false, preferences, false);
      return AIS.ui.notify(`${current.source.name} extinguished.`, "info");
    }
    if (action === "next") {
      const at = entries.findIndex(
        (entry) =>
          entry.key === current.key ||
          (current.itemId && entry.itemId === current.itemId) ||
          entry.source.id === current.source.id,
      );
      const next =
        entries[(at + 1 + entries.length) % entries.length] || current;
      const canConsume =
        next.source.consumable &&
        preferences.consumeConsumables &&
        !!next.itemId;
      await apply(scene, token, next, 1, true, preferences, canConsume);
      return AIS.ui.notify(`${next.source.name} lit on ${token.name}.`, "info");
    }
    if (action === "toggle") {
      const stateCount = current.source.states.length;
      const previousIndex =
        active && Number.isInteger(state.stateIndex)
          ? Math.max(1, Math.min(stateCount, state.stateIndex))
          : active
            ? 1
            : 0;
      const nextIndex = active ? (previousIndex + 1) % (stateCount + 1) : 1;
      if (nextIndex === 0) {
        await apply(scene, token, current, 0, false, preferences, false);
        return AIS.ui.notify(`${current.source.name} extinguished.`, "info");
      }
      const hasSource =
        current.source.id === FALLBACK_ID ||
        preferences.ignoreInventory ||
        !!current.itemId;
      if (!hasSource) {
        await AIS.ui.notify(
          "No matching light source is available in this actor's inventory.",
          "warn",
        );
        return;
      }
      const canConsume =
        previousIndex === 0 &&
        current.source.consumable &&
        preferences.consumeConsumables &&
        !!current.itemId;
      await apply(
        scene,
        token,
        current,
        nextIndex,
        true,
        preferences,
        canConsume,
      );
      return AIS.ui.notify(
        `${current.source.name} ${nextIndex === 1 ? "lit" : "dimmed"} on ${token.name}.`,
        "info",
      );
    }
    throw new Error("Unknown token-light action: " + String(action));
  }

  async function handleAction(payload) {
    const request = asRecord(payload);
    if (
      typeof request.sceneId !== "string" ||
      typeof request.tokenId !== "string" ||
      typeof request.action !== "string"
    )
      return;
    const lock = request.sceneId + "/" + request.tokenId;
    if (LOCKED_TOKENS.has(lock)) return;
    LOCKED_TOKENS.add(lock);
    try {
      const scene = await AIS.scene.readVisible();
      if (!scene || scene.id !== request.sceneId)
        throw new Error(
          "The active scene changed before the light action ran.",
        );
      const token = (Array.isArray(scene.tokens) ? scene.tokens : []).find(
        (row) => row.id === request.tokenId,
      );
      if (!token)
        throw new Error("That token is no longer visible in the active scene.");
      if (request.action === "settings") {
        await configure(await readPreferences());
        return;
      }
      const preferences = await readPreferences();
      const state = tokenState(token);
      const active =
        state.active === true ||
        (state.active === undefined &&
          Number(asRecord(token.light).radius) > 0);
      let inventory = { items: [] };
      const needsInventory =
        !preferences.ignoreInventory &&
        !!token.actorId &&
        request.action !== "off" &&
        !(request.action === "toggle" && active);
      if (needsInventory) {
        try {
          inventory = await AIS.actor.readInventory(token.actorId);
        } catch (error) {
          await AIS.ui.notify(
            "Inventory could not be read: " +
              String((error && error.message) || error),
            "warn",
          );
        }
      }
      await sourceAction(request.action, scene, token, inventory, preferences);
    } catch (error) {
      await AIS.ui.notify(
        "Torch: " + String((error && error.message) || error),
        "warn",
      );
    } finally {
      LOCKED_TOKENS.delete(lock);
    }
  }

  function commandInput(value, context) {
    const input = asRecord(value);
    if (Object.keys(input).some((key) => !["tokenId", "sourceId", "sourceName"].includes(key)))
      throw new Error("Torch macro command input has an unsupported field");
    if (typeof input.tokenId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(input.tokenId))
      throw new Error("Torch macro command requires a visible tokenId");
    if (input.sourceId !== undefined && input.sourceName !== undefined)
      throw new Error("Pass sourceId or sourceName, not both");
    if (!context || typeof context.sceneId !== "string" || !context.ais)
      throw new Error("Torch macro command context is incomplete");
    return { input, api: context.ais };
  }

  async function commandTarget(value, context, needsInventory) {
    const { input, api } = commandInput(value, context);
    const scene = await api.scene.readVisible();
    if (!scene || scene.id !== context.sceneId)
      throw new Error("The macro's fixed scene is not currently active");
    const token = (Array.isArray(scene.tokens) ? scene.tokens : []).find((row) => row.id === input.tokenId);
    if (!token) throw new Error("Torch macro target is not visible in the active scene");
    const preferences = await readPreferences(api);
    let inventory = { items: [] };
    if (needsInventory && !preferences.ignoreInventory && token.actorId)
      inventory = await api.actor.readInventory(token.actorId);
    return { input, api, scene, token, preferences, inventory };
  }

  function sourceEntry(value, entries, preferences) {
    if (typeof value !== "string" || value.length === 0 || value.length > 128)
      throw new Error("sourceId or sourceName must be a short string");
    const byId = entries.find((entry) => entry.source.id === value || entry.itemId === value);
    if (byId) return byId;
    const normalized = normalizeName(value);
    const byName = entries.find((entry) => [entry.source.name]
      .concat(entry.source.aliases || [])
      .some((alias) => normalizeName(alias) === normalized));
    if (byName) return byName;
    if (value === FALLBACK_ID) {
      const fallback = entries.find((entry) => entry.source.id === FALLBACK_ID);
      if (fallback) return fallback;
      return { source: fallbackSource(preferences), itemId: null, quantity: null, key: "fallback" };
    }
    throw new Error("That light source is not available for the selected token");
  }

  function sourceStatus(token, entries, preferences) {
    const state = tokenState(token);
    const currentLight = asRecord(token.light);
    const active = state.active === true || (state.active === undefined && Number(currentLight.radius) > 0);
    const entry = chosenEntry(state, entries, preferences, true);
    const stateIndex = active && Number.isInteger(state.stateIndex)
      ? Math.max(1, Math.min(entry.source.states.length, state.stateIndex))
      : active ? 1 : 0;
    const activeMode = active ? entry.source.states[stateIndex - 1]?.mode : null;
    return {
      sourceId: entry.source.id,
      sourceName: entry.source.name,
      sourceItemId: entry.itemId || null,
      stateIndex,
      mode: typeof activeMode === "string" ? activeMode : null,
      active,
      light: {
        radius: Number(currentLight.radius) || 0,
        bright: Number(currentLight.bright) || 0,
        color: typeof currentLight.color === "string" ? currentLight.color : "#ffffff",
        alpha: Number(currentLight.alpha) || 0,
        angle: Number(currentLight.angle) || 360,
        animation: currentLight.animation || null,
      },
    };
  }

  async function observeHostLightChange(payload) {
    const change = asRecord(payload);
    if (typeof change.sceneId !== "string" || typeof change.tokenId !== "string") return;
    const snapshot = asRecord(await AIS.scene.readVisible());
    if (!snapshot || snapshot.id !== change.sceneId || !Array.isArray(snapshot.tokens)) return;
    const token = snapshot.tokens.find((row) => asRecord(row)?.id === change.tokenId);
    if (!token) return;
    const state = tokenState(token);
    const sourceId = typeof state.sourceId === "string" ? state.sourceId : "";
    if (!sourceId) return;
    const preferences = await readPreferences();
    const source = sourceById(sourceId, preferences);
    if (!source) return;
    const currentLight = asRecord(change.light) || {};
    const active = state.active === true || (state.active === undefined && Number(currentLight.radius) > 0);
    const stateIndex = active && Number.isInteger(state.stateIndex)
      ? Math.max(1, Math.min(source.states.length, state.stateIndex))
      : active ? 1 : 0;
    const activeMode = active ? source.states[stateIndex - 1]?.mode : null;
    await AIS.events.emit("torch.changed", {
      sceneId: change.sceneId,
      tokenId: change.tokenId,
      sourceId: source.id,
      sourceName: typeof state.sourceName === "string" ? state.sourceName : source.name,
      sourceItemId: typeof state.sourceItemId === "string" ? state.sourceItemId : null,
      stateIndex,
      mode: typeof activeMode === "string" ? activeMode : null,
      active,
      light: currentLight,
    });
  }

  function sourceInventoryCount(inventory, source) {
    const items = Array.isArray(inventory && inventory.items) ? inventory.items : [];
    return items.reduce((count, item) => sourceForItemName(item.name)?.id === source.id
      ? count + (Number.isFinite(item.quantity) ? Math.max(0, Math.floor(item.quantity)) : 1)
      : count, 0);
  }

  function knownSource(value, preferences) {
    if (typeof value !== "string" || value.length === 0 || value.length > 128)
      throw new Error("sourceId or sourceName must be a short string");
    const byId = sourceById(value, preferences);
    if (byId) return byId;
    const normalized = normalizeName(value);
    const byName = SOURCES.find((source) => [source.name].concat(source.aliases)
      .some((alias) => normalizeName(alias) === normalized));
    if (byName) return byName;
    throw new Error("Unknown PF1e light source");
  }

  async function macroCommand(name, value, context) {
    const readsInventory = ["toggle", "extinguish", "select-source", "equipped-sources", "inventory", "source-exhausted"].includes(name);
    const target = await commandTarget(value, context, readsInventory);
    const { input, api, scene, token, preferences, inventory } = target;
    const entries = availableSources(inventory, preferences);
    if (name === "current-source" || name === "current-state") {
      const status = sourceStatus(token, entries, preferences);
      return name === "current-source"
        ? { sourceId: status.sourceId, sourceName: status.sourceName, sourceItemId: status.sourceItemId }
        : status;
    }
    if (name === "equipped-sources") {
      return entries.map((entry) => ({
        sourceId: entry.source.id,
        sourceName: entry.source.name,
        sourceItemId: entry.itemId || null,
        quantity: entry.quantity,
        consumable: entry.source.consumable === true,
      }));
    }
    if (name === "inventory" || name === "source-exhausted") {
      const source = knownSource(input.sourceId ?? input.sourceName, preferences);
      const quantity = preferences.ignoreInventory ? null : sourceInventoryCount(inventory, source);
      return name === "inventory"
        ? { sourceId: source.id, quantity }
        : { sourceId: source.id, exhausted: !preferences.ignoreInventory && source.consumable === true && (quantity ?? 0) <= 0 };
    }

    const state = tokenState(token);
    const active = state.active === true || (state.active === undefined && Number(asRecord(token.light).radius) > 0);
    if (name === "toggle" || name === "extinguish") {
      const current = chosenEntry(state, entries, preferences, name === "extinguish" || active);
      if (name === "extinguish") {
        await apply(scene, token, current, 0, false, preferences, false, api);
        return { sourceId: current.source.id, sourceName: current.source.name, stateIndex: 0, active: false };
      }
      const count = current.source.states.length;
      const previous = active && Number.isInteger(state.stateIndex)
        ? Math.max(1, Math.min(count, state.stateIndex))
        : active ? 1 : 0;
      const next = active ? (previous + 1) % (count + 1) : 1;
      if (next === 0) {
        await apply(scene, token, current, 0, false, preferences, false, api);
        return { sourceId: current.source.id, sourceName: current.source.name, stateIndex: 0, active: false };
      }
      if (current.source.id !== FALLBACK_ID && !preferences.ignoreInventory && !current.itemId)
        throw new Error("No matching light source is available in this actor's inventory");
      const consume = previous === 0 && current.source.consumable && preferences.consumeConsumables && !!current.itemId;
      await apply(scene, token, current, next, true, preferences, consume, api);
      const mode = current.source.states[next - 1]?.mode;
      return { sourceId: current.source.id, sourceName: current.source.name, stateIndex: next, active: true,
        ...(typeof mode === "string" ? { mode } : {}) };
    }
    if (name === "select-source") {
      const selected = sourceEntry(input.sourceId ?? input.sourceName, entries, preferences);
      const wasActive = active;
      const consume = wasActive && selected.source.consumable && preferences.consumeConsumables && !!selected.itemId;
      await apply(scene, token, selected, wasActive ? 1 : 0, wasActive, preferences, consume, api);
      await api.events.emit("torch.selected", {
        sceneId: scene.id,
        tokenId: token.id,
        sourceId: selected.source.id,
        sourceName: selected.source.name,
        sourceItemId: selected.itemId || null,
        active: wasActive,
      });
      const mode = wasActive ? selected.source.states[0]?.mode : undefined;
      return { sourceId: selected.source.id, sourceName: selected.source.name, stateIndex: wasActive ? 1 : 0, active: wasActive,
        ...(typeof mode === "string" ? { mode } : {}) };
    }
    throw new Error("Unknown Torch macro command: " + name);
  }

  ["toggle", "extinguish", "current-source", "current-state", "equipped-sources", "select-source", "inventory", "source-exhausted"]
    .forEach((commandId) => AIS.commands.on(commandId, (input, context) => macroCommand(commandId, input, context)));

  AIS.events.on("scene.token.light.changed", function (payload) {
    void observeHostLightChange(payload).catch(function () {});
  });

  AIS.events.on("ui.token.action", function (payload) {
    return handleAction(payload);
  });
})();
