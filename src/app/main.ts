import { mount } from "svelte";
import App from "./App.svelte";
import JoinApp from "./JoinApp.svelte";
import Root from "./Root.svelte";
import { bootHostApp, type HostApp } from "./hostBoot";

const target = document.getElementById("app");
if (!target) throw new Error("boot: #app container missing from index.html");

// Test-only (D-045): install the e2e surface IMMEDIATELY (before boot) so
// transport drivers are available the moment the page loads; the app surface
// is attached after boot completes.
const e2eMode = new URLSearchParams(globalThis.location.search).has("e2e");
if (e2eMode) {
  void import("./e2eHook").then((m) => m.installE2eHook(null));
}

let app: HostApp | null = null;
let bootError: string | null = null;
try {
  app = await bootHostApp();
} catch (err) {
  bootError = err instanceof Error ? err.message : String(err);
}

const params = new URLSearchParams(globalThis.location.search);
const application =
  params.has("join") || params.has("e2e") || globalThis.location.hash.includes("room=")
    ? params.has("join")
      ? mount(JoinApp, { target })
      : mount(App, { target, props: { app, bootError } })
    : mount(Root, { target });

// Test-only (D-045): attach the live app to the e2e surface once booted.
if (e2eMode) {
  const { installE2eHook } = await import("./e2eHook");
  await installE2eHook(app);
}

export default application;
