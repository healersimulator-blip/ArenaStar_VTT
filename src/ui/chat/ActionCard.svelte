<script lang="ts">
  import type { ActionCard, ActionTarget } from "../../core/action";
  import type { PendingRoll } from "../../packages/pf1e/pendingRoll";
  import { isPendingExpired } from "../../packages/pf1e/pendingRoll";

  let {
    action,
    pendingRolls = [],
    currentTurn,
    isGM = false,
    canRoll,
    onRoll,
    onHighlight,
  }: {
    action: ActionCard;
    pendingRolls?: PendingRoll[];
    currentTurn: number;
    isGM?: boolean;
    canRoll: (pending: PendingRoll) => boolean;
    onRoll: (pending: PendingRoll) => void;
    onHighlight?: (kind: "initiator" | "target" | "area", id: string | null) => void;
  } = $props();

  function pendingFor(target: ActionTarget): PendingRoll | null {
    const id = target.check?.pendingRollId;
    if (!id) return null;
    return pendingRolls.find((pending) => pending.id === id) ?? null;
  }

  function outcomeLabel(target: ActionTarget): string {
    switch (target.outcome) {
      case "failedSave": return "failed save";
      case "saved": return "saved";
      case "hit": return "hit";
      case "miss": return "miss";
      case "succeeded": return "success";
      case "failed": return "failure";
      case "resisted": return "resisted";
      case "affected": return "affected";
      case "unaffected": return "unaffected";
      case "rolled": return "rolled";
      case "expired": return "expired";
      case "skipped": return "skipped";
      default: return "pending";
    }
  }

  function stateTone(state: ActionCard["state"]): string {
    if (state === "resolved") return "resolved";
    if (state === "pending") return "pending";
    if (state === "partial") return "partial";
    return "failed";
  }
</script>

<article
  class="action-card"
  data-action-card={action.id}
  data-action-kind={action.kind}
  data-action-state={action.state}
  data-action-revision={action.revision}
