<script lang="ts">
  import type { ActorDocument } from "../../core/documents";
  import type { ClientSync } from "../../client/sync";
  import type { PF1eDerivedSkill, PF1eSkillId } from "../../packages/pf1e/skills";
  import { PF1E_SKILLS } from "../../packages/pf1e/skills";
  import { pf1eSkillEdit } from "./pf1eSheetModel";

  let {
    doc,
    editable,
    client,
    derivedSkills,
    onRoll,
  }: {
    doc: ActorDocument;
    editable: boolean;
    client: ClientSync;
    derivedSkills: Record<PF1eSkillId, PF1eDerivedSkill>;
    onRoll: (skill: PF1eDerivedSkill, type: "normal" | "take10" | "take20") => void;
  } = $props();

  let filter = $state<"all" | "trained" | "class">("all");
  let query = $state("");

  const skillList = $derived.by(() => {
    return PF1E_SKILLS.map((def) => derivedSkills[def.id] ?? {
      id: def.id,
      name: def.name,
      ability: def.ability,
      abilityMod: 0,
      ranks: 0,
      classSkill: false,
      classSkillBonus: 0,
      armorCheckPenalty: 0,
      effectBonus: 0,
      customBonus: 0,
      total: 0,
      trainedOnly: def.trainedOnly,
      isUsable: !def.trainedOnly,
      canTake10: def.canTake10,
      canTake20: def.canTake20,
    }).filter((s) => {
      if (filter === "trained" && s.ranks === 0) return false;
      if (filter === "class" && !s.classSkill) return false;
      if (query && !s.name.toLowerCase().includes(query.toLowerCase())) return false;
      return true;
    });
  });

  function updateRanks(skillId: string, val: string): void {
    const ranks = Math.max(0, parseInt(val, 10) || 0);
    const res = pf1eSkillEdit(doc, client.user, skillId, { ranks });
    if (res.ops.length > 0) client.submit(res.ops);
  }

  function toggleClassSkill(skillId: string, current: boolean): void {
    const res = pf1eSkillEdit(doc, client.user, skillId, { classSkill: !current });
    if (res.ops.length > 0) client.submit(res.ops);
  }
</script>

