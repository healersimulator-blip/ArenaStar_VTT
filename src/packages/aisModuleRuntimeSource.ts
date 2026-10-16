/** Minimal AIS SDK injected before an independent module's classic-script entry point. */
import type { Json } from "../core/documents";

export function aisModuleRuntimeSource(bootId: string, runtimeContext: Json = null): string {
  return `
"use strict";
(function (bootId, runtimeContext) {
  var channel = new MessageChannel();
  var port = channel.port1;
  var failed = false;
  var nextId = 1;
  var pending = new Map();
  var events = new Map();
  var subscribed = new Set();
  var busBindings = new Map();
  var commands = new Map();
  var ready = false;
  var initializers = [];
  var starting = false;

  function post(frame) { port.postMessage(frame); }
  function fail(error) {
    if (failed) return;
    failed = true;
    post({ vttAisRpc: 1, kind: "error", error: String(error && error.message || error).slice(0, 500) });
  }
  window.addEventListener("error", function (event) { fail(event.error || event.message); });
  window.addEventListener("unhandledrejection", function (event) { fail(event.reason); });
  window.addEventListener("pagehide", function () { port.close(); }, { once: true });
  function rpc(method, args, commandId) {
    return new Promise(function (resolve, reject) {
      if (failed) { reject(new Error("AIS module has stopped")); return; }
      if (pending.size >= 32) { reject(new Error("AIS RPC concurrency limit exceeded")); return; }
      var id = nextId++;
      var frame = { vttAisRpc: 1, kind: "request", id: id, method: method,
        args: args === undefined ? {} : args,
        ...(commandId ? { commandId: commandId } : {}) };
      if (!boundedJson(frame, 0, new Set()) || byteLength(frame) > 64 * 1024) {
        reject(new Error("AIS RPC request must be bounded JSON no larger than 64 KiB")); return;
      }
      // A host-rendered selection can wait for a human. Other calls stay short and bounded.
      var timeout = method === "ui.select" ? 5 * 60 * 1000 : 10000;
      var timer = setTimeout(function () {
        if (pending.has(id)) {
          pending.delete(id);
          reject(new Error("AIS RPC timed out: " + method));
        }
      }, timeout);
      pending.set(id, { resolve: resolve, reject: reject, timer: timer });
      post(frame);
    });
  }
  function subscribe(event) {
    if (subscribed.has(event)) return;
    subscribed.add(event);
    void rpc("events.subscribe", { event: event }).catch(function (error) {
      subscribed.delete(event);
      console.warn("AIS event subscription denied", error);
    });
  }
  function createApi(commandId) {
    var call = function (method, args) { return rpc(method, args, commandId); };
    var api = {
      events: Object.freeze({
        on: function (event, callback) {
          if (typeof event !== "string" || typeof callback !== "function") throw new TypeError("AIS.events.on requires an event and callback");
          var callbacks = events.get(event);
          if (!callbacks) { callbacks = new Set(); events.set(event, callbacks); }
          callbacks.add(callback);
          subscribe(event);
          return function () { callbacks.delete(callback); };
        },
        emit: function (eventId, payload) { return call("events.emit", { eventId: eventId, payload: payload }); }
      }),
      // D-487: the kernel's bounded cross-device channel. Delivery is same-package only (this
      // module's frames on every device); the sender hears its own frame too, like game.socket.
      bus: Object.freeze({
        emit: function (channel, data) {
          if (typeof channel !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(channel)) throw new TypeError("AIS.bus.emit requires a channel of 1-128 [A-Za-z0-9._:-] characters");
          return call("bus.emit", { channel: channel, data: data === undefined ? null : data });
        },
        on: function (channel, callback) {
          if (typeof channel !== "string" || typeof callback !== "function") throw new TypeError("AIS.bus.on requires a channel and callback");
          var wrapper = function (payload) {
            if (payload && payload.channel === channel) callback(payload.data, payload.by);
          };
          var record = { callback: callback, wrapper: wrapper, unbind: api.events.on("bus.message", wrapper) };
          var rows = busBindings.get(channel);
          if (!rows) { rows = new Set(); busBindings.set(channel, rows); }
          rows.add(record);
          return function () { rows.delete(record); record.unbind(); };
        },
        off: function (channel, callback) {
          var rows = busBindings.get(channel);
          if (!rows) return;
          Array.from(rows).forEach(function (record) {
            if (record.callback === callback) { rows.delete(record); record.unbind(); }
          });
        }
      }),
      scene: Object.freeze({ readVisible: function () { return call("scene.read.visible", {}); } }),
      resources: Object.freeze({
        readText: async function (path) {
          var text = "", offset = 0;
          for (var page = 0; page < 256; page++) {
            var chunk = await call("package.resource.read", { path: path, offset: offset });
            text += chunk.text;
            if (chunk.next === null) return text;
            if (chunk.next <= offset) throw new Error("Invalid resource stream");
            offset = chunk.next;
          }
          throw new Error("Resource transfer budget exceeded");
        }
      }),
      sceneTags: Object.freeze({
        snapshot: function () { return call("scene.tags.snapshot", {}); },
        update: function (request) { return call("scene.tags.update", request); }
      }),
      fx: Object.freeze({
        play: function (request) { return call("fx.play", request); },
        list: function () { return call("fx.list", {}); },
        stop: function (runId) { return call("fx.stop", { runId: runId }); }
      }),
      actor: Object.freeze({
        readInventory: function (actorId) { return call("actor.inventory.read", { actorId: actorId }); }
      }),
      token: Object.freeze({
        applyLight: function (request) { return call("scene.token.light.apply", request); }
      }),
      lighting: Object.freeze({
        readInventory: function (actorId) { return call("actor.inventory.read", { actorId: actorId }); },
        applyTokenLight: function (request) { return call("scene.token.light.apply", request); }
      }),
      storage: Object.freeze({
        get: function (key) { return call("module.storage.get", { key: key }); },
        set: function (key, value) { return call("module.storage.set", { key: key, value: value }); }
      }),
      // D-476: schema-declared settings (interconnect.settings); world scope is GM-authored.
      settings: Object.freeze({
        list: function () { return call("settings.list", {}); },
        get: function (key) { return call("settings.get", { key: key }).then(function (row) { return row.value; }); },
        set: function (key, value) { return call("settings.set", { key: key, value: value }); },
        // D-482: declare a setting from code (same schema as interconnect.settings).
        register: function (declaration) { return call("settings.register", declaration); },
        onChange: function (callback) {
          if (typeof callback !== "function") throw new TypeError("AIS.settings.onChange requires a callback");
          return api.events.on("module.settings.changed", callback);
        }
      }),
      // D-477: read-only compendium access (GM device; players get an explanatory error).
      compendium: Object.freeze({
        list: function () { return call("compendium.list", {}).then(function (row) { return row.packs; }); },
        search: function (query, options) {
          var request = { query: query };
          if (options && options.packId !== undefined) request.packId = options.packId;
          if (options && options.limit !== undefined) request.limit = options.limit;
          return call("compendium.search", request).then(function (row) { return row.hits; });
        },
        get: function (packId, entryId) { return call("compendium.get", { packId: packId, entryId: entryId }); }
      }),
      // D-478: other modules on this device — public contract and kernel-routed invocation.
      modules: Object.freeze({
        list: function () { return call("modules.list", {}).then(function (row) { return row.modules; }); },
        invoke: function (moduleId, commandId, input) {
          return call("modules.invoke", { moduleId: moduleId, commandId: commandId, input: input === undefined ? null : input })
            .then(function (row) { return row.result; });
        }
      }),
      // D-485: generic documents (this device user's view; writes validated by the host).
      documents: Object.freeze({
        context: function () { return call("documents.context", {}); },
        list: function (collection, offset, limit) {
          var request = { collection: collection };
          if (offset !== undefined) request.offset = offset;
          if (limit !== undefined) request.limit = limit;
          return call("documents.list", request);
        },
        get: function (ref) { return call("documents.get", ref).then(function (row) { return row.document; }); },
        mutate: function (ops) { return call("documents.mutate", { ops: ops }); }
      }),
      chat: Object.freeze({ post: function (content) { return call("chat.post", { content: content }); } }),
      ui: Object.freeze({
        notify: function (message, level) { return call("ui.notify", { message: String(message), level: level || "info" }); },
        select: function (request) { return call("ui.select", request); },
        // D-470: the module's own document is the panel body; the shell draws the chrome.
        panel: Object.freeze({
          open: function () { return call("ui.panel.open", {}); },
          close: function () { return call("ui.panel.close", {}); },
          root: function () { return document.body; }
        })
      })
    };
    return Object.freeze(api);
  }
  function boundedJson(value, depth, seen) {
    if (depth > 12) return false;
    if (value === null || typeof value === "string" || typeof value === "boolean") return true;
    if (typeof value === "number") return Number.isFinite(value);
    if (typeof value !== "object") return false;
    if (seen.has(value)) return false;
    seen.add(value);
    var valid;
    if (Array.isArray(value)) valid = value.length <= 1024 && value.every(function (item) { return boundedJson(item, depth + 1, seen); });
    else {
      if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return false;
      var keys = Object.keys(value);
      valid = keys.length <= 1024 && keys.every(function (key) {
        return key !== "__proto__" && key !== "constructor" && boundedJson(value[key], depth + 1, seen);
      });
    }
    seen.delete(value);
    return valid;
  }
  function byteLength(value) {
    try { return new TextEncoder().encode(JSON.stringify(value)).byteLength; }
    catch (_) { return Infinity; }
  }
  function failCommand(id, message) {
    post({ vttAisRpc: 1, kind: "command-result", id: id, ok: false, error: String(message).slice(0, 500) });
  }
  function runCommand(data) {
    if (typeof data.id !== "string" || !/^cmd-[0-9]{1,16}$/.test(data.id)) return;
    if (typeof data.commandId !== "string" || !commands.has(data.commandId)) {
      failCommand(data.id, "AIS module did not register command " + data.commandId); return;
    }
    var handler = commands.get(data.commandId);
    var context = data.context && typeof data.context === "object" ? data.context : {};
    var api = createApi(data.id);
    var publicContext = Object.freeze({
      sceneId: context.sceneId,
      callerId: context.callerId,
      requestId: context.requestId,
      runAs: context.runAs,
      deadlineAt: context.deadlineAt,
      ais: api
    });
    Promise.resolve().then(function () { return handler(data.input, publicContext); }).then(function (result) {
      var value = result === undefined ? null : result;
      if (!boundedJson(value, 0, new Set()) || byteLength(value) > 16 * 1024)
        throw new Error("AIS command result exceeds 16 KiB or is not bounded JSON");
      post({ vttAisRpc: 1, kind: "command-result", id: data.id, ok: true, result: value });
    }).catch(function (error) {
      failCommand(data.id, error && error.message ? error.message : error);
    });
  }
  // Only the document-bound port carries RPCs. Window messages (including forged
  // replies from siblings or a non-null HTTPS parent) never enter this channel.
  port.onmessage = function (ev) {
    var data = ev.data;
    if (!data || data.vttAisRpc !== 1) return;
    if (data.kind === "ping" && data.bootId === bootId) {
      post({ vttAisRpc: 1, kind: "pong", bootId: bootId });
      return;
    }
    if (data.kind === "command") {
      runCommand(data);
      return;
    }
    if (data.kind === "response") {
      var waiter = pending.get(data.id);
      if (!waiter) return;
      pending.delete(data.id);
      clearTimeout(waiter.timer);
      if (data.ok) waiter.resolve(data.result);
      else waiter.reject(new Error(data.error || "AIS RPC failed"));
      return;
    }
    if (data.kind === "event") {
      var callbacks = events.get(data.event);
      if (!callbacks) return;
      callbacks.forEach(function (callback) {
        try { Promise.resolve(callback(data.payload)).catch(fail); } catch (error) { fail(error); }
      });
    }
  };
  port.start();
  // The host authenticates the source frame, opaque origin and one-use boot ID.
  // The port belongs to THIS document; navigating the frame cannot inherit it.
  parent.postMessage({ vttAisRpc: 1, kind: "connect", bootId: bootId }, "*", [channel.port2]);

  globalThis.AIS = Object.freeze(Object.assign({}, createApi(undefined), {
    api: "arena.ais/1",
    runtime: Object.freeze({
      context: runtimeContext,
      initialize: function (fn) {
        if (starting || typeof fn !== "function" || initializers.length >= 8)
          throw new Error("Invalid or late AIS runtime initializer");
        initializers.push(fn);
      }
    }),
    commands: Object.freeze({
      on: function (commandId, callback) {
        if (typeof commandId !== "string" || !/^[a-z0-9][a-z0-9._:-]{1,127}$/.test(commandId) || typeof callback !== "function")
          throw new TypeError("AIS.commands.on requires a valid command ID and callback");
        if (commands.has(commandId)) throw new Error("AIS command already registered: " + commandId);
        commands.set(commandId, callback);
        return function () { if (commands.get(commandId) === callback) commands.delete(commandId); };
      }
    }),
    __ready: function () {
      if (starting) return;
      starting = true;
      void (async function () {
        for (var initialize of initializers) await initialize();
        if (!ready && !failed) { ready = true; post({ vttAisRpc: 1, kind: "ready" }); }
      })().catch(fail);
    }
  }));
})(${JSON.stringify(bootId)}, ${JSON.stringify(runtimeContext)});
`;
}
