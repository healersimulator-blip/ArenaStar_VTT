<script lang="ts">
  import { onMount, tick, untrack } from "svelte";
  import type { AisAppearance, AppearanceState, ThemeReview } from "../../app/aisAppearance";
  import type { UiThemeCatalog } from "../../core/uiTheme";
  import Icon from "../icons/Icon.svelte";

  let { controller, onClose }: { controller: AisAppearance; onClose: () => void } = $props();
  let state = $state.raw<AppearanceState>(untrack(() => controller.snapshot));
  let review = $state.raw<{ theme: UiThemeCatalog; packages: ThemeReview[] } | null>(null);
  let reviewed = $state(false);
  let localError = $state("");
  let working = $state(false);
  let variant = $state("default");
  let dialog: HTMLElement;
  onMount(() => {
    const unsubscribe = controller.subscribe((next) => { state = next; });
    const previous = document.activeElement as HTMLElement | null;
    (dialog as HTMLDialogElement).showModal();
    dialog.focus();
    // Confirmation controls disappear after activation. Capture recovery keys even if
    // their removal temporarily leaves focus on body rather than inside the dialog.
    const recover = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onClose(); }
      else if (event.ctrlKey && event.altKey && event.code === "Digit0") {
        event.preventDefault(); event.stopPropagation(); void native();
      }
    };
    window.addEventListener("keydown", recover, true);
    return () => {
      window.removeEventListener("keydown", recover, true);
      (dialog as HTMLDialogElement).close();
      unsubscribe(); previous?.focus();
    };
  });
  async function choose(theme: UiThemeCatalog) {
    localError = ""; working = true;
    variant = state.preferences.selected === theme.id ? state.preferences.variant : theme.variants[0]?.id ?? "default";
    try {
      if (await controller.needsReview(theme.id)) {
        review = { theme, packages: await controller.reviews(theme.id) }; reviewed = false;
        await tick();
        dialog.querySelector("[data-theme-review]")?.scrollIntoView({ block: "nearest" });
      } else await controller.apply({ ...state.preferences, selected: theme.id, variant });
    } catch (error) { localError = String(error instanceof Error ? error.message : error); }
    finally { working = false; }
  }
  async function confirm() {
    if (!review || !reviewed) return;
    working = true; localError = "";
    try {
      await controller.approveAndApply(review.packages, { ...state.preferences, selected: review.theme.id, variant });
      review = null;
    } catch (error) { localError = error instanceof Error ? error.message : String(error); }
    finally { working = false; }
  }
  function action(work: Promise<void>): void {
    void work.catch((error) => { localError = error instanceof Error ? error.message : String(error); });
  }
  async function native() {
    review = null; localError = "";
    try { await controller.reset(); } catch (error) { localError = String(error); }
  }
</script>

