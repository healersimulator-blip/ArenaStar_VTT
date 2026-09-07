<script lang="ts">
  import type { DocumentStore } from "../../core/store";
  import type { ActorDocument } from "../../core/documents";

  let { doc, store }: { doc: ActorDocument; store: DocumentStore } = $props();

  let activeTab = $state<"summary" | "combat" | "skills" | "spells">("summary");

  let system = $derived(doc.system ?? {});
  let name = $derived(doc.name);

  function updateField(path: string, value: unknown) {
    store.applyEnvelope({
      txId: `tx-${Date.now()}`,
      seq: store.seq + 1,
      ops: [
        {
          kind: "update",
          ref: { coll: "actors", id: doc._id },
          diff: { [path]: value },
        },
      ],
    });
  }
</script>

<div class="pf1e-sheet">
  <header class="sheet-header">
    <h2>{name}</h2>
    <span class="system-tag">PF1e Core Sheet</span>
  </header>

  <nav class="sheet-tabs">
    <button class={activeTab === "summary" ? "active" : ""} type="button" onclick={() => (activeTab = "summary")}>Summary</button>
    <button class={activeTab === "combat" ? "active" : ""} type="button" onclick={() => (activeTab = "combat")}>Combat</button>
    <button class={activeTab === "skills" ? "active" : ""} type="button" onclick={() => (activeTab = "skills")}>Skills</button>
    <button class={activeTab === "spells" ? "active" : ""} type="button" onclick={() => (activeTab = "spells")}>Spells</button>
  </nav>

  <div class="sheet-body">
    {#if activeTab === "summary"}
      <div class="tab-summary">
        <label>
          <span>Character Name:</span>
          <input type="text" value={name} onchange={(e) => updateField("name", e.currentTarget.value)} />
        </label>
        <label>
          <span>Base Attack Bonus (BAB):</span>
          <input type="number" value={system["bab"] ?? 1} onchange={(e) => updateField("system.bab", Number(e.currentTarget.value))} />
        </label>
        <label>
          <span>Armor Class (AC):</span>
          <input type="number" value={system["ac"] ?? 10} onchange={(e) => updateField("system.ac", Number(e.currentTarget.value))} />
        </label>
        <label>
          <span>Touch AC:</span>
          <input type="number" value={system["touchAc"] ?? 10} onchange={(e) => updateField("system.touchAc", Number(e.currentTarget.value))} />
        </label>
      </div>
    {:else if activeTab === "combat"}
      <div class="tab-combat">
        <h3>Saves</h3>
        <div class="saves-grid">
          <label><span>Fortitude:</span><input type="number" value={system["fort"] ?? 0} onchange={(e) => updateField("system.fort", Number(e.currentTarget.value))} /></label>
          <label><span>Reflex:</span><input type="number" value={system["ref"] ?? 0} onchange={(e) => updateField("system.ref", Number(e.currentTarget.value))} /></label>
          <label><span>Will:</span><input type="number" value={system["will"] ?? 0} onchange={(e) => updateField("system.will", Number(e.currentTarget.value))} /></label>
        </div>
      </div>
    {:else if activeTab === "skills"}
      <div class="tab-skills">
        <label><span>Perception Modifier:</span><input type="number" value={system["perception"] ?? 0} onchange={(e) => updateField("system.perception", Number(e.currentTarget.value))} /></label>
        <label><span>Stealth Modifier:</span><input type="number" value={system["stealth"] ?? 0} onchange={(e) => updateField("system.stealth", Number(e.currentTarget.value))} /></label>
      </div>
    {:else if activeTab === "spells"}
      <div class="tab-spells">
        <label><span>Caster Level:</span><input type="number" value={system["cl"] ?? 1} onchange={(e) => updateField("system.cl", Number(e.currentTarget.value))} /></label>
      </div>
    {/if}
  </div>
</div>

<style>
  .pf1e-sheet {
    padding: 12px;
    background: #121218;
    color: #e0e0e0;
    font-size: 13px;
    height: 100%;
  }
  .sheet-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    border-bottom: 1px solid #2a2a3a;
    padding-bottom: 8px;
  }
  .system-tag {
    font-size: 10px;
    background: #2b5278;
    padding: 2px 6px;
    border-radius: 3px;
  }
  .sheet-tabs {
    display: flex;
    gap: 4px;
    margin: 10px 0;
  }
  .sheet-tabs button {
    background: #1a1a24;
    border: none;
    color: #a0a0b0;
    padding: 4px 10px;
    border-radius: 4px 4px 0 0;
    cursor: pointer;
  }
  .sheet-tabs button.active {
    background: #2b5278;
    color: white;
  }
  .sheet-body label {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 8px;
  }
  .sheet-body input {
    background: #1e1e2a;
    border: 1px solid #3a3a4c;
    color: white;
    padding: 3px 6px;
    border-radius: 3px;
    width: 120px;
  }
</style>
