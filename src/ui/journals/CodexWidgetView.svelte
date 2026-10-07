<!-- eslint-disable @typescript-eslint/no-non-null-assertion -->
<script lang="ts">
  /* eslint-disable @typescript-eslint/no-non-null-assertion */
  import type { CodexWidgetRendererProps } from "./codexWidgetRegistry";

  let {
    widget,
    view,
    resolveAsset = null,
    onOpenSheet = null,
  }: CodexWidgetRendererProps = $props();

  const config = $derived(
    widget.config && typeof widget.config === "object" && !Array.isArray(widget.config)
      ? widget.config as Record<string, unknown>
      : {},
  );
  const showRanges = $derived(config.showRanges !== false);
</script>

<section class="widget-view" data-codex-widget-rendered={widget.type} aria-label={`${widget.type} widget`}>
  {#if widget.type === "linked-entities"}
    {#if view.links.length === 0}
      <p class="empty">No linked records are available.</p>
    {:else}
      <ul class="link-list">
        {#each view.links as link (link.id)}
          <li>
            <span class="relation">{link.relation}</span>
            <strong>{link.label}</strong>
            {#if link.targetIsCodexSheet && link.targetId && onOpenSheet}
              <button type="button" class="secondary" onclick={() => onOpenSheet?.(link.targetId!)}>Open sheet</button>
            {/if}
          </li>
        {/each}
      </ul>
    {/if}
  {:else if widget.type === "quest-list"}
    {#if view.quests.length === 0}
      <p class="empty">No quests are available.</p>
    {:else}
      <ul class="quest-list">
        {#each view.quests as quest (quest.id)}
          <li>
            <strong>{quest.title}</strong>
            <span class="state">{quest.state}{quest.pinned ? " · pinned" : ""}</span>
            {#if quest.description}<p>{quest.description}</p>{/if}
            {#if quest.objectives.length}
              <ul>
                {#each quest.objectives as objective (objective.id)}
                  <li class:complete={objective.completed}>{objective.completed ? "✓" : "○"} {objective.title}</li>
                {/each}
              </ul>
            {/if}
          </li>
        {/each}
      </ul>
    {/if}
  {:else if widget.type === "image-gallery"}
    {#if view.images.length === 0}
      <p class="empty">No permitted gallery images are available.</p>
    {:else}
      <div class="gallery">
        {#each view.images as image (image.assetId)}
          <figure>
            {#if resolveAsset?.(image.assetId)}
              <img src={resolveAsset?.(image.assetId) ?? undefined} alt={image.alt || image.caption || "Campaign image"} loading="lazy" />
            {:else}
              <div class="image-placeholder" role="status">Loading permitted image…</div>
            {/if}
            {#if image.caption}<figcaption>{image.caption}</figcaption>{/if}
          </figure>
        {/each}
      </div>
    {/if}
  {:else if widget.type === "timeline"}
    {#if view.timeline.length === 0}
      <p class="empty">No timeline events have been added.</p>
    {:else}
      <ol class="timeline">
        {#each view.timeline as event (event.id)}
          <li>
            <time>{event.date}</time>
            <strong>{event.title}</strong>
            {#if event.description}<p>{event.description}</p>{/if}
          </li>
        {/each}
      </ol>
    {/if}
  {:else if widget.type === "scene-map"}
    {#if view.scene}
      <div class="scene-map">
        <strong>{view.scene.name}</strong>
        {#if view.scene.imageAssetId && resolveAsset?.(view.scene.imageAssetId)}
          <img src={resolveAsset?.(view.scene.imageAssetId) ?? undefined} alt={`Map for ${view.scene.name}`} loading="lazy" />
        {:else}
          <p class="empty">The permitted scene has no available local map image.</p>
        {/if}
      </div>
    {:else}
      <p class="empty">No readable scene is linked to this widget.</p>
    {/if}
  {:else if widget.type === "roll-table"}
    {#if view.rollTable}
      <div class="roll-table">
        <strong>{view.rollTable.name}</strong>
        <span class="state">{view.rollTable.formula}</span>
        <ul>
          {#each view.rollTable.results as result, index (index)}
            <li>
              {#if showRanges}<span class="range">{result.range[0]}–{result.range[1]}</span>{/if}
              <span>{result.text}</span>
            </li>
          {/each}
        </ul>
      </div>
    {:else}
      <p class="empty">No readable roll table is selected.</p>
    {/if}
  {:else}
    <p class="empty">This widget type or version is not installed. Its saved data is preserved but not executed.</p>
  {/if}
</section>

<style>
  .widget-view { display: grid; gap: 6px; font-size: .92em; min-width: 0; }
  .widget-view p, .widget-view ul, .widget-view ol, figure { margin: 0; }
  .empty, .state, .relation { color: #aab9c8; }
  .relation, .state { font-size: .78em; }
  .link-list, .quest-list, .roll-table ul { list-style: none; padding: 0; display: grid; gap: 5px; }
  .link-list li, .quest-list > li, .roll-table li { border: 1px solid #303d4b; border-radius: 4px; padding: 5px; display: flex; gap: 7px; align-items: center; flex-wrap: wrap; }
  .quest-list > li { align-items: flex-start; flex-direction: column; }
  .quest-list ul { padding-left: 18px; }
  .complete { color: #80d8a0; }
  .gallery { display: grid; grid-template-columns: repeat(auto-fill, minmax(110px, 1fr)); gap: 7px; }
  figure { min-width: 0; border: 1px solid #303d4b; border-radius: 4px; overflow: hidden; }
  figure img { display: block; width: 100%; max-height: 180px; object-fit: contain; background: #0b1016; }
  figcaption { padding: 4px; overflow-wrap: anywhere; }
  .image-placeholder { min-height: 90px; display: grid; place-items: center; color: #aab9c8; }
  .timeline { list-style: none; padding: 0; display: grid; gap: 7px; border-left: 2px solid #52677c; margin-left: 5px !important; }
  .timeline li { padding-left: 10px; display: grid; gap: 3px; }
  .timeline time { color: #83bce5; font-size: .8em; }
  .scene-map img { display: block; width: 100%; max-height: 240px; object-fit: contain; margin-top: 6px; background: #0b1016; }
  .roll-table li { align-items: flex-start; }
  .range { min-width: 3.2em; text-align: right; color: #aab9c8; }
  button { color: inherit; cursor: pointer; background: #202a35; border: 1px solid #43566b; border-radius: 4px; padding: 3px 6px; }
</style>
