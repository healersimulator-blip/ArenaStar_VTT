<script lang="ts">
  import { onMount } from "svelte";
  import type { ActorDocument, Json } from "../../core/documents";
  import type { ClientSync } from "../../client/sync";
  import type { PF1eAbilityKey } from "../../packages/pf1e/actor";
  import {
    PF1E_CORE_RACES,
    PF1E_CORE_CLASSES,
    PF1E_POINT_BUY_TIERS,
    calculatePointBuyTotal,
    calculateSkillPointsPerLevel,
  } from "../../packages/pf1e/builder";
  import { babAtLevel, saveBonusAtLevel } from "../../packages/pf1e/rulesTables";
  import { loadWorldCompendia, type CompendiumPackRow } from "./compendiumLoader";
  import { searchCompendia } from "../../core/compendium";

  let {
    doc,
    client,
    onClose,
  }: {
    doc: ActorDocument;
    client: ClientSync;
    onClose: () => void;
  } = $props();

  let activeTab = $state<"standard" | "freeform">("standard");

  // Standard Rules Mode State
  let selectedRaceId = $state<string>("human");
  let flexibleAbility = $state<PF1eAbilityKey>("str");
  let selectedClassId = $state<string>("custom");
  let targetLevel = $state<number>(1);
  let abilityGeneration = $state<"pointbuy" | "standard" | "custom">("pointbuy");
  let pointBuyBudget = $state<number>(15);

  let baseAbilities = $state<Record<PF1eAbilityKey, number>>({
    str: 10,
    dex: 10,
    con: 10,
    int: 10,
    wis: 10,
    cha: 10,
  });

  // Free-form Search and Picker State
  let freeformRace = $state<string>("");
  let freeformClass = $state<string>("");
  let freeformBab = $state<number>(1);
  let freeformHp = $state<number>(10);
  let freeformSpeed = $state<number>(30);
  let freeformSaves = $state<{ fort: number; ref: number; will: number }>({ fort: 2, ref: 0, will: 0 });

  // Feat & Ability search state
  let compendiaPacks = $state<CompendiumPackRow[]>([]);
  let searchQuery = $state("");
  let searchCategory = $state<"all" | "feat" | "spell" | "item">("all");
  let selectedFeats = $state<string[]>([]);
  let selectedSpells = $state<Array<{ name: string; level: number }>>([]);

  onMount(async () => {
    try {
      const all = await loadWorldCompendia();
      compendiaPacks = all;
    } catch {
      // ignore
    }

    // Initialize existing actor values
    const sys = (doc.system.pf1e ?? {}) as Record<string, unknown>;
    if (sys.abilities && typeof sys.abilities === "object") {
      const abs = sys.abilities as Record<string, number>;
      baseAbilities = {
        str: abs.str ?? 10,
        dex: abs.dex ?? 10,
        con: abs.con ?? 10,
        int: abs.int ?? 10,
        wis: abs.wis ?? 10,
        cha: abs.cha ?? 10,
      };
    }
    if (typeof sys.baseAttack === "number") freeformBab = sys.baseAttack;
    if (typeof sys.hpMax === "number") freeformHp = sys.hpMax;
    if (typeof sys.speedFt === "number") freeformSpeed = sys.speedFt;
    if (Array.isArray(sys.feats)) {
      selectedFeats = [...sys.feats];
    }
  });

  const selectedRace = $derived(
    PF1E_CORE_RACES.find((r) => r.id === selectedRaceId) ?? PF1E_CORE_RACES[0],
  );
  const selectedClass = $derived(
    PF1E_CORE_CLASSES.find((c) => c.id === selectedClassId) ?? PF1E_CORE_CLASSES[0],
  );

  const pointsSpent = $derived(calculatePointBuyTotal(baseAbilities));

  // Compute final ability scores including racial bonuses
  const finalAbilities = $derived.by(() => {
    const scores: Record<PF1eAbilityKey, number> = { ...baseAbilities };
    if (activeTab === "standard") {
      for (const [k, mod] of Object.entries(selectedRace.abilityMods)) {
        scores[k as PF1eAbilityKey] = (scores[k as PF1eAbilityKey] ?? 10) + (mod ?? 0);
      }
      if (selectedRace.flexibleAbilityBonus && flexibleAbility) {
        scores[flexibleAbility] = (scores[flexibleAbility] ?? 10) + 2;
      }
    }
    return scores;
  });

  const searchResults = $derived.by(() => {
    if (!searchQuery.trim()) return [];
    const filtered = compendiaPacks.filter((r) => {
      if (searchCategory === "all") return true;
      const t = r.pack.type.toLowerCase();
      const n = r.pack.name.toLowerCase();
      if (searchCategory === "feat") return t.includes("feat") || n.includes("feat");
      if (searchCategory === "spell") return t.includes("spell") || n.includes("spell");
      if (searchCategory === "item") return t.includes("item") || n.includes("item") || t.includes("weapon");
      return true;
    });
    return searchCompendia(
      filtered.map((r) => r.pack),
      searchQuery,
      30,
    );
  });

  function setStandardArray(): void {
    baseAbilities = {
      str: 15,
      dex: 14,
      con: 13,
      int: 12,
      wis: 10,
      cha: 8,
    };
  }

  function addFeat(name: string): void {
    if (!selectedFeats.includes(name)) {
      selectedFeats = [...selectedFeats, name];
    }
  }

  function removeFeat(name: string): void {
    selectedFeats = selectedFeats.filter((f) => f !== name);
  }

  function addSpell(name: string, level: number = 1): void {
    if (!selectedSpells.some((s) => s.name === name)) {
      selectedSpells = [...selectedSpells, { name, level }];
    }
  }

  function removeSpell(name: string): void {
    selectedSpells = selectedSpells.filter((s) => s.name !== name);
  }

  function applyBuilder(): void {
    const isFreeform = activeTab === "freeform";

    let bab = freeformBab;
    let baseSaves = { ...freeformSaves };
    let totalHp = freeformHp;
    let speed = freeformSpeed;
    let size = "Medium";
    let traits: string[] = [];

    const existingPf1e = (doc.system.pf1e ?? {}) as Record<string, Json>;
    const existingSkills = (existingPf1e.skills ?? {}) as Record<string, Json>;
    const updatedSkills: Record<string, Json> = { ...existingSkills };

    if (!isFreeform) {
      bab = babAtLevel(selectedClass.babProgression, targetLevel);
      const fortIsGood = selectedClass.goodSaves.includes("fort");
      const refIsGood = selectedClass.goodSaves.includes("ref");
      const willIsGood = selectedClass.goodSaves.includes("will");

      baseSaves = {
        fort: saveBonusAtLevel(fortIsGood ? "good" : "poor", targetLevel),
        ref: saveBonusAtLevel(refIsGood ? "good" : "poor", targetLevel),
        will: saveBonusAtLevel(willIsGood ? "good" : "poor", targetLevel),
      };

      const conMod = Math.floor((finalAbilities.con - 10) / 2);
      const hitDie = selectedClass.hitDie;
      const hpLevel1 = hitDie + conMod;
      const avgHpPerLevel = Math.floor(hitDie / 2) + 1 + conMod;
      totalHp = Math.max(1, hpLevel1 + (targetLevel - 1) * Math.max(1, avgHpPerLevel));

      speed = selectedRace.speedFt;
      size = selectedRace.size;
      traits = [...selectedRace.racialTraits];

      for (const skillId of selectedClass.classSkills) {
        const cur = (updatedSkills[skillId] ?? {}) as Record<string, Json>;
        updatedSkills[skillId] = {
          ...cur,
          classSkill: true,
        };
      }
    }

    const intMod = Math.floor((finalAbilities.int - 10) / 2);
    const isHuman = selectedRaceId === "human" || freeformRace.toLowerCase() === "human";
    const skillPoints = isFreeform
      ? 4 * targetLevel
      : calculateSkillPointsPerLevel(selectedClass, intMod, isHuman) * targetLevel;

    const diff: Record<string, Json> = {
      "system.pf1e.abilities": finalAbilities as unknown as Json,
      "system.pf1e.baseAttack": bab,
      "system.pf1e.hitDice": targetLevel,
      "system.pf1e.hpMax": totalHp,
      "system.pf1e.hp": totalHp,
      "system.pf1e.speedFt": speed,
      "system.pf1e.size": size,
      "system.pf1e.saves": baseSaves as unknown as Json,
      "system.pf1e.skills": updatedSkills as unknown as Json,
      "system.pf1e.feats": selectedFeats as unknown as Json,
      "system.pf1e.traits": traits as unknown as Json,
      "system.pf1e.builder": {
        mode: activeTab,
        race: isFreeform ? freeformRace : selectedRace.id,
        class: isFreeform ? freeformClass : selectedClass.id,
        level: targetLevel,
        skillPointsGranted: skillPoints,
      } as unknown as Json,
    };

    if (!isFreeform && selectedClass.spellcaster) {
      diff["system.pf1e.spells.keyAbility"] = selectedClass.spellcaster.keyAbility;
      diff["system.pf1e.spells.mode"] = selectedClass.spellcaster.type;
      diff["system.pf1e.spells.casterLevel"] = targetLevel;
    }

    // Add selected spells to spellbook if any were selected
    if (selectedSpells.length > 0) {
      const existingSpells = (existingPf1e.spells ?? {}) as Record<string, Json>;
      const existingPrepared = Array.isArray(existingSpells.prepared) ? [...existingSpells.prepared] : [];
      for (const sp of selectedSpells) {
        if (!existingPrepared.some((e) => (e as Record<string, unknown>).name === sp.name)) {
          existingPrepared.push({
            name: sp.name,
            level: sp.level,
            slotLevel: sp.level,
            components: "V, S",
          } as unknown as Json);
        }
      }
      diff["system.pf1e.spells.prepared"] = existingPrepared as unknown as Json;
    }

    client.submit([
      {
        kind: "update",
        ref: { coll: "actors", id: doc._id },
        diff,
      },
    ]);

    onClose();
  }