<div class="skills-tab" data-pf1e-skills-tab>
  <header class="skills-header">
    <h4>Skills</h4>
    <div class="controls">
      <input
        type="search"
        placeholder="Filter skills..."
        bind:value={query}
        class="search-input"
      />
      <div class="filter-buttons">
        <button
          type="button"
          class:active={filter === "all"}
          onclick={() => (filter = "all")}>All</button>
        <button
          type="button"
          class:active={filter === "trained"}
          onclick={() => (filter = "trained")}>Trained</button>
        <button
          type="button"
          class:active={filter === "class"}
          onclick={() => (filter = "class")}>Class</button>
      </div>
    </div>
  </header>

  <p class="note">
    Class skill bonus (+3) applies when ranks ≥ 1. Armor check penalty applies to Str & Dex skills.
  </p>

  <table class="skills-table">
    <thead>
      <tr>
        <th scope="col" title="Class skill">CS</th>
        <th scope="col">Skill Name</th>
        <th scope="col">Abil</th>
        <th scope="col">Mod</th>
        <th scope="col">Ranks</th>
        <th scope="col">ACP</th>
        <th scope="col">Bonus</th>
        <th scope="col">Roll</th>
      </tr>
    </thead>
    <tbody>
      {#each skillList as s (s.id)}
        <tr class:untrained={s.trainedOnly && s.ranks === 0} data-skill-row={s.id}>
          <td class="cs-cell">
            <input
              type="checkbox"
              checked={s.classSkill}
              disabled={!editable}
              title={s.classSkill ? "Class Skill (+3 with ≥1 rank)" : "Cross-Class Skill"}
              onchange={() => toggleClassSkill(s.id, s.classSkill)}
            />
          </td>
          <td class="name-cell">
            <span class="skill-name">{s.name}</span>
            {#if s.trainedOnly}<span class="badge-trained" title="Trained Only">T</span>{/if}
          </td>
          <td class="abil-cell">{s.ability.toUpperCase()}</td>
          <td class="mod-cell" data-skill-total={s.id}>
            <strong>{s.total >= 0 ? `+${s.total}` : s.total}</strong>
          </td>
          <td class="ranks-cell">
            <input
              type="number"
              min="0"
              max="20"
              value={s.ranks}
              disabled={!editable}
              data-skill-ranks={s.id}
              onchange={(e) => updateRanks(s.id, e.currentTarget.value)}
            />
          </td>
          <td class="acp-cell">
            {s.armorCheckPenalty < 0 ? s.armorCheckPenalty : "—"}
          </td>
          <td class="breakdown-cell">
            <span class="breakdown" title="Ability + Ranks + ClassBonus + ACP + Effects">
              {s.abilityMod >= 0 ? `+${s.abilityMod}` : s.abilityMod}
              {s.ranks > 0 ? ` +${s.ranks}r` : ""}
              {s.classSkillBonus > 0 ? ` +${s.classSkillBonus}cs` : ""}
              {s.effectBonus !== 0 ? ` ${s.effectBonus > 0 ? `+${s.effectBonus}` : s.effectBonus}fx` : ""}
            </span>
          </td>
          <td class="roll-cell">
            <button
              type="button"
              class="roll-btn"
              data-skill-roll={s.id}
              disabled={!s.isUsable}
              onclick={() => onRoll(s, "normal")}
            >
              Roll
            </button>
            {#if s.canTake10}
              <button
                type="button"
                class="take-btn"
                title="Take 10"
                disabled={!s.isUsable}
                onclick={() => onRoll(s, "take10")}
              >
                10
              </button>
            {/if}
            {#if s.canTake20}
              <button
                type="button"
                class="take-btn"
                title="Take 20"
                disabled={!s.isUsable}
                onclick={() => onRoll(s, "take20")}
              >
                20
              </button>
            {/if}
          </td>
        </tr>
      {/each}
    </tbody>
  </table>
</div>

<style>
  .skills-tab {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 6px 0;
  }
  .skills-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    flex-wrap: wrap;
    gap: 8px;
  }
  .skills-header h4 {
    margin: 0;
  }
  .controls {
    display: flex;
    gap: 8px;
    align-items: center;
  }
  .search-input {
    background: #171f2b;
    border: 1px solid #3d4f66;
    color: #fff;
    padding: 4px 8px;
    border-radius: 4px;
    font-size: 0.85rem;
  }
  .filter-buttons button {
    background: #232e3d;
    border: 1px solid #3d4f66;
    color: #9eafc5;
    padding: 3px 8px;
    cursor: pointer;
    font-size: 0.8rem;
  }
  .filter-buttons button.active {
    background: #2d5a88;
    color: #fff;
    border-color: #437ab3;
  }
  .note {
    font-size: 0.8rem;
    color: #9eafc5;
    margin: 0;
  }
  .skills-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.85rem;
  }
  .skills-table th, .skills-table td {
    padding: 4px 6px;
    border-bottom: 1px solid #273547;
    text-align: left;
  }
  .skills-table th {
    color: #9eafc5;
    font-weight: 500;
  }
  .cs-cell {
    width: 24px;
    text-align: center;
  }
  .abil-cell {
    width: 36px;
    color: #8bc34a;
    font-size: 0.75rem;
  }
  .mod-cell {
    width: 44px;
    font-size: 0.95rem;
  }
  .ranks-cell input {
    width: 44px;
    background: #131922;
    border: 1px solid #3d4f66;
    color: #fff;
    padding: 2px 4px;
    border-radius: 3px;
  }
  .acp-cell {
    width: 36px;
    color: #e57373;
    font-size: 0.8rem;
  }
  .breakdown-cell {
    font-size: 0.75rem;
    color: #9eafc5;
  }
  .badge-trained {
    background: #5c3566;
    color: #e9b96e;
    font-size: 0.65rem;
    padding: 1px 3px;
    border-radius: 2px;
    margin-left: 4px;
  }
  .untrained {
    opacity: 0.6;
  }
  .roll-cell {
    display: flex;
    gap: 4px;
  }
  .roll-btn {
    background: #2d5a88;
    border: 1px solid #437ab3;
    color: #fff;
    padding: 2px 8px;
    border-radius: 3px;
    cursor: pointer;
    font-size: 0.75rem;
  }
  .take-btn {
    background: #232e3d;
    border: 1px solid #3d4f66;
    color: #9eafc5;
    padding: 2px 5px;
    border-radius: 3px;
    cursor: pointer;
    font-size: 0.7rem;
  }
  .take-btn:hover {
    color: #fff;
  }
</style>
