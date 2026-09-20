<script lang="ts">
  /**
   * §10 Help (D-256) — the rail's `?` button. Roll20's Help tool shows the shortcut sheet;
   * this is ours: the rail's own keys plus the gesture modifiers the tools honour. It reads
   * the live binding map, so a rebound action shows its new combo.
   */
  import { DEFAULT_BINDINGS } from "../../core/keys";
  import {
    APP_LICENSE_NOTE,
    CONTENT_NOTICE_NOTE,
    CONTENT_SOURCE_CREDITS,
  } from "../../core/credits";

  let {
    bindings = DEFAULT_BINDINGS,
    isGM = false,
  }: {
    bindings?: Readonly<Record<string, string>>;
    isGM?: boolean;
  } = $props();

  const toolKeys: Array<{ keys: string; action: string }> = [
    { keys: "V or S", action: "Select" },
    { keys: "H or A", action: "Pan / hand" },
    { keys: "D or F", action: "Draw" },
    { keys: "T", action: "Text label" },
    { keys: "Q or M", action: "Measure" },
    { keys: "R", action: "Dice" },
    { keys: "X", action: "Recall the last measurement (measure tool active)" },
    { keys: "Escape", action: "Back to Select · finishes a polygon or a measure" },
  ];

  const gmKeys: Array<{ keys: string; action: string }> = [
    { keys: "G", action: "Hide / reveal mask brush" },
    { keys: "W", action: "Walls & doors" },
    { keys: "L", action: "Lighting" },
    { keys: "P", action: "Place pin" },
    { keys: "O", action: "Objects & tokens layer" },
    { keys: "K", action: "GM info layer" },
    { keys: ",", action: "Dynamic lighting layer" },
    { keys: "Shift+M", action: "Map & background layer" },
    { keys: "U or Y", action: "Add the selection to the turn order / open it" },
  ];

  const gestures: Array<{ keys: string; action: string }> = [
    { keys: "Alt + drag", action: "Ellipse instead of a rectangle (draw tool)" },
    { keys: "Shift + drag", action: "Snap the shape to the grid" },
    { keys: "Right-click or Escape", action: "Finish a polygon or a fog brush" },
    { keys: "Ctrl + click", action: "Add a ruler waypoint (max 12) · Alt+click pings" },
    { keys: "Middle / right / Shift + drag", action: "Pan the map from any tool" },
    { keys: "Double-click a label", action: "Edit it (text tool)" },
    { keys: "Click a door (wall tool, GM info)", action: "Open or close it · a locked door ignores the click" },
    { keys: "Alt + click a wall (GM info)", action: "Erase that wall" },
    { keys: "Click a map pin", action: "Tooltip · double-click opens the linked handout" },
    { keys: "Alt + wheel", action: "Zoom · Ctrl+A selects the layer's content" },
  ];
</script>

<div class="help" data-help-panel>
  <section>
    <h4>Tools</h4>
    <dl>
      {#each toolKeys as row (row.keys)}
        <dt>{row.keys}</dt>
        <dd>{row.action}</dd>
      {/each}
    </dl>
  </section>
  {#if isGM}
    <section>
      <h4>GM tools</h4>
      <dl>
        {#each gmKeys as row (row.keys)}
          <dt>{row.keys}</dt>
          <dd>{row.action}</dd>
        {/each}
      </dl>
    </section>
  {/if}
  <section>
    <h4>Gestures</h4>
    <dl>
      {#each gestures as row (row.keys)}
        <dt>{row.keys}</dt>
        <dd>{row.action}</dd>
      {/each}
    </dl>
  </section>
  <section>
    <h4>Bindings</h4>
    <dl>
      {#each Object.entries(bindings) as [action, combo] (action)}
        <dt>{combo}</dt>
        <dd>{action}</dd>
      {/each}
    </dl>
  </section>
  <section data-credits>
    <h4>Licences &amp; credits</h4>
    <p class="prose">{APP_LICENSE_NOTE}</p>
    <p class="prose">{CONTENT_NOTICE_NOTE}</p>
    <dl>
      {#each CONTENT_SOURCE_CREDITS as source (source.id)}
        <dt>{source.commit}</dt>
        <dd>
          <span class="source">{source.id}</span> — {source.license}
          <span class="url">{source.url.replace("https://", "")}</span>
        </dd>
      {/each}
    </dl>
  </section>
</div>

<style>
  .help {
    display: flex;
    flex-direction: column;
    gap: 10px;
    font-size: 12px;
    color: #dbe3f0;
  }
  h4 {
    margin: 0 0 4px;
    font-size: 11px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: #8b94a8;
  }
  dl {
    display: grid;
    grid-template-columns: 150px 1fr;
    gap: 3px 8px;
    margin: 0;
  }
  dt {
    font-family: ui-monospace, monospace;
    color: #ffd479;
  }
  dd {
    margin: 0;
    color: #c8d1e0;
  }
  .prose {
    margin: 0;
    color: #a8b2c4;
    line-height: 1.45;
  }
  .source {
    font-family: ui-monospace, monospace;
    color: #c8d1e0;
  }
  .url {
    display: block;
    color: #7c869a;
    font-size: 11px;
  }
</style>
