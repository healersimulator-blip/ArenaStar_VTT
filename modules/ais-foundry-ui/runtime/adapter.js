/* ArenaStar appearance adapter. All foreign DOM/CSS stays in THIS opaque iframe.
 * The host receives a closed palette/layout/resource proposal, never selectors or HTML. */
(function () {
  "use strict";
  const context = AIS.runtime.context;
  if (context?.profile !== "foundry-ui-v1") throw new Error("Unsupported appearance profile");
  const config = context.configuration;
  const hooks = new Map(), settings = new Map(), resources = new Map();
  let preferences = {};
  let nextId = 1;
  const register = (name, fn, once) => {
    const row = { id: nextId++, fn, once };
    const handlers = hooks.get(name) ?? [];
    handlers.push(row); hooks.set(name, handlers); return row.id;
  };
  globalThis.Hooks = {
    on: (name, fn) => register(name, fn, false),
    once: (name, fn) => register(name, fn, true),
    off: (name, id) => hooks.set(name, (hooks.get(name) ?? []).filter((row) => row.id !== id && row.fn !== id)),
    callAll: (name, ...args) => {
      for (const row of [...(hooks.get(name) ?? [])]) {
        if (row.once) Hooks.off(name, row.id);
        row.fn(...args);
      }
    },
  };
  globalThis.game = {
    version: config.mode === "rpg-hooks" ? "12" : "13",
    user: { id: "gm", isGM: true },
    i18n: { localize: (key) => config.translations?.[key] ?? key },
    settings: {
      register: (namespace, key, definition) => {
        if (namespace !== config.id || definition.type !== Boolean) throw new Error("Appearance setting outside the bounded Boolean profile");
        settings.set(`${namespace}.${key}`, definition);
      },
      get: (namespace, key) => {
        if (namespace !== config.id) throw new Error(`Unsupported appearance setting namespace ${namespace}`);
        return Object.hasOwn(preferences, key) ? preferences[key] : settings.get(`${namespace}.${key}`)?.default;
      },
      set: () => { throw new Error("Use the host appearance controls; no world writes from the UI sandbox"); },
    },
  };
  globalThis.$ = (selector) => {
    const element = typeof selector === "string" ? document.querySelector(selector) : selector;
    return { removeClass: (name) => element?.classList.remove(name), addClass: (name) => element?.classList.add(name) };
  };
  const originalInsert = document.head.insertBefore.bind(document.head);
  document.head.insertBefore = (node, before) => {
    if (node instanceof HTMLLinkElement && node.rel === "stylesheet") {
      const href = node.getAttribute("href");
      const file = config.styleAliases?.[href];
      if (!file || !resources.has(file)) throw new Error(`Undeclared appearance stylesheet: ${href}`);
      const style = document.createElement("style");
      style.dataset.aisAppearanceStyle = "true";
      style.textContent = resources.get(file);
      originalInsert(style, before); return node;
    }
    return originalInsert(node, before);
  };
  function resetDom(classes = "vtt game") {
    for (const node of document.head.querySelectorAll("[data-ais-appearance-style]")) node.remove();
    document.body.className = classes;
    // These compatibility nodes never leave the sandbox or replace the real app DOM.
    document.body.innerHTML = '<div id="ui-left"><img id="logo" alt=""></div><nav class="app"><ol id="scene-list"></ol></nav><div id="interface" class="theme-dark"><aside id="sidebar" class="app"><div class="sidebar-content"><ol id="chat-log" class="chat-log"><li class="message">preview</li></ol></div></aside></div><div class="window-app app"><header class="window-header"></header><section class="window-content"></section></div>';
  }
  function appendStyle(text) {
    const node = document.createElement("style"); node.dataset.aisAppearanceStyle = "true";
    node.textContent = text; document.head.appendChild(node);
  }
  function color(value) {
    const node = document.createElement("span");
    node.style.color = value; document.body.appendChild(node);
    const resolved = getComputedStyle(node).color; node.remove();
    const channels = resolved.match(/^rgba?\(\s*(\d+(?:\.\d+)?)[, ]+\s*(\d+(?:\.\d+)?)[, ]+\s*(\d+(?:\.\d+)?)/i);
    if (!channels) throw new Error(`Appearance color did not resolve: ${value}`);
    return "#" + channels.slice(1, 4).map((v) => Math.max(0, Math.min(255, Math.round(Number(v)))).toString(16).padStart(2, "0")).join("");
  }
  const variable = (name) => {
    const value = getComputedStyle(document.body).getPropertyValue(name).trim();
    if (!value) throw new Error(`Required upstream CSS variable is missing: ${name}`);
    return color(`var(${name})`);
  };
  async function load(api) {
    for (const file of config.styles ?? []) if (!resources.has(file)) resources.set(file, await api.resources.readText(file));
  }
  globalThis.AisUiAdapter = Object.freeze({
    async compose(input, commandContext) {
      const variant = config.uiTheme.variants.find((entry) => entry.id === input.variant);
      if (!variant || !["compact", "comfortable"].includes(input.density)) throw new Error("Unknown appearance variant or density");
      await load(commandContext.ais);
      let colors, font = "sans", radius = 8, images, evidence;
      if (config.mode === "flavor-tokens") {
        resetDom();
        const preset = UpstreamFlavor.presets.find((entry) => entry.id === variant.id);
        if (!preset) throw new Error("Upstream preset is missing");
        const tokens = UpstreamFlavor.createStyleTokens({ schemaVersion: 2, foundry: { theme: preset.theme } });
        const read = (key) => color(UpstreamFlavor.getStyleToken(tokens, `foundry.theme.${key}`).value);
        colors = { background: read("surfaceBackground"), panel: read("windowBackground"), raised: read("windowHeaderBackground"),
          text: read("fontColor"), muted: read("secondaryFontColor"), accent: read("accentColor"), border: color(UpstreamFlavor.getStyleToken(tokens, "foundry.areas.scrollbars.style.color").value) };
        evidence = { mode: "Original Your Flavor token engine", tokenCount: UpstreamFlavor.flattenStyleTokens(tokens).length,
          detail: `createStyleTokens / getStyleToken executed for upstream preset ${preset.id}. Studio and Foundry layout tools are not loaded.` };
      } else if (config.mode === "crlngn-css") {
        resetDom(`vtt game crlngn-ui theme-dark ${variant.id === "default" ? "" : variant.id}`);
        for (const file of config.styles) appendStyle(resources.get(file));
        colors = { background: variable("--background"), panel: variable("--chat-dark-blue"), raised: variable("--chat-dark-bg"),
          text: variable("--color-light-1"), muted: variable("--color-text-gray-blue"), accent: variable("--color-highlights"), border: variable("--color-secondary") };
        evidence = { mode: "Original Carolingian CSS cascade", detail: `Upstream vars.css evaluated in an isolated DOM (${variant.id}). No Carolingian sidebar/carousel JavaScript is running.` };
      } else if (config.mode === "rpg-hooks") {
        resetDom(); settings.clear();
        preferences = { compactModeToggle: input.density === "compact", navigationVerticalToggle: true,
          standardLogoToggle: true, minimalUICompatibility: false, disableAllStyles: false };
        Hooks.callAll("init");
        Hooks.callAll("getSceneNavigationContext");
        Hooks.callAll("ready");
        if (document.body.classList.contains("compact-mode") !== (input.density === "compact"))
          throw new Error("The original RPG compact-mode hook did not execute");
        // These surfaces come from the original CSS, not a hand-painted substitute palette.
        const normal = document.createElement("button"); normal.className = "scene-control";
        const controls = document.createElement("ol"); controls.id = "controls"; controls.appendChild(normal); document.body.appendChild(controls);
        colors = { background: color(config.cssFacts.background), panel: color(config.cssFacts.panel), raised: color(config.cssFacts.raised),
          text: variable("--main-text-very-light-color"), muted: variable("--main-text-light-color"),
          accent: color(config.cssFacts.accent), border: variable("--border-color") };
        font = "serif"; radius = 2; images = config.images;
        evidence = { mode: "Original RPG startup/settings hooks", hooks: ["init", "getSceneNavigationContext", "ready"],
          detail: `Original rpg-ui.js ran; ${settings.size} settings registered, compact-mode=${document.body.classList.contains("compact-mode")}. Scoped shell artwork is reused.` };
      } else throw new Error("Unknown appearance adapter mode");
      return { version: 1, colors, font, radius, density: input.density, ...(images ? { images } : {}), evidence };
    },
  });
})();
