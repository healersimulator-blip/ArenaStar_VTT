import "../ui/global.css";
import "../ui/workspace/fonts.css";
import "../ui/workspace/workspace.css";
import { mount } from "svelte";
import JoinApp from "./JoinApp.svelte";
import Root from "./Root.svelte";
import type { HostApp } from "./hostBoot";
import { exposeSvelteRuntime } from "./svelteRuntime";

const target = document.getElementById("app");
if (!target) throw new Error("boot: #app container missing from index.html");

// D-475: package components (`ui.js`) read the shell's Svelte runtime from a global — published
// before either shell boots, so the first package UI import finds it.
exposeSvelteRuntime();

// Test-only (D-045): install the e2e surface IMMEDIATELY (before boot) so
// transport drivers are available the moment the page loads; the app surface
// is attached by Root once a world has booted (and re-attached after every
// Close world → Open, since the surface follows the live HostApp).
const params = new URLSearchParams(globalThis.location.search);
const e2eMode = params.has("e2e");
if (e2eMode) {
  void import("./e2eHook").then((m) => m.installE2eHook(null));
}

const joinMode = params.has("join") || globalThis.location.hash.includes("room=");

// Root owns the host boot everywhere (D-249): the start screen lists worlds and the e2e
// host route (`?e2e=1`) only skips the picker by booting the most recent world at once.
// The picker and join screen never create a GM world in the background.
const application = joinMode
  ? mount(JoinApp, { target })
  : mount(Root, {
      target,
      props: {
        autoHost: e2eMode,
        // D-473: `?e2e=1&rules=pf1e` — the fresh default world runs the first-party PF1e package.
        autoHostFirstParty: e2eMode && params.get("rules") === "pf1e",
        onApp: e2eMode
          ? async (app: HostApp | null) => {
              const hook = await import("./e2eHook");
              if (app) await hook.installE2eHook(app);
              else hook.detachE2eApp();
            }
          : null,
      },
    });

export default application;