<div class="appearance-backdrop" role="presentation">
  <dialog class="appearance-dialog" aria-modal="true" aria-labelledby="appearance-title" tabindex="-1"
    bind:this={dialog} data-appearance-panel data-ais-protected
    oncancel={(event) => { event.preventDefault(); onClose(); }} onkeydown={(event) => {
      event.stopPropagation();
      if (event.ctrlKey && event.altKey && event.code === "Digit0") { event.preventDefault(); void native(); }
      if (event.key !== "Tab") return;
      const controls = [...dialog.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), select:not([disabled]), a[href], summary')].filter((node) => node.offsetParent !== null);
      const first = controls[0], last = controls.at(-1);
      if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog)) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }}>
    <header>
      <div><span class="eyebrow">YOUR TABLE, YOUR INTERFACE</span><h2 id="appearance-title">Make room for the game.</h2></div>
      <button class="close" aria-label="Close interface selector" onclick={onClose}><Icon name="close" /></button>
    </header>
    <p class="intro">Choose an adapted Foundry appearance. Your map, rules and documents stay in ArenaStar.</p>
    <div class="layout-controls">
      <label>Density <select data-appearance-density value={state.preferences.density} disabled={state.busy || working}
        onchange={(event) => action(controller.layout(event.currentTarget.value === "compact" ? "compact" : "comfortable", state.preferences.sidebarWidth))}>
        <option value="compact">Compact · more table</option><option value="comfortable">Comfortable · larger controls</option>
      </select></label>
      <label>Sidebar <select data-appearance-width value={state.preferences.sidebarWidth} disabled={state.busy || working}
        onchange={(event) => action(controller.layout(state.preferences.density, Number(event.currentTarget.value)))}>
        <option value={280}>Narrow · 280 px</option><option value={300}>Balanced · 300 px</option><option value={340}>Wide · 340 px</option><option value={380}>Reading · 380 px</option>
      </select></label>
      <button class="native" data-appearance-reset onclick={() => void native()}>Native appearance</button>
    </div>
    {#if state.themes.length === 0}<p>No UI theme packages are installed in this world. Import a prepared UI-module world or package in Settings → Packages.</p>{/if}
    <div class="theme-grid">
      {#each state.themes as theme (theme.id)}
        <article class:active={state.active === theme.id} data-theme-card={theme.id}>
          <div class="swatch" style={`--sample-bg:${theme.swatches[0]};--sample-panel:${theme.swatches[1]};--sample-accent:${theme.swatches[2]}`} aria-hidden="true">
            <div class="sample-head"><span></span><i></i><i></i><i></i></div><div class="sample-map"><b>✦</b><b>✦</b></div>
            <div class="sample-side"><i></i><i></i><i></i><em></em></div>
          </div>
          <div class="card-body">
            <div class="card-title"><h3>{theme.name}</h3>{#if state.active === theme.id}<span class="live">Active</span>{/if}</div>
            <p>{theme.description}</p>
            <span class="mode">{theme.mode}</span>
            <button class="choose" data-theme-activate={theme.id} disabled={working || state.busy} onclick={() => void choose(theme)}>
              {state.active === theme.id ? "Selected" : "Use this appearance"}<span aria-hidden="true">→</span>
            </button>
            {#if state.active === theme.id && theme.variants.length > 1}
              <label class="variant">Palette <select data-theme-variant={theme.id} value={state.preferences.variant} disabled={working || state.busy}
                onchange={(event) => action(controller.apply({ ...state.preferences, variant: event.currentTarget.value }))}>
                {#each theme.variants as item (item.id)}<option value={item.id}>{item.name}</option>{/each}
              </select></label>
            {/if}
            <details class="scope"><summary>What's connected?</summary>
              <p>Source v{theme.sourceVersion} · {theme.sourceCommit.slice(0, 10)}</p>
              <a href={theme.sourceUrl} target="_blank" rel="noopener noreferrer">Upstream project ↗</a>
              <p>Not ported: {theme.exclusions.join("; ")}.</p>
            </details>
          </div>
        </article>
      {/each}
    </div>
    {#if working || state.busy}<p role="status" class="progress">{review ? "Preparing reviewed appearance…" : "Connecting the selected module through AIS…"}</p>{/if}
    {#if localError || state.error}<p role="alert" class="error" data-appearance-error>{localError || state.error}</p>{/if}
    {#if state.spec}<p class="evidence" data-theme-evidence>{state.spec.evidence.mode} · {state.spec.evidence.detail}</p>{/if}
    {#if review}
      <section class="review" aria-label="Appearance code approval" data-theme-review>
        <h3>Review before connecting {review.theme.name}</h3>
        <p>Both packages run in an opaque AIS sandbox. This grants appearance computation and access to their own declared resources—not world edits or access to the app DOM.</p>
        {#each review.packages as pkg (pkg.id)}
          <details><summary>{pkg.name} · {pkg.hash.slice(0, 16)}…</summary><pre>{pkg.source}</pre></details>
        {/each}
        <label class="consent"><input type="checkbox" bind:checked={reviewed} data-theme-consent /> I reviewed these exact packages and allow their appearance-only capabilities on this device.</label>
        <div class="review-actions"><button onclick={() => { review = null; }}>Cancel</button><button data-theme-confirm disabled={!reviewed || working} onclick={() => void confirm()}>Approve & activate</button></div>
      </section>
    {/if}
    <footer><span>Appearance only. Native recovery controls stay outside module styling.</span><span>Reset: Ctrl + Alt + 0</span></footer>
  </dialog>
</div>

<style>
  .appearance-backdrop { display:contents; }
  .appearance-dialog::backdrop { background:#050b12a6; backdrop-filter:blur(5px); }
  .appearance-dialog { position:fixed; inset:50% auto auto 50%; transform:translate(-50%,-50%); margin:0; width:min(990px,calc(100% - 48px)); max-height:calc(100dvh - 48px); overflow:auto; background:#101b26; color:#edf3f7; border:1px solid #425264; border-radius:18px; padding:24px; box-shadow:0 24px 90px #0008; font:14px/1.5 Inter,system-ui,sans-serif; outline:none; }
  header { display:flex; gap:16px; justify-content:space-between; align-items:start; } h2 { margin:5px 0 0; font-size:28px; letter-spacing:-.025em; color:#f6fafc; }
  .eyebrow { font-size:10px; letter-spacing:.16em; color:#7cdcc6; font-weight:700; } .intro { margin:8px 0 20px; color:#b7c6d4; }
  button,select { font:inherit; min-height:34px; border-radius:7px; border:1px solid #405266; background:#1b2b3b; color:#edf3f7; cursor:pointer; }
  button { padding:7px 12px; } button:disabled { opacity:.55; cursor:wait; } button:hover:not(:disabled) { border-color:#8cd4c5; }
  .close { display:grid; place-items:center; width:34px; height:34px; padding:0; } .layout-controls { display:flex; align-items:end; gap:14px; flex-wrap:wrap; padding:14px; border:1px solid #304152; border-radius:10px; background:#142230; margin-bottom:20px; }
  label { display:grid; gap:5px; color:#c5d2de; font-size:12px; } select { padding:5px 9px; } .native { margin-left:auto; }
  .theme-grid { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:14px; } article { border:1px solid #34475a; border-radius:12px; overflow:hidden; background:#142332; }
  article.active { border-color:#7ddbc7; box-shadow:0 0 0 1px #7ddbc7; } .swatch { height:132px; background:var(--sample-bg); padding:14px; position:relative; }
  .sample-head { position:absolute; top:13px; left:14px; right:14px; height:18px; background:var(--sample-panel); border-bottom:1px solid var(--sample-accent); display:flex; gap:5px; padding:4px 7px; }
  .sample-head span { height:5px; width:32%; background:var(--sample-accent); margin-right:auto; border-radius:2px; } .sample-head i { width:7px; height:7px; background:var(--sample-accent); border-radius:2px; }
  .sample-map { position:absolute; left:14px; top:37px; width:60%; height:77px; background:repeating-linear-gradient(0deg,#ffffff05 0 1px,transparent 1px 16px),repeating-linear-gradient(90deg,#ffffff05 0 1px,transparent 1px 16px); border:1px solid #ffffff12; }
  .sample-map b { position:absolute; color:var(--sample-accent); top:12px; left:24px; font-size:21px; } .sample-map b+b { top:43px; left:66px; }
  .sample-side { position:absolute; right:14px; top:37px; width:26%; height:77px; background:var(--sample-panel); padding:9px 6px; border-radius:3px; }
  .sample-side i { display:block; height:3px; margin-bottom:7px; background:var(--sample-accent); opacity:.7; } .sample-side em { display:block; margin-top:12px; height:13px; background:var(--sample-accent); border-radius:2px; }
  .card-body { padding:14px; } .card-title { display:flex; justify-content:space-between; align-items:center; gap:5px; } h3 { margin:0; font-size:17px; color:#f0f6fa; } .card-body>p { min-height:42px; font-size:12px; color:#b8c9d6; }
  .live { color:#86e4c7; font-size:10px; text-transform:uppercase; letter-spacing:.08em; } .mode { display:block; color:#b4c8df; font-size:10px; margin-bottom:12px; }
  .choose { width:100%; display:flex; justify-content:space-between; font-size:12px; } article.active .choose { background:#264b48; color:#a8f2de; }
  .variant { margin-top:12px; } .scope { font-size:11px; color:#9db3c7; margin-top:12px; } .scope summary { cursor:pointer; } a { color:#8eddd0; }
  .evidence,footer { font-size:11px; color:#a6bbcd; } .evidence { border-left:2px solid #81cbbc; padding-left:10px; margin-top:18px; } footer { display:flex; justify-content:space-between; gap:16px; margin-top:20px; }
  .review { margin-top:18px; padding:18px; background:#1b2c3e; border:1px solid #587390; border-radius:10px; } .review p { color:#c7d4e0; font-size:13px; }
  .review details { margin:8px 0; font-size:12px; } pre { max-height:200px; overflow:auto; white-space:pre-wrap; overflow-wrap:anywhere; background:#0a131e; padding:10px; font-size:11px; }
  .consent { display:flex; align-items:flex-start; margin:16px 0; font-size:13px; } .consent input { margin-top:4px; } .review-actions { display:flex; justify-content:flex-end; gap:10px; }
  .error { color:#ffb9b9; background:#4b2330; padding:10px; border-radius:7px; } .progress { color:#b5e9d9; }
  @media(max-width:720px) { .appearance-dialog { width:calc(100% - 16px); max-height:calc(100dvh - 16px); padding:16px; } .theme-grid { grid-template-columns:1fr; } .swatch { height:100px; } footer { display:block; } h2 { font-size:23px; } }
</style>
