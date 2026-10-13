/** Minimal AIS SDK injected before an independent module's classic-script entry point. */
export const AIS_MODULE_RUNTIME_SOURCE = `
"use strict";
(function () {
  var nextId = 1;
  var pending = new Map();
  var events = new Map();
  var subscribed = new Set();
  var commands = new Map();
  var ready = false;

  function post(frame) { parent.postMessage(frame, "*"); }
  function rpc(method, args, commandId) {
    return new Promise(function (resolve, reject) {
      var id = nextId++;
      pending.set(id, { resolve: resolve, reject: reject });
      post({ vttAisRpc: 1, kind: "request", id: id, method: method,
        args: args === undefined ? null : args,
        ...(commandId ? { commandId: commandId } : {}) });
      // A host-rendered selection can wait for a human. Other calls stay short and bounded.
      var timeout = method === "ui.select" ? 5 * 60 * 1000 : 10000;
      setTimeout(function () {
        if (pending.has(id)) {
          pending.delete(id);
          reject(new Error("AIS RPC timed out: " + method));
        }
      }, timeout);
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
    return Object.freeze({
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
      scene: Object.freeze({ readVisible: function () { return call("scene.read.visible", {}); } }),
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
      chat: Object.freeze({ post: function (content) { return call("chat.post", { content: content }); } }),
      ui: Object.freeze({
        notify: function (message, level) { return call("ui.notify", { message: String(message), level: level || "info" }); },
        select: function (request) { return call("ui.select", request); }
      })
    });
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
    if (typeof data.id !== "string" || !/^cmd-[0-9]{1,16}$/.test(data.id) ||
        typeof data.commandId !== "string" || !commands.has(data.commandId)) return;
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
  window.addEventListener("message", function (ev) {
    if (ev.source !== parent || ev.origin !== "null") return;
    var data = ev.data;
    if (!data || data.vttAisRpc !== 1) return;
    if (data.kind === "command") {
      runCommand(data);
      return;
    }
    if (data.kind === "response") {
      var waiter = pending.get(data.id);
      if (!waiter) return;
      pending.delete(data.id);
      if (data.ok) waiter.resolve(data.result);
      else waiter.reject(new Error(data.error || "AIS RPC failed"));
      return;
    }
    if (data.kind === "event") {
      var callbacks = events.get(data.event);
      if (!callbacks) return;
      callbacks.forEach(function (callback) {
        try { callback(data.payload); } catch (error) { console.error("AIS event callback failed", error); }
      });
    }
  });

  globalThis.AIS = Object.freeze(Object.assign({}, createApi(undefined), {
    api: "arena.ais/1",
    commands: Object.freeze({
      on: function (commandId, callback) {
        if (typeof commandId !== "string" || !/^[a-z0-9][a-z0-9._:-]{1,127}$/.test(commandId) || typeof callback !== "function")
          throw new TypeError("AIS.commands.on requires a valid command ID and callback");
        if (commands.has(commandId)) throw new Error("AIS command already registered: " + commandId);
        commands.set(commandId, callback);
        return function () { if (commands.get(commandId) === callback) commands.delete(commandId); };
      }
    }),
    __ready: function () { if (!ready) { ready = true; post({ vttAisRpc: 1, kind: "ready" }); } }
  }));
})();
`;
