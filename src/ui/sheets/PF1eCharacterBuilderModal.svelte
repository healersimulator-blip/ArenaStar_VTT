<script lang="ts">
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

  let {
    doc,
    client,
    onClose,
  }: {
    doc: ActorDocument;
    client: ClientSync;
    onClose: () => void;
  } = $props();

  let selectedRaceId = $state<string>("human");
  let flexibleAbility = $state<PF1eAbilityKey>("str");
  let selectedClassId = $state<string>("fighter");
  let targetLevel = $state<number>(1);

  let abilityGeneration = $state<"pointbuy" | "standard">("pointbuy");
  let pointBuyBudget = $state<number>(15);

  let baseAbilities = $state<Record<PF1eAbilityKey, number>>({
    str: 10,
    dex: 10,
    con: 10,
    int: 10,
    wis: 10,
    cha: 10,
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
    for (const [k, mod] of Object.entries(selectedRace.abilityMods)) {
      scores[k as PF1eAbilityKey] = (scores[k as PF1eAbilityKey] ?? 10) + (mod ?? 0);
    }
    if (selectedRace.flexibleAbilityBonus && flexibleAbility) {
      scores[flexibleAbility] = (scores[flexibleAbility] ?? 10) + 2;
    }
    return scores;
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

  function applyBuilder(): void {
    const bab = babAtLevel(selectedClass.babProgression, targetLevel);
    const fortIsGood = selectedClass.goodSaves.includes("fort");
    const refIsGood = selectedClass.goodSaves.includes("ref");
    const willIsGood = selectedClass.goodSaves.includes("will");

    const baseSaves = {
      fort: saveBonusAtLevel(fortIsGood ? "good" : "poor", targetLevel),
      ref: saveBonusAtLevel(refIsGood ? "good" : "poor", targetLevel),
      will: saveBonusAtLevel(willIsGood ? "good" : "poor", targetLevel),
    };

    const conMod = Math.floor((finalAbilities.con - 10) / 2);
    // Level 1 max HP, subsequent levels average
    const hitDie = selectedClass.hitDie;
    const hpLevel1 = hitDie + conMod;
    const avgHpPerLevel = Math.floor(hitDie / 2) + 1 + conMod;
    const totalHp = Math.max(1, hpLevel1 + (targetLevel - 1) * Math.max(1, avgHpPerLevel));

    // Skill points
    const intMod = Math.floor((finalAbilities.int - 10) / 2);
    const isHuman = selectedRace.id === "human";
    const skillPoints = calculateSkillPointsPerLevel(selectedClass, intMod, isHuman) * targetLevel;

    // Build skills object marking class skills
    const existingPf1e = (doc.system.pf1e ?? {}) as Record<string, Json>;
    const existingSkills = (existingPf1e.skills ?? {}) as Record<string, Json>;
    const updatedSkills: Record<string, Json> = { ...existingSkills };
    for (const skillId of selectedClass.classSkills) {
      const cur = (updatedSkills[skillId] ?? {}) as Record<string, Json>;
      updatedSkills[skillId] = {
        ...cur,
        classSkill: true,
      };
    }

    const traits = [...selectedRace.racialTraits];

    const diff: Record<string, Json> = {
      "system.pf1e.abilities": finalAbilities as unknown as Json,
      "system.pf1e.baseAttack": bab,
      "system.pf1e.hitDice": targetLevel,
      "system.pf1e.hpMax": totalHp,
      "system.pf1e.hp": totalHp,
      "system.pf1e.speedFt": selectedRace.speedFt,
      "system.pf1e.size": selectedRace.size,
      "system.pf1e.saves": baseSaves as unknown as Json,
      "system.pf1e.skills": updatedSkills as unknown as Json,
      "system.pf1e.traits": traits as unknown as Json,
      "system.pf1e.builder": {
        race: selectedRace.id,
        class: selectedClass.id,
        level: targetLevel,
        skillPointsGranted: skillPoints,
      } as unknown as Json,
    };

    // If class is a spellcaster, initialize spell fields
    if (selectedClass.spellcaster) {
      diff["system.pf1e.spells.keyAbility"] = selectedClass.spellcaster.keyAbility;
      diff["system.pf1e.spells.mode"] = selectedClass.spellcaster.type;
      diff["system.pf1e.spells.casterLevel"] = targetLevel;
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
      <h3>Character Builder & Leveling</h3>
      <button type="button" class="close-btn" onclick={onClose}>✕</button>
    </header>

    <div class="builder-body">
      <!-- Race Section -->
      <section class="section">
        <h4>1. Select Race</h4>
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

      <!-- Class & Level Section -->
      <section class="section">
        <h4>2. Select Class & Level</h4>
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

      <!-- Ability Scores Section -->
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
                min="7"
                max="18"
                bind:value={baseAbilities[ab]}
                style="width: 50px;"
              />
              <span class="ab-final">Final: {finalAbilities[ab]}</span>
            </div>
          {/each}
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
    background: #1c2430;
    border: 1px solid #3d4f66;
    border-radius: 6px;
    width: 620px;
    max-width: 95vw;
    max-height: 88vh;
    display: flex;
    flex-direction: column;
    box-shadow: 0 10px 30px rgba(0, 0, 0, 0.6);
    color: #e0e5ed;
  }
  .builder-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 12px 16px;
    border-bottom: 1px solid #2e3e52;
  }
  .builder-header h3 {
    margin: 0;
    font-size: 1.15rem;
  }
  .close-btn {
    background: transparent;
    border: none;
    color: #9eafc5;
    cursor: pointer;
    font-size: 1.2rem;
  }
  .builder-body {
    padding: 14px 16px;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 14px;
  }
  .section {
    background: #232e3d;
    border: 1px solid #2e3e52;
    border-radius: 4px;
    padding: 12px;
  }
  .section h4 {
    margin: 0 0 10px 0;
    color: #8bc34a;
  }
  .field-row {
    display: flex;
    gap: 16px;
    flex-wrap: wrap;
    align-items: center;
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
  }
  .pointbuy-status {
    display: flex;
    justify-content: space-between;
    margin-bottom: 10px;
    font-weight: 500;
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
    background: #171f2b;
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
  select, input {
    background: #131922;
    border: 1px solid #3d4f66;
    color: #fff;
    padding: 4px 8px;
    border-radius: 4px;
  }
  .builder-footer {
    display: flex;
    justify-content: flex-end;
    gap: 10px;
    padding: 12px 16px;
    border-top: 1px solid #2e3e52;
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
