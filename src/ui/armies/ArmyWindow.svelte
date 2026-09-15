<script lang="ts">
  import type { ReportDistributions } from "../../core/reportSummary";
  /**
   * §10 Army Management Window — Hierarchy / Roster / Orders / Reports tabs
   * over the local replica. Orders are embedded-doc update Ops; validation
   * feedback runs the RulesModule client-side (§12); the ready toggle rides
   * the §5A turn channel.
   */
  import { onMount } from "svelte";
  import { SvelteSet } from "svelte/reactivity";
  import type { ClientSync, ClientEvents } from "../../client/sync";
  import type { EventBus } from "../../core/events";
  import type { ArmyDocument, FactionDocument, Order, UnitDocument } from "../../core/strategic";
  import type { TurnReport } from "../../core/sim";
  import type { TurnPhaseMsg } from "../../core/messages";
  import type { RulesModule, UnitView } from "../../core/rules";
  import {
    ORDER_TEMPLATES,
    analysisReportFromReports,
    casualtySummary,
    eventsToCsv,
    filterReportEvents,
    filterRoster,
    flattenTree,
    rulesContextFromStore,
    rosterRows,
    sortRoster,
    windowRows,
    type RosterRow,
    type SortKey,
    type TreeRow,
  } from "./armyModel";
  import TurnReportTimeline from "./TurnReportTimeline.svelte";
  import PF1eBattleAnalysis from "./PF1eBattleAnalysis.svelte";
  import type { PF1eBattleReport } from "../../packages/pf1e/analytics";
  import {
    castOrderFor,
    directAttackOrder,
    enemyTargetRows,
    heroOrderCapabilities,
    orderLabel,
    type HeroOrderBuild,
  } from "./heroOrders";

  let {
    client,
    bus,
    armyId,
    rules,
    onClose,
  }: {
    client: ClientSync;
    bus: EventBus<ClientEvents>;
    armyId: string;
    rules: RulesModule | null;
    onClose: () => void;
  } = $props();

  type Tab = "tree" | "roster" | "orders" | "reports" | "analysis";
  const ROW_H = 26;

  let tab = $state<Tab>("tree");
  let treeRows = $state<TreeRow[]>([]);
  let armyName = $state("");
  let selection = $state<ReadonlySet<string>>(new Set());
  // roster
  let sortKey = $state<SortKey>("name");
  let sortDir = $state<1 | -1>(1);
  let query = $state("");
  let scrollTop = $state(0);
  let expanded = $state<ReadonlySet<string>>(new Set());
  let cols = $state<ReadonlySet<string>>(new Set(["name", "type", "strength", "live"]));
  let roster = $state<RosterRow[]>([]);
  // orders
  let feedback = $state<Record<string, string>>({});
  // reports
  let reports = $state<TurnReport[]>([]);
  let reportUnit = $state("");
  let reportType = $state("");
  // turn
  let phase = $state<TurnPhaseMsg | null>(null);
  // M10 — hero orders: the direct-target selection, the chosen spell, and where it aims.
  let heroTargetId = $state("");
  let heroSpellId = $state("");
  let heroAimMode = $state<"target" | "manual">("target");
  let heroAimX = $state("");
  let heroAimY = $state("");
  /** A control-level refusal (no target picked, unparseable coordinates) — named, never silent. */
  let heroNotice = $state("");
  /**
   * The `DocumentStore` is plain data, not Svelte state, so a template that reads it only
   * re-renders when something else it reads changes. `refresh` (every snapshot/ops/sim
   * event) bumps this counter, and the Orders tab's store-derived reads take a dependency on
   * it — otherwise an order the host echoes back never reaches the pending queue on screen.
   * (The pending list had that latent staleness before M10; nothing asserted on it until now.)
   */
  let replicaTick = $state(0);

  function army(): ArmyDocument | undefined {
    return client.store.get("armies", armyId);
  }

  /**
   * M10 — what the active module accepts from controls. Capability-gated so a campaign on a
   * module without `orderVocabulary` never renders a caster control that could only be
   * refused at resolve time.
   */
  const heroCaps = $derived(heroOrderCapabilities(rules));
  /**
   * The enemy roster a direct target can name. A plain function, like `selectedUnits()` and
   * `squadGroups()`: the replica store is not reactive state, and the window's refresh tick
   * (every `ops`/`sim`/`snapshot` event) is what re-runs these reads — a `$derived` over
   * store calls would compute once and then show a stale battlefield.
   */
  function heroTargetList() {
    if (replicaTick < 0)
      return { targets: [], undeployed: 0 }; // reactive read — see `replicaTick`
    return enemyTargetRows({
      armies: client.store.getAll("armies") as ArmyDocument[],
      factions: client.store.getAll("factions") as FactionDocument[],
      ownArmyId: armyId,
    });
  }
  function heroTargetRow() {
    const id = heroTargetId;
    return heroTargetList().targets.find((t) => t.unitId === id) ?? null;
  }
  const heroSpell = $derived(
    heroCaps.casts.find((c) => c.id === heroSpellId) ?? null,
  );
  /**
   * Seed the spell selection from the module's own registry the first time a vocabulary
   * arrives, so the select's visible choice is always the choice that will be cast — no
   * model/display divergence, and no spell name hardcoded here.
   */
  $effect(() => {
    if (heroSpellId === "" && heroCaps.casts.length > 0)
      heroSpellId = heroCaps.casts[0].id;
  });

  /** Any unit document by id, across the replica — a direct target belongs to another army. */
  function unitDocById(unitId: string): UnitDocument | null {
    for (const armyDoc of client.store.getAll("armies") as ArmyDocument[]) {
      const found = armyDoc.units.find((u) => u._id === unitId);
      if (found) return found;
    }
    return null;
  }

  /** A manual coordinate field: blank/non-numeric reads as NaN, which the builder refuses by name. */
  function heroCoord(raw: string): number {
    const trimmed = raw.trim();
    if (trimmed === "") return Number.NaN;
    const n = Number(trimmed);
    return Number.isFinite(n) ? n : Number.NaN;
  }

  /** The aim point — the target's own anchor (live replica positions), or the manual entry. */
  function heroAimPoint(): { x: number; y: number } {
    if (heroAimMode === "manual")
      return { x: heroCoord(heroAimX), y: heroCoord(heroAimY) };
    const doc = heroTargetId === "" ? null : unitDocById(heroTargetId);
    return doc === null ? { x: Number.NaN, y: Number.NaN } : anchorOf(doc);
  }

  const win = $derived(windowRows(roster.length, scrollTop, 320, ROW_H));

  function selectedUnits(): UnitDocument[] {
    if (replicaTick < 0) return []; // reactive read — see `replicaTick`
    const doc = army();
    return doc ? doc.units.filter((u) => selection.has(u._id)) : [];
  }

  function refresh(): void {
    const doc = army();
    armyName = doc?.name ?? armyId;
    treeRows = doc ? flattenTree(doc) : [];
    const pool = client.simReplica;
    const sorted = sortRoster(filterRoster(doc ?? emptyArmy(), query), sortKey, sortDir);
    roster = doc ? rosterRows({ ...doc, units: sorted }, pool, expanded) : [];
    replicaTick += 1;
  }

  function emptyArmy(): ArmyDocument {
    return {
      _id: armyId,
      type: "army",
      name: "",
      ownership: { default: 0 },
      flags: {},
      system: {},
      factionId: "",
      commander: [],
      supply: {},
      units: [],
    };
  }

  function setSelection(ids: readonly string[]): void {
    selection = new SvelteSet(ids);
  }

  // ── M07 (D-229) — leader binding. Every "unit led by a hero" starts here: the
  // token's linked actor becomes the unit's combat inputs. Player hero sheet
  // visibility is a click on the bound row. ────────────────────────────────────
  function setLeader(unit: UnitDocument, tokenId: string): void {
    client.submit([
      {
        kind: "update",
        ref: { coll: "units", id: unit._id, parent: { coll: "armies", id: armyId } },
        diff: { leaderTokenId: tokenId.length > 0 ? tokenId : null },
      },
    ]);
  }

  function sceneTokens(): Array<{ _id: string; name: string; actorId?: string }> {
    const doc = army();
    const unitSceneId = doc?.units[0]?.sceneId ?? null;
    const out: Array<{ _id: string; name: string; actorId?: string }> = [];
    const scenes = client.store.getAll("scenes") as Array<{
      _id: string;
      tokens?: Array<{ _id: string; name: string; actorId?: string }>;
    }>;
    for (const scene of scenes) {
      if (unitSceneId && scene._id !== unitSceneId) continue;
      for (const t of scene.tokens ?? []) {
        if (t.actorId) out.push({ _id: t._id, name: t.name });
      }
    }
    return out;
  }

  function toggleSelect(id: string, ev: Event): void {
    const next = new SvelteSet(selection);
    if ((ev.currentTarget as HTMLInputElement).checked) next.add(id);
    else next.delete(id);
    selection = next;
  }

  function toggleExpand(id: string): void {
    const next = new SvelteSet(expanded);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    expanded = next;
    refresh();
  }

  // ── orders (validation feedback + templates + ready) ──────────────────────

  function unitView(unit: UnitDocument): UnitView {
    const doc = army();
    return {
      id: unit._id,
      armyId,
      factionId: doc?.factionId ?? "",
      type: unit.type,
      name: unit.name,
      profile: unit.profile,
      stats: { ...unit.stats },
      orders: unit.orders,
      formation: unit.formation,
      sceneId: unit.sceneId ?? null,
      modelRange: unit.modelRange,
      leaderTokenId: unit.leaderTokenId ?? null,
      squadId: (unit as unknown as { squadId?: string | null }).squadId ?? null,
      doctrine: unit.doctrine ?? null,
      envelop: unit.envelop ?? null,
      armyInitiative:
        typeof doc?.initiative === "number" && Number.isFinite(doc.initiative)
          ? doc.initiative
          : null,
    };
  }

  // F02 — squad grouping for simultaneous fan-out (ArmyWindow squadId tag)
  function squadGroups(): Array<[string, UnitDocument[]]> {
    const doc = army();
    if (!doc) return [];
    const bySquad: Record<string, UnitDocument[]> = {};
    for (const u of doc.units) {
      const sid = (u as unknown as { squadId?: string | null }).squadId;
      if (!sid) continue;
      const bucket = bySquad[sid];
      if (bucket) bucket.push(u);
      else bySquad[sid] = [u];
    }
    return Object.entries(bySquad);
  }

  function issueToSquad(squadId: string, build: (unit: UnitDocument) => Order): void {
    const doc = army();
    if (!doc) return;
    const members = doc.units.filter((u) => (u as unknown as { squadId?: string | null }).squadId === squadId);
    if (members.length === 0) return;
    const ctx = rulesContextFromStore(client.store, members[0]?.sceneId ?? null);
    const errors: Record<string, string> = {};
    const ops: import("../../core/ops").Op[] = [];
    for (const unit of members) {
      const order = build(unit);
      if (rules) {
        const verdict = rules.validateOrder(ctx, unitView(unit), order);
        if (!verdict.ok) {
          errors[unit._id] = verdict.error;
          continue;
        }
      }
      ops.push({
        kind: "update",
        ref: { coll: "units", id: unit._id, parent: { coll: "armies", id: armyId } },
        diff: {
          "orders.pending": [order],
          "orders.issuedBy": client.user?.id ?? "",
          "orders.issuedTurn": phase ? Number(phase.turnId.split(":").pop() ?? 0) : 0,
        },
      });
    }
    feedback = errors;
    if (ops.length > 0) client.submit(ops);
  }

  function anchorOf(unit: UnitDocument): { x: number; y: number } {
    const pool = client.simReplica;
    if (!pool || !unit.modelRange) return { x: 0, y: 0 };
    let sx = 0;
    let sy = 0;
    let n = 0;
    for (let i = unit.modelRange[0]; i < Math.min(unit.modelRange[1], pool.count); i++) {
      const status = pool.status[i] ?? 0;
      if ((status & 3) !== 0) continue;
      sx += pool.x[i] ?? 0;
      sy += pool.y[i] ?? 0;
      n++;
    }
    return n === 0 ? { x: 0, y: 0 } : { x: sx / n, y: sy / n };
  }

  /** Issue an order to every selected unit, with per-unit validate feedback. */
  function issue(build: (unit: UnitDocument) => Order): void {
    const doc = army();
    if (!doc) return;
    const ctx = rulesContextFromStore(client.store, doc.units[0]?.sceneId ?? null);
    const errors: Record<string, string> = {};
    const ops: import("../../core/ops").Op[] = [];
    for (const unit of selectedUnits()) {
      const order = build(unit);
      if (rules) {
        const verdict = rules.validateOrder(ctx, unitView(unit), order);
        if (!verdict.ok) {
          errors[unit._id] = verdict.error;
          continue;
        }
      }
      ops.push({
        kind: "update",
        ref: { coll: "units", id: unit._id, parent: { coll: "armies", id: armyId } },
        diff: {
          "orders.pending": [order],
          "orders.issuedBy": client.user?.id ?? "",
          "orders.issuedTurn": phase ? Number(phase.turnId.split(":").pop() ?? 0) : 0,
        },
      });
    }
    feedback = errors;
    if (ops.length > 0) client.submit(ops);
  }

  function applyTemplate(id: string): void {
    const tpl = ORDER_TEMPLATES.find((t) => t.id === id);
    if (!tpl) return;
    issue((unit) => tpl.build(anchorOf(unit), 0));
  }

  function clearOrders(): void {
    const ops: import("../../core/ops").Op[] = [];
    for (const unit of selectedUnits()) {
      ops.push({
        kind: "update",
        ref: { coll: "units", id: unit._id, parent: { coll: "armies", id: armyId } },
        diff: { "orders.pending": [] },
      });
    }
    if (ops.length > 0) client.submit(ops);
  }

  // ── M10 — hero orders: melee against a named enemy, and pack-driven casting ──
  //
  // Both ride the exact path the template orders use: build → validate through the active
  // RulesModule (so a refused order never becomes an Op) → one embedded-doc update per unit,
  // authorized by the host. Nothing here computes a rule outcome.

  /** Issue an order the pure builders may refuse per unit; every refusal is named. */
  function issueChecked(build: (unit: UnitDocument) => HeroOrderBuild): void {
    const doc = army();
    heroNotice = "";
    if (!doc) return;
    const ctx = rulesContextFromStore(client.store, doc.units[0]?.sceneId ?? null);
    const errors: Record<string, string> = {};
    const ops: import("../../core/ops").Op[] = [];
    for (const unit of selectedUnits()) {
      const built = build(unit);
      if (!built.ok) {
        errors[unit._id] = built.reason;
        continue;
      }
      if (rules) {
        const verdict = rules.validateOrder(ctx, unitView(unit), built.order);
        if (!verdict.ok) {
          errors[unit._id] = verdict.error;
          continue;
        }
      }
      ops.push({
        kind: "update",
        ref: { coll: "units", id: unit._id, parent: { coll: "armies", id: armyId } },
        diff: {
          "orders.pending": [built.order],
          "orders.issuedBy": client.user?.id ?? "",
          "orders.issuedTurn": phase ? Number(phase.turnId.split(":").pop() ?? 0) : 0,
        },
      });
    }
    feedback = errors;
    if (ops.length > 0) client.submit(ops);
  }

  /** M10 — direct targeting (B §4.1): the selected units attack the named enemy unit. */
  function issueHeroAttack(): void {
    const row = heroTargetRow();
    if (row === null) {
      heroNotice = "pick an enemy target first";
      return;
    }
    issueChecked(() => ({ ok: true, order: directAttackOrder(row.unitId) }));
  }

  /** M10 — cast the selected pack spell at the aim point (burst) or toward it (cone/line). */
  function issueHeroCast(): void {
    const spell = heroSpell;
    if (spell === null) {
      heroNotice = "this module advertises no castable spells";
      return;
    }
    if (heroAimMode === "target" && heroTargetRow() === null) {
      heroNotice = "pick an aim source: an enemy target or manual coordinates";
      return;
    }
    // "Aim at the target" needs the target's live position, which only the sim replica has.
    // Without it the anchor reads (0, 0) for every unit — a coincident pair that would
    // silently aim a cone nowhere or a burst at the map corner, so the control says so.
    if (heroAimMode === "target" && client.simReplica === null) {
      heroNotice =
        "the battle has no live model positions yet — resolve a turn or aim with manual coordinates";
      return;
    }
    const aim = heroAimPoint();
    issueChecked((unit) =>
      castOrderFor({
        spellId: spell.id,
        targeting: spell.targeting,
        from: anchorOf(unit),
        aim,
      }),
    );
  }

  // ── G-04/D-223 — Combat_Resolver_5 doctrine controls. Doctrine rides the same
  // embedded-doc update path as orders: the resolver reads `unit.doctrine` /
  // `unit.envelop` from the UnitView the turn channel builds. ─────────────────
  function setDoctrine(unit: UnitDocument, doctrine: "advance" | "hold"): void {
    client.submit([
      {
        kind: "update",
        ref: { coll: "units", id: unit._id, parent: { coll: "armies", id: armyId } },
        diff: { doctrine },
      },
    ]);
  }

  function setEnvelop(unit: UnitDocument, envelop: boolean): void {
    client.submit([
      {
        kind: "update",
        ref: { coll: "units", id: unit._id, parent: { coll: "armies", id: armyId } },
        diff: { envelop },
      },
    ]);
  }

  function setArmyInitiative(raw: string): void {
    const value = Number.parseInt(raw, 10);
    client.submit([
      {
        kind: "update",
        ref: { coll: "armies", id: armyId },
        // Initiative is the army's d20-side modifier (Combat_Resolver_5 B12); an
        // unparseable field writes 0 rather than a silent NaN.
        diff: { initiative: Number.isFinite(value) ? value : 0 },
      },
    ]);
  }

  // ── M14 (D-224) — Battle Analysis tab over real turn data: the newest turn
  // report's summary.analytics[armyId] sheet, rebuilt purely in armyModel so
  // the logic is unit-testable outside the component. ─────────────────────────
  function analysisReport(): PF1eBattleReport | null {
    return analysisReportFromReports(reports, armyId);
  }

  function toggleReady(ready: boolean): void {
    if (phase) client.setTurnReady(phase.turnId, ready);
  }

  // ── reports ───────────────────────────────────────────────────────────────

  function filteredEvents(): import("../../core/sim").SimEvent[] {
    const out: import("../../core/sim").SimEvent[] = [];
    for (const report of reports) {
      out.push(
        ...filterReportEvents(report, {
          unitId: reportUnit || undefined,
          type: reportType || undefined,
        }),
      );
    }
    return out;
  }

  function exportCsv(): void {
    const csv = eventsToCsv(filteredEvents());
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `reports-${armyId}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5_000);
  }

  // ── lifecycle ─────────────────────────────────────────────────────────────

  onMount(() => {
    refresh();
    const offs = [
      bus.on("snapshot", refresh),
      bus.on("ops", refresh),
      bus.on("sim", refresh),
      bus.on("turnPhase", (msg) => (phase = msg)),
      bus.on("turnReport", (msg) => {
        reports = [msg.report, ...reports].slice(0, 20);
      }),
    ];
    return () => {
      for (const off of offs) off();
    };
  });
</script>

<section class="amw" data-army-window={armyId}>
  <header>
    <h2>{armyName}</h2>
    <nav>
      {#each ["tree", "roster", "orders", "reports", "analysis"] as t (t)}
        <button class:active={tab === t} onclick={() => (tab = t as Tab)} data-tab={t}>
          {t}
        </button>
      {/each}
    </nav>
    <button class="close" onclick={onClose}>✕</button>
  </header>

  {#if tab === "tree"}
    {#if squadGroups().size > 0}
      <div class="squads" data-squads>
        {#each squadGroups() as [sid, members] (sid)}
          <div class="row squad" data-squad={sid}>
            <span class="c">▣ Squad {sid}</span>
            <span class="dim">{members.length} units</span>
            <button onclick={() => setSelection(members.map((u) => u._id))} data-squad-select={sid}>select</button>
            <button onclick={() => issueToSquad(sid, () => ({ kind: "hold", stance: "defend" }))} data-squad-hold={sid}>Hold</button>
          </div>
        {/each}
      </div>
    {/if}
    <div class="tree">
      {#each treeRows as row (row.kind === "unit" ? row.unit._id : `${row.kind}:${row.kind === "army" ? row.army._id : row.type}`)}
        {#if row.kind === "army"}
          <div class="row army-row" style="padding-left: 4px">{row.army.name}</div>
        {:else if row.kind === "echelon"}
          <div class="row echelon" style="padding-left: 20px" data-echelon={row.type}>
            {row.type} · {row.count} units · {row.strength} str
          </div>
        {:else}
          <div
            class="row unit"
            style="padding-left: 36px"
            class:selected={selection.has(row.unit._id)}
            draggable="true"
            data-unit={row.unit._id}
            onclick={() => setSelection([row.unit._id])}
            ondragstart={(ev) => {
              ev.dataTransfer?.setData(
                "application/x-vtt-unit",
                JSON.stringify({ unitId: row.unit._id, fromArmyId: armyId }),
              );
            }}
          >
            {row.unit.name}{#if (row.unit as unknown as { squadId?: string | null }).squadId}<span class="c dim" data-squad-badge={row.unit._id}>{(row.unit as unknown as { squadId?: string | null }).squadId}</span>{/if}
            <span class="badges">
              <b title="strength">{row.unit.stats.strength ?? 0}</b>
              <i title="morale">m{row.unit.stats.morale ?? 0}</i>
              <u title="supply">s{row.unit.stats.supply ?? 0}</u>
            </span>
          </div>
        {/if}
      {/each}
    </div>
  {:else if tab === "roster"}
    <div class="roster">
      <div class="toolbar">
        <input placeholder="filter…" bind:value={query} oninput={refresh} data-roster-filter />
        <select bind:value={sortKey} onchange={refresh} data-roster-sort>
          {#each ["name", "type", "strength", "morale"] as k (k)}
            <option value={k}>{k}</option>
          {/each}
        </select>
        <button
          onclick={() => {
            sortDir = sortDir === 1 ? -1 : 1;
            refresh();
          }}
          data-roster-dir
        >
          {sortDir === 1 ? "↑" : "↓"}
        </button>
        {#each ["name", "type", "strength", "morale", "live"] as c (c)}
          <label class="col-toggle">
            <input
              type="checkbox"
              checked={cols.has(c)}
              onchange={(ev) => {
                const next = new SvelteSet(cols);
                if ((ev.currentTarget as HTMLInputElement).checked) next.add(c);
                else next.delete(c);
                cols = next;
              }}
            />
            {c}
          </label>
        {/each}
      </div>
      <div
        class="grid"
        onscroll={(ev) => (scrollTop = (ev.currentTarget as HTMLDivElement).scrollTop)}
        data-roster-rows
        data-total={roster.length}
      >
        <div style:height={`${roster.length * ROW_H}px`}>
          {#key win.start}
            <div style:height={`${win.padTop}px`}></div>
            {#each roster.slice(win.start, win.end) as row (row.key)}
              {#if row.kind === "unit"}
                <div
                  class="row unit"
                  class:selected={selection.has(row.unit._id)}
                  style:height={`${ROW_H}px`}
                >
                  <input
                    type="checkbox"
                    checked={selection.has(row.unit._id)}
                    onchange={(ev) => toggleSelect(row.unit._id, ev)}
                  />
                  <button
                    class="expander"
                    onclick={() => toggleExpand(row.unit._id)}
                    data-expand={row.unit._id}
                  >
                    {expanded.has(row.unit._id) ? "▾" : "▸"}
                  </button>
                  {#if cols.has("name")}<span class="c">{row.unit.name}</span>{/if}
                  {#if cols.has("type")}<span class="c dim">{row.unit.type}</span>{/if}
                  {#if cols.has("strength")}<span class="c dim">{row.unit.stats.strength ?? 0}</span
                    >{/if}
                  {#if cols.has("morale")}<span class="c dim">{row.unit.stats.morale ?? 0}</span
                    >{/if}
                  {#if cols.has("live")}<span class="c live">{row.liveStrength ?? "–"}</span>{/if}
                  <select
                    class="c leader"
                    title="Bind a hero token: the leader's actor sheet becomes this unit's combat inputs (M07)"
                    value={row.unit.leaderTokenId ?? ""}
                    onchange={(ev) => setLeader(row.unit, (ev.currentTarget as HTMLSelectElement).value)}
                    data-unit-leader={row.unit._id}
                  >
                    <option value="">— no leader —</option>
                    {#each sceneTokens() as t (t._id)}
                      <option value={t._id}>{t.name}</option>
                    {/each}
                  </select>
                </div>
              {:else if row.kind === "model"}
                <div class="row model" style:height={`${ROW_H}px`}>
                  <span class="c">#{row.modelId}</span>
                  <span class="c dim">({row.x.toFixed(1)}, {row.y.toFixed(1)})</span>
                  <span class="c dim">hp {(row.hp * 1000).toFixed(0)}‰</span>
                </div>
              {:else}
                <div class="row gap" style:height={`${ROW_H}px`}>
                  … {row.hidden} hidden models …
                </div>
              {/if}
            {/each}
            <div style:height={`${win.padBottom}px`}></div>
          {/key}
        </div>
      </div>
      <div class="bulk">
        <span>{selection.size} selected</span>
        <button
          onclick={() => issue(() => ({ kind: "hold", stance: "defend" }))}
          disabled={selection.size === 0}>Hold</button
        >
        <button onclick={() => clearOrders()} disabled={selection.size === 0}>Clear orders</button>
      </div>
    </div>
  {:else if tab === "orders"}
    <div class="orders">
      {#if squadGroups().size > 0}
        <div class="squad-orders" data-squad-orders>
          {#each [...squadGroups().entries()] as [sid, members] (sid)}
            <div class="queue" data-squad-queue={sid}>
              <h3>▣ Squad {sid} <span class="dim">({members.length} units)</span></h3>
              <div class="templates">
                <button onclick={() => issueToSquad(sid, () => ({ kind: "hold", stance: "defend" }))} data-squad-template-hold={sid}>Hold squad</button>
                <button onclick={() => issueToSquad(sid, (unit) => ({ kind: "move", path: [{ x: anchorOf(unit).x + 20, y: anchorOf(unit).y }], pace: "march" }))} data-squad-template-move={sid}>March squad</button>
              </div>
            </div>
          {/each}
        </div>
      {/if}
      <div class="ready">
        {#if phase && phase.phase === "orders"}
          <label>
            <input
              type="checkbox"
              onchange={(ev) => toggleReady((ev.currentTarget as HTMLInputElement).checked)}
            />
            Ready for turn
          </label>
          <span class="dim">
            ready: {phase.readyUsers.length ? phase.readyUsers.join(", ") : "none"}
          </span>
        {:else}
          <span class="dim">Turn phase: {phase ? phase.phase : "—"}</span>
        {/if}
        <label class="army-init">
          Army initiative
          <input
            type="number"
            style="width: 3.2rem"
            value={army()?.initiative ?? 0}
            onchange={(ev) =>
              setArmyInitiative(
                (ev.currentTarget as HTMLInputElement).value,
              )}
            data-army-initiative
          />
        </label>
      </div>
      {#each selectedUnits() as unit (unit._id)}
        <div class="queue" data-queue={unit._id}>
          <h3>{unit.name}</h3>
          {#if feedback[unit._id]}<p class="error" data-invalid={unit._id}>
              {feedback[unit._id]}
            </p>{/if}
          <ol>
            {#each unit.orders.pending as order, i (i)}
              {@const label = orderLabel(
                order,
                (id) => unitDocById(id)?.name ?? id,
              )}
              <li data-order-label={order.kind}>{label}</li>
            {/each}
          </ol>
          <div class="doctrine" data-doctrine={unit._id}>
            <label>
              Doctrine
              <select
                value={unit.doctrine ?? "advance"}
                onchange={(ev) =>
                  setDoctrine(
                    unit,
                    (ev.currentTarget as HTMLSelectElement).value === "hold"
                      ? "hold"
                      : "advance",
                  )}
                data-doctrine-select={unit._id}
              >
                <option value="advance">advance (auto-march & engage)</option>
                <option value="hold">hold (orders only)</option>
              </select>
            </label>
            <label>
              <input
                type="checkbox"
                checked={unit.envelop !== false}
                onchange={(ev) =>
                  setEnvelop(
                    unit,
                    (ev.currentTarget as HTMLInputElement).checked,
                  )}
                data-envelop-toggle={unit._id}
              />
              Envelop (wrap flanks)
            </label>
          </div>
        </div>
      {/each}
      {#if selectedUnits().length === 0}
        <p class="dim">Select units in the tree or roster.</p>
      {/if}
      {#if heroCaps.directAttack || heroCaps.casts.length > 0}
        <div class="queue hero-orders" data-hero-orders>
          <h3>Hero orders</h3>
          {#if heroNotice !== ""}
            <p class="error" data-hero-notice>{heroNotice}</p>
          {/if}
          {#if heroCaps.directAttack}
            <label>
              Direct target
              <select bind:value={heroTargetId} data-hero-target>
                <option value="">— none —</option>
                {#each heroTargetList().targets as t (t.unitId)}
                  <option value={t.unitId}
                    >{t.hero ? "★ " : ""}{t.name} · {t.armyName} · str {t.strength}</option
                  >
                {/each}
              </select>
            </label>
            <button
              onclick={issueHeroAttack}
              disabled={selectedUnits().length === 0 || heroTargetRow() === null}
              data-hero-attack>Attack target</button
            >
            {#if heroTargetRow()?.hero}
              <p class="dim" data-hero-target-hero>
                hero target — the strike resolves as a full d20 attack routine against its
                own AC (B §4.1); bodyguard and duel extensions stay L03.
              </p>
            {/if}
            {#if heroTargetList().undeployed > 0}
              <p class="dim" data-hero-undeployed>
                {heroTargetList().undeployed} enemy unit(s) hold no models on the field and
                are not targetable.
              </p>
            {/if}
          {/if}
          {#if heroCaps.casts.length > 0}
            <label>
              Spell
              <select bind:value={heroSpellId} data-hero-spell>
                {#each heroCaps.casts as c (c.id)}
                  <option value={c.id}
                    >{c.label} — {c.targeting === "point"
                      ? "point of origin"
                      : "from the caster, toward"}</option
                  >
                {/each}
              </select>
            </label>
            <label>
              Aim
              <select bind:value={heroAimMode} data-hero-aim-mode>
                <option value="target">at the direct target</option>
                <option value="manual">manual coordinates (feet)</option>
              </select>
            </label>
            {#if heroAimMode === "manual"}
              <label>
                x
                <input
                  type="text"
                  inputmode="decimal"
                  style="width: 4.5rem"
                  bind:value={heroAimX}
                  data-hero-aim-x
                />
              </label>
              <label>
                y
                <input
                  type="text"
                  inputmode="decimal"
                  style="width: 4.5rem"
                  bind:value={heroAimY}
                  data-hero-aim-y
                />
              </label>
            {/if}
            <button
              onclick={issueHeroCast}
              disabled={selectedUnits().length === 0}
              data-hero-cast>Cast</button
            >
          {/if}
        </div>
      {/if}
      <div class="templates">
        {#each ORDER_TEMPLATES as tpl (tpl.id)}
          <button
            onclick={() => applyTemplate(tpl.id)}
            disabled={selectedUnits().length === 0}
            data-template={tpl.id}
          >
            {tpl.label}
          </button>
        {/each}
      </div>
    </div>
  {:else if tab === "analysis"}
    {@const analysis = analysisReport()}
    <div class="analysis-tab" data-analysis-tab>
      {#if analysis === null}
        <p class="dim" data-analysis-empty>
          Battle analysis appears after the first resolved turn — the
          reconciliation is the turn report's own per-army sheet (M12), not a
          fixture.
        </p>
      {:else}
        <PF1eBattleAnalysis report={analysis} />
      {/if}
    </div>
  {:else}
    <div class="reports">
      <div class="toolbar">
        <select bind:value={reportUnit} data-report-unit>
          <option value="">all units</option>
          {#each army()?.units ?? [] as unit (unit._id)}
            <option value={unit._id}>{unit.name}</option>
          {/each}
        </select>
        <select bind:value={reportType} data-report-type>
          <option value="">all types</option>
          {#each [...new Set(reports.flatMap((r) => r.events.map((e) => e.type)))] as t (t)}
            <option value={t}>{t}</option>
          {/each}
        </select>
        <button onclick={exportCsv} data-export-csv>Export CSV</button>
      </div>
      {#each reports as report (report.turn)}
        {@const events = filterReportEvents(report, {
          unitId: reportUnit || undefined,
          type: reportType || undefined,
        })}
        {@const summary = casualtySummary(events)}
        {@const dist = report.summary.distributions as ReportDistributions | undefined}
        {#if events.length > 0}
          <div class="report" data-report-turn={report.turn}>
            <h3>
              Turn {report.turn} · {summary.casualties} casualties · {summary.attacks} attacks
            </h3>
            <TurnReportTimeline
              {report}
              isGm={client.user?.role === "gm" || client.user?.role === "assistant"}
              onEventFocus={(event) => {
                if (event.at) {
                  bus.call("ephemeral", {
                    type: "ping",
                    userId: client.user?.id ?? "gm",
                    sceneId: report.sceneId ?? "",
                    x: event.at.x,
                    y: event.at.y,
                  });
                }
              }}
            />
            {#if dist && (dist.totals.wounds > 0 || dist.totals.routs > 0)}
              <p class="dist" data-report-distributions>
                {Object.entries(dist.byType)
                  .map(([t, n]) => `${t} ×${n}`)
                  .join(" · ")}
                {#if dist.damageByUnit.length > 0}
                  — top: {dist.damageByUnit
                    .slice(0, 3)
                    .map((u) => `${u.unitId} ${u.wounds}w/${u.hits}h`)
                    .join(", ")}
                {/if}
                {#if Object.keys(dist.routRolls).length > 0}
                  — break rolls: {Object.entries(dist.routRolls)
                    .map(([roll, n]) => `${roll}×${n}`)
                    .join(", ")}
                {/if}
              </p>
            {/if}
            <table>
              <thead><tr><th>phase</th><th>type</th><th>unit</th><th>text</th></tr></thead>
              <tbody>
                {#each events.slice(0, 50) as e, i (i)}
                  <tr><td>{e.subPhase}</td><td>{e.type}</td><td>{e.unitId}</td><td>{e.text}</td></tr
                  >
                {/each}
              </tbody>
            </table>
          </div>
        {/if}
      {/each}
      {#if reports.length === 0}<p class="dim">No turn reports yet this session.</p>{/if}
    </div>
  {/if}
</section>

<style>
  .amw {
    position: absolute;
    top: 48px;
    left: 48px;
    width: 560px;
    max-height: 70vh;
    display: flex;
    flex-direction: column;
    background: #12161c;
    border: 1px solid #2b3138;
    border-radius: 8px;
    color: #e8ecf2;
    font-size: 12px;
    z-index: 40;
    box-shadow: 0 8px 32px rgb(0 0 0 / 45%);
  }
  header {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 12px;
    border-bottom: 1px solid #2b3138;
  }
  h2 {
    font-size: 14px;
    margin: 0 8px 0 0;
  }
  h3 {
    font-size: 12px;
    margin: 4px 0;
  }
  nav {
    display: flex;
    gap: 4px;
    flex: 1;
  }
  nav button {
    background: #1b2027;
    border: 1px solid #2b3138;
    color: #c3cad4;
    border-radius: 4px;
    padding: 3px 10px;
    cursor: pointer;
  }
  nav button.active {
    background: #2b4a6b;
    color: #fff;
  }
  .close {
    background: none;
    border: none;
    color: #8b93a1;
    cursor: pointer;
  }
  .tree,
  .orders,
  .reports {
    padding: 8px 12px;
    overflow-y: auto;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 2px 6px;
    border-radius: 4px;
  }
  .row.selected {
    background: #22344a;
  }
  .army-row {
    font-weight: 700;
  }
  .echelon {
    color: #9aa0a8;
    font-weight: 600;
  }
  .unit {
    cursor: pointer;
  }
  .badges b,
  .badges i,
  .badges u {
    font-style: normal;
    text-decoration: none;
    font-size: 10px;
    color: #8b93a1;
    margin-left: 6px;
  }
  .roster {
    display: flex;
    flex-direction: column;
  }
  .toolbar {
    display: flex;
    gap: 6px;
    align-items: center;
    padding: 6px 10px;
    border-bottom: 1px solid #2b3138;
    flex-wrap: wrap;
  }
  .toolbar select,
  .toolbar input {
    background: #1b2027;
    color: #e8ecf2;
    border: 1px solid #2b3138;
    border-radius: 4px;
    padding: 2px 6px;
  }
  .grid {
    height: 320px;
    overflow-y: auto;
  }
  .c {
    min-width: 60px;
  }
  .dim {
    color: #8b93a1;
  }
  .live {
    color: #7ec97e;
  }
  .model {
    color: #9aa0a8;
    padding-left: 60px;
  }
  .gap {
    color: #5d6672;
    padding-left: 60px;
  }
  .bulk {
    display: flex;
    gap: 8px;
    align-items: center;
    padding: 6px 10px;
    border-top: 1px solid #2b3138;
  }
  .bulk button,
  .templates button {
    background: #1b2027;
    border: 1px solid #2b3138;
    color: #c3cad4;
    border-radius: 4px;
    padding: 3px 10px;
    cursor: pointer;
  }
  .bulk button:disabled,
  .templates button:disabled {
    opacity: 0.45;
    cursor: default;
  }
  .ready {
    display: flex;
    gap: 12px;
    align-items: center;
    padding: 4px 0 10px;
  }
  .queue {
    border: 1px solid #232932;
    border-radius: 6px;
    padding: 6px 10px;
    margin-bottom: 6px;
  }
  .queue ol {
    margin: 2px 0;
    padding-left: 20px;
    color: #c3cad4;
  }
  .error {
    color: #ff8f7a;
    margin: 2px 0;
  }
  .templates {
    display: flex;
    gap: 6px;
    padding-top: 8px;
  }
  .report table {
    width: 100%;
    border-collapse: collapse;
    font-size: 11px;
  }
  .squads { padding: 6px 12px; border-bottom: 1px solid #2b3138; }
  .squad { background: #1b2430; border: 1px solid #2b3a4a; border-radius: 4px; margin-bottom: 4px; padding: 4px 6px; }
  .squad-orders { margin-bottom: 8px; }
  .report td,
  .report th {
    text-align: left;
    padding: 2px 6px;
    border-bottom: 1px solid #232932;
  }
</style>