>
  <header>
    <div class="title-row">
      <button
        type="button"
        class="entity source"
        data-action-source
        title={`Center ${action.source.name}`}
        onclick={() => onHighlight?.("initiator", action.source.tokenId ?? action.source.actorId ?? null)}
      >{action.source.name}</button>
      <span class="verb">{action.label}</span>
      <span class:resolved={stateTone(action.state) === "resolved"}
        class:pending={stateTone(action.state) === "pending"}
        class:partial={stateTone(action.state) === "partial"}
        class:failed={stateTone(action.state) === "failed"}
        class="state" data-action-status>{action.state}</span>
    </div>
    <div class="meta">
      <span>{action.kind}</span>
      <span>revision {action.revision}</span>
      {#if action.sceneId}<span>scene {action.sceneId}</span>{/if}
    </div>
  </header>

  {#if action.area}
    <button type="button" class="area" data-action-area
      onclick={() => onHighlight?.("area", action.area?.ref?.id ?? null)}>
      {action.area.shape}
      {#if action.area.radius !== undefined} · {action.area.radius} {action.area.units ?? "units"}{/if}
    </button>
  {/if}

  {#if action.targets.length > 0}
    <div class="targets" data-action-targets>
      {#each action.targets as target (target.key)}
        {@const pending = pendingFor(target)}
        {@const expired = pending ? isPendingExpired(pending, currentTurn) : false}
        {@const rollable = pending ? canRoll(pending) && !expired : false}
        <section class="target" data-action-target={target.key} data-target-outcome={target.outcome}
          data-target-state={target.state} data-target-provenance={target.provenance ?? "reported"}>
          <div class="target-head">
            <button type="button" class="entity" data-action-target-name
              onclick={() => onHighlight?.("target", target.key)}>{target.name}</button>
            {#if target.label}<span class="target-label" data-action-target-label>{target.label}</span>{/if}
            <strong class:good={target.outcome === "saved" || target.outcome === "succeeded"}
              class:bad={target.outcome === "failedSave" || target.outcome === "failed" || target.outcome === "hit"}
              class="outcome">{outcomeLabel(target)}</strong>
          </div>
          {#if target.state !== "pending" && target.provenance !== "host"}
            <span class="reported" data-action-reported
              title="This result was submitted by a client. Outcome-conditional FX does not receive its mechanics.">
              reported result · not host-verified
            </span>
          {/if}

          {#if target.check}
            <div class="check" data-action-check={target.check.kind}>
              <span>{target.check.saveType ? target.check.saveType.toUpperCase() : target.check.kind}</span>
              <code>{target.check.formula}</code>
              {#if target.check.dc !== null}<span>vs DC {target.check.dc}</span>{/if}
              {#if target.check.status === "resolved" && target.check.total !== null}
                <span class="total" data-action-total>{target.check.total}</span>
              {:else if target.check.status === "expired"}
                <span class="muted">roll expired</span>
              {:else}
                <span class="muted">awaiting roll</span>
              {/if}
            </div>
          {/if}

          {#if pending && target.state === "pending" && !expired}
            <div class="pending-actions">
              <button type="button" class="roll" data-action-roll={pending.id ?? "legacy"}
                disabled={!rollable}
                title={rollable ? `Roll ${pending.formula} on the host` : "Only the owning player or GM may roll"}
                onclick={() => onRoll(pending)}>Roll — {pending.formula}</button>
              {#if isGM}<span class="gm-note">GM resolve uses the same host path</span>{/if}
            </div>
          {/if}

          {#if target.damage}
            <div class="effect" data-action-damage>damage {target.damage.dealt}
              {#if target.damage.prevented !== undefined} · prevented {target.damage.prevented}{/if}</div>
          {/if}
          {#if target.healing}
            <div class="effect" data-action-healing>healing {target.healing.applied}</div>
          {/if}
          {#if target.conditions?.applied?.length}
            <div class="effect" data-action-conditions>applied: {target.conditions.applied.join(", ")}</div>
          {/if}
          {#if target.notes?.length}
            <ul class="notes target-notes">
              {#each target.notes as note, noteIndex (noteIndex)}<li>{note}</li>{/each}
            </ul>
          {/if}
        </section>
      {/each}
    </div>
  {/if}

  {#if action.notes.length > 0}
    <details class="notes" data-action-notes>
      <summary>{action.notes.length} note{action.notes.length === 1 ? "" : "s"}</summary>
      <ul>{#each action.notes as note, noteIndex (noteIndex)}<li>{note}</li>{/each}</ul>
    </details>
  {/if}
</article>

<style>
  .action-card { border: 1px solid #496778; border-radius: 8px; background: #111d24; color: #e8edf0;
    padding: 8px; display: flex; flex-direction: column; gap: 7px; }
  header { display: flex; flex-direction: column; gap: 3px; }
  .title-row { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; }
  .entity { border: 0; padding: 0; background: none; color: #83c9de; text-decoration: underline;
    text-underline-offset: 2px; cursor: pointer; font-weight: 650; }
  .entity:hover { color: #b0e5f2; }
  .verb { color: #f1cb86; font-weight: 700; }
  .state { margin-left: auto; border-radius: 999px; padding: 1px 7px; font-size: .75rem; text-transform: uppercase; }
  .state.resolved { background: #173a2a; color: #79dfa5; }
  .state.pending { background: #253b5a; color: #91bcff; }
  .state.partial { background: #4b3b1c; color: #efc975; }
  .state.failed { background: #492727; color: #efa1a1; }
  .meta { display: flex; gap: 8px; color: #8799a5; font-size: .75rem; }
  .area { align-self: flex-start; border: 1px solid #4d6673; border-radius: 5px; background: #172730;
    color: #b4d5df; padding: 3px 7px; cursor: pointer; }
  .targets { display: flex; flex-direction: column; gap: 5px; }
  .target { border-left: 3px solid #385766; background: #14242c; border-radius: 4px; padding: 6px 7px;
    display: flex; flex-direction: column; gap: 4px; }
  .target-head { display: flex; align-items: baseline; gap: 8px; }
  .target-label { color: #9eb0b9; font-size: .75rem; }
  .outcome { margin-left: auto; color: #aab7bd; text-transform: uppercase; font-size: .75rem; }
  .outcome.good { color: #79dfa5; }
  .outcome.bad { color: #efa1a1; }
  .reported { align-self: flex-end; color: #efc975; font-size: .7rem; font-style: italic; }
  .check { display: flex; gap: 6px; flex-wrap: wrap; align-items: baseline; color: #aab7bd; font-size: .8rem; }
  code { color: #c4d3da; }
  .total { color: #79dfa5; border: 1px solid #347553; border-radius: 999px; padding: 0 6px; font-weight: 700; }
  .muted, .gm-note { color: #82919a; font-style: italic; font-size: .78rem; }
  .pending-actions { display: flex; gap: 7px; align-items: center; flex-wrap: wrap; }
  .roll { border: 1px solid #426da2; border-radius: 5px; background: #203d60; color: #a9ceff; padding: 4px 9px;
    cursor: pointer; }
  .roll:disabled { opacity: .45; cursor: not-allowed; }
  .effect { color: #c2cdd2; font-size: .8rem; }
  .notes { color: #9baab1; font-size: .78rem; }
  .notes summary { cursor: pointer; }
  .notes ul, ul.notes { margin: 3px 0 0; padding-left: 18px; }
</style>