</script>

<div class="builder-backdrop" role="dialog" aria-modal="true" aria-label="Character Builder">
  <div class="builder-modal">
    <header class="builder-header">
      <div class="header-left">
        <h3>Character Builder & Customizer</h3>
        <div class="mode-tabs">
          <button
            type="button"
            class:active={activeTab === "standard"}
            onclick={() => (activeTab = "standard")}
          >
            Core Rules & Advancement
          </button>
          <button
            type="button"
            class:active={activeTab === "freeform"}
            data-freeform-tab
            onclick={() => (activeTab = "freeform")}
          >
            Free-Form / Custom Options
          </button>
        </div>
      </div>
      <button type="button" class="close-btn" onclick={onClose}>✕</button>
    </header>

    <div class="builder-body">
      {#if activeTab === "standard"}
        <!-- Standard Core Rules Mode -->
        <section class="section">
          <h4>1. Select Core Race</h4>
          <div class="field-row">
            <label>Race:
              <select bind:value={selectedRaceId}>
                {#each PF1E_CORE_RACES as race (race.id)}
                  <option value={race.id}>{race.name} ({race.size}, {race.speedFt} ft)</option>
                {/each}
              </select>
            </label>
            {#if selectedRace.flexibleAbilityBonus}
              <label>+2 Racial Bonus:
                <select bind:value={flexibleAbility}>
                  <option value="str">Strength</option>
                  <option value="dex">Dexterity</option>
                  <option value="con">Constitution</option>
                  <option value="int">Intelligence</option>
                  <option value="wis">Wisdom</option>
                  <option value="cha">Charisma</option>
                </select>
              </label>
            {/if}
          </div>
          <p class="traits-note">Traits: {selectedRace.racialTraits.join(", ")}</p>
        </section>

        <section class="section">
          <h4>2. Select Core Class & Level</h4>
          <div class="field-row">
            <label>Class:
              <select bind:value={selectedClassId}>
                {#each PF1E_CORE_CLASSES as c (c.id)}
                  <option value={c.id}>{c.name} (d{c.hitDie} HD, {c.babProgression} BAB)</option>
                {/each}
              </select>
            </label>
            <label>Level:
              <input
                type="number"
                min="1"
                max="20"
                bind:value={targetLevel}
                style="width: 60px;"
              />
            </label>
          </div>
          <p class="traits-note">
            Good Saves: {selectedClass.goodSaves.join(", ")} · Skill Ranks/Level: {selectedClass.skillPointsPerLevel} + Int
          </p>
        </section>

        <section class="section">
          <h4>3. Ability Scores</h4>
          <div class="ability-mode-toggle">
            <label>
              <input type="radio" value="pointbuy" bind:group={abilityGeneration} />
              Point Buy
            </label>
            <label>
              <input
                type="radio"
                value="standard"
                bind:group={abilityGeneration}
                onchange={setStandardArray}
              />
              Standard Array (15, 14, 13, 12, 10, 8)
            </label>
            <label>
              <input type="radio" value="custom" bind:group={abilityGeneration} />
              Direct / Custom Entry
            </label>
          </div>

          {#if abilityGeneration === "pointbuy"}
            <div class="pointbuy-status">
              <span>Budget:
                <select bind:value={pointBuyBudget}>
                  {#each PF1E_POINT_BUY_TIERS as tier (tier.id)}
                    <option value={tier.points}>{tier.label}</option>
                  {/each}
                </select>
              </span>
              <span class:budget-exceeded={pointsSpent > pointBuyBudget}>
                Spent: {pointsSpent} / {pointBuyBudget} pts
              </span>
            </div>
          {/if}

          <div class="abilities-grid">
            {#each (["str", "dex", "con", "int", "wis", "cha"] as const) as ab (ab)}
              <div class="ability-card">
                <span class="ab-label">{ab.toUpperCase()}</span>
                <input
                  type="number"
                  min="3"
                  max="30"
                  bind:value={baseAbilities[ab]}
                  style="width: 50px;"
                />
                <span class="ab-final">Final: {finalAbilities[ab]}</span>
              </div>
            {/each}
          </div>
        </section>

      {:else}
        <!-- Free-Form / Custom Creation Mode -->
        <section class="section">
          <h4>Free-Form Character Details</h4>
          <p class="section-hint">
            Customize any combination of scores, BAB, HD, speed, and saves without class or race constraints.
          </p>
          <div class="field-grid">
            <label>Custom Race / Lineage:
              <input type="text" placeholder="e.g. Aasimar, Half-Dragon" bind:value={freeformRace} />
            </label>
            <label>Custom Class / Archetype:
              <input type="text" placeholder="e.g. Magus / Kensai" bind:value={freeformClass} />
            </label>
            <label>Level / Hit Dice:
              <input type="number" min="1" max="40" bind:value={targetLevel} />
            </label>
            <label>Base Attack Bonus (BAB):
              <input type="number" min="0" max="40" bind:value={freeformBab} />
            </label>
            <label>Max Hit Points:
              <input type="number" min="1" max="999" bind:value={freeformHp} />
            </label>
            <label>Speed (ft):
              <input type="number" min="0" max="200" step="5" bind:value={freeformSpeed} />
            </label>
          </div>

          <div class="saves-row">
            <span>Base Saves:</span>
            <label>Fort: <input type="number" bind:value={freeformSaves.fort} style="width: 50px;" /></label>
            <label>Ref: <input type="number" bind:value={freeformSaves.ref} style="width: 50px;" /></label>
            <label>Will: <input type="number" bind:value={freeformSaves.will} style="width: 50px;" /></label>
          </div>

          <h4>Ability Scores (Direct Entry)</h4>
          <div class="abilities-grid">
            {#each (["str", "dex", "con", "int", "wis", "cha"] as const) as ab (ab)}
              <div class="ability-card">
                <span class="ab-label">{ab.toUpperCase()}</span>
                <input
                  type="number"
                  min="1"
                  max="50"
                  bind:value={baseAbilities[ab]}
                  style="width: 50px;"
                />
              </div>
            {/each}
          </div>
        </section>
      {/if}

      <!-- Universal Search & Compendium Additions (Feats, Abilities, Spells) -->
      <section class="section">
        <h4>Feats, Spells & Abilities Browser</h4>
        <div class="search-bar-row">
          <input
            type="search"
            class="universal-search"
            placeholder="Search thousands of feats, spells, or abilities..."
            bind:value={searchQuery}
            data-builder-search
          />
          <div class="cat-filters">
            <button
              type="button"
              class:active={searchCategory === "all"}
              onclick={() => (searchCategory = "all")}
            >All</button>
            <button
              type="button"
              class:active={searchCategory === "feat"}
              onclick={() => (searchCategory = "feat")}
            >Feats</button>
            <button
              type="button"
              class:active={searchCategory === "spell"}
              onclick={() => (searchCategory = "spell")}
            >Spells</button>
            <button
              type="button"
              class:active={searchCategory === "item"}
              onclick={() => (searchCategory = "item")}
            >Items</button>
          </div>
        </div>

        {#if searchResults.length > 0}
          <ul class="compendium-results-list">
            {#each searchResults as hit (hit.pack.name + ":" + hit.entry.id)}
              <li class="compendium-hit-row">
                <div class="hit-info">
                  <span class="hit-name">{hit.entry.name}</span>
                  <span class="hit-meta">{hit.pack.name} · {hit.pack.type}</span>
                </div>
                <button
                  type="button"
                  class="add-hit-btn"
                  data-add-hit
                  onclick={() => {
                    if (hit.pack.type.includes("feat") || hit.pack.name.includes("feat")) {
                      addFeat(hit.entry.name);
                    } else if (hit.pack.type.includes("spell") || hit.pack.name.includes("spell")) {
                      addSpell(hit.entry.name);
                    } else {
                      addFeat(hit.entry.name);
                    }
                  }}
                >
                  + Add
                </button>
              </li>
            {/each}
          </ul>
        {/if}

        <div class="selected-items-row">
          <div class="selected-col">
            <h5>Chosen Feats ({selectedFeats.length})</h5>
            <div class="chips-wrap">
              {#each selectedFeats as feat (feat)}
                <span class="chip">
                  {feat}
                  <button type="button" onclick={() => removeFeat(feat)}>×</button>
                </span>
              {/each}
              {#if selectedFeats.length === 0}
                <span class="empty-hint">No feats added yet</span>
              {/if}
            </div>
          </div>

          <div class="selected-col">
            <h5>Chosen Spells ({selectedSpells.length})</h5>
            <div class="chips-wrap">
              {#each selectedSpells as sp (sp.name)}
                <span class="chip spell-chip">
                  {sp.name} (Lv {sp.level})
                  <button type="button" onclick={() => removeSpell(sp.name)}>×</button>
                </span>
              {/each}
              {#if selectedSpells.length === 0}
                <span class="empty-hint">No spells added yet</span>
              {/if}
            </div>
          </div>
        </div>
      </section>
    </div>

    <footer class="builder-footer">
      <button type="button" class="cancel-btn" onclick={onClose}>Cancel</button>
      <button
        type="button"
        class="apply-btn"
        data-builder-apply
        onclick={applyBuilder}
      >
        Apply to Character
      </button>
    </footer>
  </div>
</div>

<style>
  .builder-backdrop {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: rgba(0, 0, 0, 0.7);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 9999;
  }
  .builder-modal {
    background: #18202b;
    border: 1px solid #3d4f66;
    border-radius: 6px;
    width: 680px;
    max-width: 95vw;
    max-height: 90vh;
    display: flex;
    flex-direction: column;
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.6);
    color: #e0e5ed;
  }
  .builder-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 12px 16px;
    border-bottom: 1px solid #2e3e52;
    background: #131922;
  }
  .header-left {
    display: flex;
    align-items: center;
    gap: 16px;
  }
  .header-left h3 {
    margin: 0;
    font-size: 1.1rem;
  }
  .mode-tabs {
    display: flex;
    gap: 4px;
    background: #0f131a;
    padding: 2px;
    border-radius: 4px;
  }
  .mode-tabs button {
    background: transparent;
    border: none;
    color: #8b9db5;
    padding: 4px 10px;
    border-radius: 3px;
    font-size: 0.8rem;
    cursor: pointer;
  }
  .mode-tabs button.active {
    background: #28374a;
    color: #fff;
    font-weight: 500;
  }
  .close-btn {
    background: transparent;
    border: none;
    color: #8b9db5;
    cursor: pointer;
    font-size: 1.2rem;
  }
  .close-btn:hover {
    color: #fff;
  }
  .builder-body {
    padding: 16px;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 16px;
  }
  .section {
    background: #1c2635;
    border: 1px solid #27364a;
    border-radius: 4px;
    padding: 12px;
  }
  .section h4 {
    margin: 0 0 10px 0;
    font-size: 0.95rem;
    color: #64b5f6;
  }
  .section-hint {
    font-size: 0.8rem;
    color: #9eafc5;
    margin: 0 0 10px 0;
  }
  .field-row {
    display: flex;
    gap: 16px;
    align-items: center;
    flex-wrap: wrap;
  }
  .field-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
    gap: 10px;
    margin-bottom: 12px;
  }
  .saves-row {
    display: flex;
    gap: 12px;
    align-items: center;
    margin-bottom: 14px;
    font-size: 0.85rem;
  }
  .traits-note {
    font-size: 0.8rem;
    color: #9eafc5;
    margin: 8px 0 0 0;
  }
  .ability-mode-toggle {
    display: flex;
    gap: 16px;
    margin-bottom: 10px;
    font-size: 0.85rem;
  }
  .pointbuy-status {
    display: flex;
    justify-content: space-between;
    margin-bottom: 10px;
    font-size: 0.85rem;
  }
  .budget-exceeded {
    color: #f44336;
    font-weight: bold;
  }
  .abilities-grid {
    display: grid;
    grid-template-columns: repeat(6, 1fr);
    gap: 8px;
  }
  .ability-card {
    display: flex;
    flex-direction: column;
    align-items: center;
    background: #151d28;
    border: 1px solid #2e3e52;
    border-radius: 4px;
    padding: 6px;
    gap: 4px;
  }
  .ab-label {
    font-weight: bold;
    font-size: 0.85rem;
  }
  .ab-final {
    font-size: 0.75rem;
    color: #8bc34a;
  }
  select, input[type="number"], input[type="text"], input[type="search"] {
    background: #121822;
    border: 1px solid #3d4f66;
    color: #fff;
    padding: 4px 8px;
    border-radius: 4px;
  }
  .search-bar-row {
    display: flex;
    gap: 10px;
    margin-bottom: 10px;
  }
  .universal-search {
    flex: 1;
    padding: 6px 10px;
  }
  .cat-filters {
    display: flex;
    gap: 4px;
  }
  .cat-filters button {
    background: #171f2b;
    border: 1px solid #3d4f66;
    color: #9eafc5;
    padding: 4px 10px;
    border-radius: 3px;
    font-size: 0.8rem;
    cursor: pointer;
  }
  .cat-filters button.active {
    background: #2b593f;
    border-color: #3d7d59;
    color: #fff;
  }
  .compendium-results-list {
    list-style: none;
    padding: 0;
    margin: 0 0 14px 0;
    max-height: 180px;
    overflow-y: auto;
    border: 1px solid #2c3c50;
    background: #121822;
    border-radius: 4px;
  }
  .compendium-hit-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 6px 10px;
    border-bottom: 1px solid #202b3a;
  }
  .compendium-hit-row:hover {
    background: #1a2433;
  }
  .hit-info {
    display: flex;
    flex-direction: column;
  }
  .hit-name {
    font-size: 0.85rem;
    font-weight: 500;
  }
  .hit-meta {
    font-size: 0.7rem;
    color: #7b8ea6;
  }
  .add-hit-btn {
    background: #2d5a88;
    border: 1px solid #437ab3;
    color: #fff;
    padding: 2px 8px;
    border-radius: 3px;
    cursor: pointer;
    font-size: 0.75rem;
  }
  .selected-items-row {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 12px;
  }
  .selected-col h5 {
    margin: 0 0 6px 0;
    font-size: 0.8rem;
    color: #9eafc5;
  }
  .chips-wrap {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    min-height: 36px;
    background: #121822;
    border: 1px solid #2c3c50;
    border-radius: 4px;
    padding: 6px;
  }
  .chip {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    background: #223145;
    border: 1px solid #364b66;
    padding: 2px 6px;
    border-radius: 3px;
    font-size: 0.75rem;
    color: #e0e5ed;
  }
  .spell-chip {
    background: #39284d;
    border-color: #5d3d7e;
  }
  .chip button {
    background: transparent;
    border: none;
    color: #ff8a80;
    cursor: pointer;
    font-size: 0.8rem;
    padding: 0;
  }
  .empty-hint {
    font-size: 0.75rem;
    color: #5d7088;
    font-style: italic;
  }
  .builder-footer {
    display: flex;
    justify-content: flex-end;
    gap: 10px;
    padding: 12px 16px;
    border-top: 1px solid #2e3e52;
    background: #131922;
  }
  .cancel-btn {
    background: #2a3442;
    border: 1px solid #3d4f66;
    color: #e0e5ed;
    padding: 6px 14px;
    border-radius: 4px;
    cursor: pointer;
  }
  .apply-btn {
    background: #2d7742;
    border: 1px solid #3fa45c;
    color: #fff;
    padding: 6px 16px;
    border-radius: 4px;
    font-weight: bold;
    cursor: pointer;
  }
  .apply-btn:hover {
    background: #389552;
  }
</style>
