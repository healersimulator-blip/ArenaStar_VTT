<!--
  §2.3 tail (G-41 remainder, D-263) — the first-run checklist.

  The steps themselves are derived in `core/onboarding.ts` from the world's own state, so this
  component only decides how they are shown: which are still open, how many remain, and whether
  the list is out of the way. Two rules it keeps:

  · It **stays reachable**. A veteran GM collapses it, and a collapsed checklist is one short line
    that still says how many steps are open and can be reopened in one click — a first-run aid that
    disappears for good is a support question waiting to happen.
  · It **does not nag**. The open/closed choice is remembered per role (`localStorage`, the same
    place the GM's other view preferences live), and a checklist with nothing left to do offers
    itself folded so a finished table is not asked to keep looking at it.
-->
<script lang="ts">
  import { untrack } from "svelte";
  import {
    onboardingOpenByDefault,
    onboardingRemaining,
    type OnboardingStep,
  } from "../../core/onboarding";

  let {
    steps,
    storageKey = "vtt-onboarding",
    title = "Getting started",
  }: {
    steps: readonly OnboardingStep[];
    /** Where the open/closed choice is remembered — one key per shell/role. */
    storageKey?: string;
    title?: string;
  } = $props();

  const remaining = $derived(onboardingRemaining(steps));

  function storedOpen(): boolean | null {
    try {
      const raw = globalThis.localStorage?.getItem(storageKey) ?? null;
      if (raw === "0") return false;
      if (raw === "1") return true;
      return null;
    } catch {
      return null;
    }
  }

  // The *initial* list decides whether the panel starts folded, and only the initial one: a step
  // that ticks later must not fold the panel out from under a reader (untrack makes that explicit
  // rather than accidental).
  let open = $state(storedOpen() ?? untrack(() => onboardingOpenByDefault(steps)));

  function toggle(): void {
    open = !open;
    try {
      globalThis.localStorage?.setItem(storageKey, open ? "1" : "0");
    } catch {
      // a shell without storage still gets the toggle for this visit
    }
  }
</script>

<section class="onboarding" data-onboarding data-onboarding-open={open ? "true" : "false"}>
  <header>
    <h2>{title}</h2>
    <button
      type="button"
      class="toggle"
      data-onboarding-toggle
      aria-expanded={open}
      onclick={toggle}
      title={open ? "Hide the checklist" : "Show the checklist"}
    >
      {#if open}
        Hide
      {:else}
        {remaining > 0 ? `${remaining} to do` : "Done"} · Show
      {/if}
    </button>
  </header>
  {#if open}
    {#if remaining === 0}
      <p class="done" data-onboarding-complete>All set — this list can stay folded from here on.</p>
    {/if}
    <ol>
      {#each steps as step (step.id)}
        <li data-onboarding-step={step.id} data-onboarding-done={step.done ? "true" : "false"}>
          <span class="tick" aria-hidden="true">{step.done ? "✓" : "○"}</span>
          <span class="body">
            <strong>{step.title}</strong>
            <span class="hint">{step.hint}</span>
            {#if step.done}
              <span class="sr">(done)</span>
            {/if}
          </span>
        </li>
      {/each}
    </ol>
  {/if}
</section>

<style>
  .onboarding {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 8px 10px;
    border: 1px solid var(--vtt-border);
    border-radius: 6px;
    background: var(--vtt-panel-raised);
  }
  header {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 8px;
  }
  h2 {
    margin: 0;
    font-size: 11px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--vtt-muted);
  }
  .toggle {
    min-height: 0;
    padding: 2px 6px;
    border: 1px solid var(--vtt-border);
    border-radius: 4px;
    background: transparent;
    color: var(--vtt-muted);
    font-size: 11px;
    cursor: pointer;
  }
  .toggle:hover {
    color: var(--vtt-text);
    border-color: var(--vtt-border-strong);
  }
  .done {
    margin: 0;
    color: var(--vtt-muted);
    font-size: 12px;
  }
  ol {
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  li {
    display: grid;
    grid-template-columns: 16px 1fr;
    gap: 6px;
    font-size: 12px;
    line-height: 1.4;
  }
  li[data-onboarding-done="true"] strong {
    color: var(--vtt-muted);
    text-decoration: line-through;
  }
  .tick {
    color: var(--vtt-accent);
    font-family: ui-monospace, monospace;
  }
  li[data-onboarding-done="true"] .tick {
    color: #63d471;
  }
  .body {
    display: flex;
    flex-direction: column;
  }
  .hint {
    color: var(--vtt-muted);
  }
  .sr {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
  }
</style>
