/**
 * §12 module runtime — the classic script injected into a package's
 * sandboxed iframe BEFORE the package's module entry. Provides the §12
 * module API surface (`game`, `Hooks`, `canvas.tokens`, `ChatMessage`,
 * `ui.notifications`) as postMessage RPC against the host dispatcher.
 * Kept as a source STRING: it runs inside the iframe, not in the bundle.
 */
export const MODULE_RUNTIME_SOURCE = `
"use strict";
(function () {
  var nextId = 1;
  var pending = new Map();
  var hooks = new Map(); // event -> Set<fn>
  var subscribed = new Set();

  function post(frame) { parent.postMessage(frame, "*"); }

  function rpc(method, args) {
    return new Promise(function (resolve, reject) {
      var id = nextId++;
      pending.set(id, { resolve: resolve, reject: reject });
      post({ vttModuleRpc: 1, kind: "request", id: id, method: method, args: args === undefined ? null : args });
      setTimeout(function () {
        if (pending.has(id)) {
          pending.delete(id);
          reject(new Error("module rpc: timeout " + method));
        }
      }, 10000);
    });
  }

  window.addEventListener("message", function (ev) {
    var data = ev.data;
    if (!data || data.vttModuleRpc !== 1) return;
    if (data.kind === "response") {
      var waiter = pending.get(data.id);
      if (!waiter) return;
      pending.delete(data.id);
      if (data.ok) waiter.resolve(data.result);
      else waiter.reject(new Error(data.error || "module rpc failed"));
      return;
    }
    if (data.kind === "event") {
      var cbs = hooks.get(data.event);
      if (!cbs) return;
      cbs.forEach(function (cb) {
        try { cb(data.payload); } catch (e) { /* module callback errors stay in-frame */ }
      });
    }
  });

  function subscribe(event) {
    if (subscribed.has(event)) return;
    subscribed.add(event);
    void rpc("hooks.subscribe", { event: event }).catch(function () {});
  }

  globalThis.game = {
    info: function () { return rpc("game.info", {}); },
    settings: {
      get: function (key) { return rpc("settings.get", { key: key }); },
      set: function (key, value) { return rpc("settings.set", { key: key, value: value }); },
    },
  };

  var HookReg = {
    on: function (event, cb) {
      if (!cbs(event).has(cb)) cbs(event).add(cb);
      subscribe(event);
    },
    once: function (event, cb) {
      var wrap = function (payload) { HookReg.off(event, wrap); cb(payload); };
      HookReg.on(event, wrap);
    },
    off: function (event, cb) { cbs(event).delete(cb); },
  };
  function cbs(event) {
    var set = hooks.get(event);
    if (!set) { set = new Set(); hooks.set(event, set); }
    return set;
  }
  globalThis.Hooks = HookReg;

  globalThis.canvas = {
    tokens: {
      list: function () { return rpc("tokens.list", {}); },
      move: function (id, x, y) { return rpc("tokens.move", { id: id, x: x, y: y }); },
    },
  };

  globalThis.ChatMessage = {
    create: function (data) { return rpc("chat.create", data || {}); },
  };

  globalThis.ui = {
    notifications: {
      notify: function (message, level) { return rpc("notify", { message: String(message), level: level || "info" }); },
    },
  };
})();
`;
