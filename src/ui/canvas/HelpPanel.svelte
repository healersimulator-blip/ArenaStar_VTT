<script lang="ts">
  /**
   * §10 Help (D-256) — the rail's `?` button. Roll20's Help tool shows the shortcut sheet;
   * this is ours: the rail's own keys plus the gesture modifiers the tools honour. It reads
   * the live binding map, so a rebound action shows its new combo.
   */
  import { agentHelp } from "../../core/agents/help";
  import { DEFAULT_BINDINGS } from "../../core/keys";
  import { NO_ONBOARDING_FACTS, onboardingSteps } from "../../core/onboarding";
  import { RULES_REFERENCE_LINKS } from "../../core/docs";
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

  // §2.3 tail (D-263): the same ordered steps the sidebar's checklist ticks off, shown here
  // unticked — a GM who folded the checklist away still needs to know where to start.
  const steps = $derived(onboardingSteps(NO_ONBOARDING_FACTS, isGM ? "GM" : "PLAYER"));

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

  /**
   * D-276 (plan §8 Phase 7) — the hexcrawl's own sheet. Shown whether or not the open scene is
   * one: a GM who has not made a hexcrawl map yet still needs to know the key exists, and the
   * rows say which of them are theirs. The prose is the model, not the buttons — the buttons
   * are labelled where they stand, and what a GM actually forgets is that the *clock* walks the
   * party and that a hex keeps the hours spent in it.
   */
  /** §10 Agents — read from the catalogue, so the counts on the page cannot drift. */
  const agentsPage = agentHelp();

  const hexcrawlKeys: Array<{ keys: string; action: string }> = [
    { keys: "Right-click a hex", action: "The hex menu: description, terrain, features, tables (GM)" },
    { keys: "Shift+H", action: "Open the hex the party is standing in" },
    { keys: "Y", action: "Travel path — click hexes to draw the party's route (GM)" },
    { keys: "Escape", action: "Give up the route being drawn (the tool stays armed)" },
  ];
</script>

<div class="help" data-help-panel>
  <section data-help-start>
    <h4>Getting started</h4>
    <ol class="steps">
      {#each steps as step (step.id)}
        <li data-help-step={step.id}>
          <strong>{step.title}</strong>
          <span class="prose">{step.hint}</span>
        </li>
      {/each}
    </ol>
  </section>
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
  <section data-help-hexcrawl>
    <h4>Hexcrawl maps</h4>
    <p class="prose">
      A hexcrawl scene is one overland map the party walks across. Right-click a hex to work on it
      and use <em>Travel path</em> to draw a route; <em>Commit route</em> prices it cell by cell off
      the terrain, and the travel panel's buttons then spend the <strong>world clock</strong> — the
      party walks as far as that buys and camps where the road ends. Every hex keeps the hours the
      party spent in it, which is what a hidden feature's <em>time</em> rule reads: a shrine that
      waits for two days of travelling gives itself up on the third and says so in the chat.
    </p>
    <dl>
      {#each hexcrawlKeys as row (row.keys)}
        <dt>{row.keys}</dt>
        <dd>{row.action}</dd>
      {/each}
    </dl>
  </section>
  <!--
    §10 Agents (D-290) — the page is data (`src/core/agents/help.ts`), and its numbers are read
    from the capability catalogue, so a preset that changed is a count this page gets right
    instead of a count a GM acts on wrongly. Players see it too: the people an agent reads about
    are owed what it can see. Only the granting rows are the GM's.
  -->
  <section data-help-agents>
    <h4>{agentsPage.title}</h4>
    {#each agentsPage.prose as line (line)}
      <p class="prose">{line}</p>
    {/each}
    <dl>
      {#each agentsPage.rows as row (row.term)}
        <dt>{row.term}</dt>
        <dd>{row.detail}</dd>
      {/each}
    </dl>
    <h4>The four kinds of agent</h4>
    <dl>
      {#each agentsPage.presets as preset (preset.id)}
        <dt>{preset.id} · role {preset.role} · {preset.count} capabilities</dt>
        <dd>{preset.note}</dd>
      {/each}
    </dl>
    {#if isGM}
      <h4>Granting and revoking</h4>
      <dl>
        {#each agentsPage.gmRows as row (row.term)}
          <dt>{row.term}</dt>
          <dd>{row.detail}</dd>
        {/each}
      </dl>
    {/if}
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
  <section data-help-links>
    <h4>Rules reference</h4>
    <p class="prose">
      This app is a table, not a rules engine of record: where a number is contested, these are
      the pages the tables it is built from cite.
    </p>
    <dl>
      {#each RULES_REFERENCE_LINKS as link (link.id)}
        <dt>
          <a data-help-link={link.id} href={link.url} target="_blank" rel="noopener noreferrer"
            >{link.label}</a
          >
        </dt>
        <dd>{link.note}</dd>
      {/each}
    </dl>
    <p class="prose" data-help-docs-note>
      The design documents behind this app ship with its source repository, not inside the build.
      What does ship beside the content is the notices: <span class="source">OGL.txt</span> and
      <span class="source">CREDITS.md</span> inside every content package and world zip (see the
      credits below).
    </p>
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
  .steps {
    display: flex;
    flex-direction: column;
    gap: 4px;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  li {
    display: flex;
    flex-direction: column;
  }
  a {
    color: #66b7ff;
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
