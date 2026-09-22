<script lang="ts">
  /**
   * D-273 (plan §6, requirement 5a) — the **encounter card**: one GM-only *pending* message, or the
   * result of a roll, in the chat log where the table already looks.
   *
   * The card is the whole mechanism, deliberately: a prompt is a `MessageDocument` whispered to the
   * GM user ids, so `core/projection.ts` omits it from every player's snapshot (unit-tested), and
   * answering it is an `update` on the message itself (testable, auditable, and visible in the log
   * afterwards). No new wire, no new collection, no second window manager.
   *
   * What a card can do:
   * - **prompt** — list every eligible table (a tie is a list, never a silent first match), each with
   *   its tag mask, and a *Roll* button per candidate. With one candidate the plan calls it the
   *   "pending message": the same card, one row.
   * - **result** — the roll, the text, and the resolved entity rows the GM will place from (Phase 5
   *   owns the placement itself). A public card may carry no text at all when the scene hides names.
   */
  import { encounterPayloadOf } from "../../core/hexcrawl/encounterFlow";
  import type { MessageDocument } from "../../core/documents";

  let {
    message,
    isGM = false,
    onRoll,
    onExplore,
  }: {
    message: MessageDocument;
    isGM?: boolean;
    /** Roll this candidate now — the row's own table id. */
    onRoll?: (tableId: string) => void;
    /** A prompt may also be resolved by exploring, which is a different trigger with its own card. */
    onExplore?: () => void;
  } = $props();

  const payload = $derived(encounterPayloadOf(message));
  const answered = $derived(payload?.answered === true);
  const isPrompt = $derived(payload?.kind === "prompt");
</script>

{#if payload}
  <article
    class="encounter"
    data-encounter-card={payload.kind}
    data-encounter-cell={payload.cellKey}
    data-encounter-trigger={payload.trigger}
    data-encounter-phase={payload.phase}
    data-encounter-answered={String(answered)}
    data-encounter-gm-only={String(payload.gmOnly === true)}
  >
    <header class="head">
      {#if isPrompt}
        <strong data-encounter-title>Encounter check — hex {payload.cellKey}</strong>
      {:else}
        <strong data-encounter-title>Encounter — hex {payload.cellKey}</strong>
      {/if}
      <span class="where">{payload.trigger} · {payload.phase}</span>
      {#if payload.gmOnly}
        <span class="tag">GM only</span>
      {/if}
      {#if isPrompt}
        <span class="tag" data-encounter-candidates-count={payload.candidates.length}
          >{payload.candidates.length} eligible</span
        >
      {/if}
    </header>

    {#if payload.kind === "prompt"}
      {#if payload.candidates.length === 0}
        <p class="none" data-encounter-empty>Nothing is attached to this hex any more.</p>
      {:else}
        <ul class="cands">
          {#each payload.candidates as candidate (candidate.id)}
            <li data-encounter-candidate={candidate.id}>
              <span class="name">{candidate.name}</span>
              <span class="chips">
                {#each Object.entries(candidate.tags) as [tag, on] (tag)}
                  <span class="chip" class:off={!on} data-encounter-cand-tag={`${candidate.id}:${tag}`}
                    >{tag}</span
                  >
                {/each}
              </span>
              {#if isGM}
                <button
                  type="button"
                  data-encounter-roll={candidate.id}
                  disabled={answered}
                  title={answered ? "already answered" : ""}
                  onclick={() => onRoll?.(candidate.id)}>Roll this</button
                >
              {/if}
            </li>
          {/each}
        </ul>
        {#if answered}
          <p class="done" data-encounter-answered-line>
            Answered — rolled {payload.answeredRoll ?? "?"}. The table's cooldown is running now.
          </p>
        {:else if isGM && onExplore}
          <button type="button" data-encounter-explore onclick={() => onExplore?.()}
            >Explore this hex instead</button
          >
        {/if}
      {/if}
    {:else if payload.roll}
      <p class="rollline">
        <span class="formula" data-encounter-roll-line
          >{payload.roll.formula} → {payload.roll.roll}</span
        >
        <span class="table" data-encounter-table>{payload.roll.tableName}</span>
      </p>
      {#if payload.roll.text}
        <p class="text" data-encounter-text>{payload.roll.text}</p>
        <p class="count" data-encounter-count>×{payload.roll.count ?? 1} each</p>
      {:else}
        <p class="hidden" data-encounter-hidden>
          Something happens here — the GM has the details (this scene does not name encounters).
        </p>
      {/if}
      {#if isGM}
        <!-- D-273: the placement verb is Phase 5's (`placeEncounterTokens`); until then the
             button is present and says why, the same honesty rule the context menu follows. -->
        <button
          type="button"
          data-encounter-place
          disabled
          title="arrives with token placement (Phase 5)">Place tokens (Phase 5)</button
        >
      {/if}
    {/if}
  </article>
{/if}

<style>
  .encounter {
    border: 1px solid var(--line, #3a3a44);
    border-left: 3px solid #c96;
    border-radius: 4px;
    padding: 5px 7px;
    margin: 4px 0;
    background: rgba(255, 255, 255, 0.03);
    font: 12px/1.4 system-ui, sans-serif;
  }
  .encounter[data-encounter-gm-only="true"] {
    border-left-color: #86f;
  }
  .head {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
  }
  .where {
    opacity: 0.7;
  }
  .tag {
    border: 1px solid var(--line, #3a3a44);
    border-radius: 8px;
    padding: 0 5px;
    opacity: 0.85;
  }
  ul.cands {
    list-style: none;
    margin: 3px 0 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  li {
    display: flex;
    align-items: center;
    gap: 5px;
    flex-wrap: wrap;
  }
  .chips {
    display: inline-flex;
    gap: 3px;
  }
  .chip {
    opacity: 0.75;
    font-size: 11px;
  }
  .chip.off {
    opacity: 0.35;
    text-decoration: line-through;
  }
  button {
    background: var(--btn-bg, #26262e);
    color: inherit;
    border: 1px solid var(--line, #3a3a44);
    border-radius: 3px;
    padding: 1px 6px;
    cursor: pointer;
    font: inherit;
  }
  button:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .text {
    margin: 2px 0 0;
  }
  .count,
  .where {
    opacity: 0.7;
  }
  .done,
  .hidden,
  .none {
    margin: 3px 0 0;
    opacity: 0.8;
  }
</style>
