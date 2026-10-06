/**
 * Core PF1e poison profiles — immutable **source data** for the affliction engine.
 *
 * One profile per PF1e poison, transcribed from the cited source and validated at load by
 * `validatePF1ePoisonDefinition` in `afflictions.ts`. The same profiles ship as content in
 * `systems/pf1e-core/packs/poisons.json` (pack `PF1e Poisons`, `type: "items"`, each entry carrying
 * its profile under `system.pf1e.poison`); no source file loads pack data at runtime (M18), so this
 * module is the engine's synchronous mirror and `tests/packages/pf1eContentPacks.test.ts` pins the
 * mirror to the shipped file — editing one without the other fails the build.
 */
/** Unvalidated profile rows; the loader in `afflictions.ts` is the only reader. */
export const PF1E_POISON_CATALOGUE: readonly unknown[] = [
  {
    "id": "greenblood-oil",
    "version": 1,
    "name": "Greenblood oil",
    "ruleset": "core-pf1e",
    "source": {
      "title": "I Drank What? An FAQ on Poison",
      "citation": "Paizo PF1e poison FAQ, Greenblood oil example",
      "url": "https://paizo.com/blog/i-drank-what-an-faq-on-poison"
    },
    "delivery": [
      "injury"
    ],
    "baseDC": 13,
    "dcSource": "fixed-stat-block",
    "saveType": "fort",
    "onset": null,
    "frequency": {
      "interval": {
        "value": 1,
        "unit": "round"
      },
      "intervals": 4,
      "firstSave": "at-onset"
    },
    "effects": {
      "immediate": [
        {
          "kind": "damage",
          "target": "abilityDamage",
          "ability": "con",
          "formula": "1"
        }
      ],
      "periodic": [
        {
          "kind": "damage",
          "target": "abilityDamage",
          "ability": "con",
          "formula": "1"
        }
      ],
      "oneShot": [
        {
          "kind": "damage",
          "target": "abilityDamage",
          "ability": "con",
          "formula": "1"
        }
      ]
    },
    "cure": {
      "successesRequired": 1,
      "consecutive": false
    }
  },
  {
    "id": "giant-octopus-poison",
    "version": 1,
    "name": "Giant octopus poison",
    "ruleset": "core-pf1e",
    "source": {
      "title": "Archives of Nethys — Giant Octopus",
      "citation": "Bestiary p. 219; Poison: DC 19, 1/round for 6 rounds, 1d3 Strength, Cure 2 saves",
      "url": "https://aonprd.com/MonsterDisplay.aspx?ItemName=Giant%20Octopus"
    },
    "delivery": [
      "injury"
    ],
    "baseDC": 19,
    "dcSource": "fixed-stat-block",
    "saveType": "fort",
    "onset": null,
    "frequency": {
      "interval": {
        "value": 1,
        "unit": "round"
      },
      "intervals": 6,
      "firstSave": "at-onset"
    },
    "effects": {
      "immediate": [
        {
          "kind": "damage",
          "target": "abilityDamage",
          "ability": "str",
          "formula": "1d3"
        }
      ],
      "periodic": [
        {
          "kind": "damage",
          "target": "abilityDamage",
          "ability": "str",
          "formula": "1d3"
        }
      ],
      "oneShot": [
        {
          "kind": "damage",
          "target": "abilityDamage",
          "ability": "str",
          "formula": "1d3"
        }
      ]
    },
    "cure": {
      "successesRequired": 2,
      "consecutive": false
    }
  },
  {
    "id": "wyvern-poison",
    "version": 1,
    "name": "Wyvern poison",
    "ruleset": "core-pf1e",
    "source": {
      "title": "Archives of Nethys — Wyvern",
      "citation": "Bestiary; Poison: DC 17, 1/round for 6 rounds, 1d4 Constitution, Cure 2 consecutive saves",
      "url": "https://aonprd.com/MonsterDisplay.aspx?ItemName=Wyvern"
    },
    "delivery": [
      "injury"
    ],
    "baseDC": 17,
    "dcSource": "fixed-stat-block",
    "saveType": "fort",
    "onset": null,
    "frequency": {
      "interval": {
        "value": 1,
        "unit": "round"
      },
      "intervals": 6,
      "firstSave": "at-onset"
    },
    "effects": {
      "immediate": [
        {
          "kind": "damage",
          "target": "abilityDamage",
          "ability": "con",
          "formula": "1d4"
        }
      ],
      "periodic": [
        {
          "kind": "damage",
          "target": "abilityDamage",
          "ability": "con",
          "formula": "1d4"
        }
      ],
      "oneShot": [
        {
          "kind": "damage",
          "target": "abilityDamage",
          "ability": "con",
          "formula": "1d4"
        }
      ]
    },
    "cure": {
      "successesRequired": 2,
      "consecutive": true
    }
  },
  {
    "id": "medium-spider-venom",
    "version": 1,
    "name": "Medium spider venom",
    "ruleset": "core-pf1e",
    "source": {
      "title": "Pathfinder Core Rulebook",
      "citation": "CRB p. 557; Medium spider venom, dose-stacking example (DC 14; 1/round for 4 rounds)"
    },
    "delivery": [
      "injury"
    ],
    "baseDC": 14,
    "dcSource": "fixed-stat-block",
    "saveType": "fort",
    "onset": null,
    "frequency": {
      "interval": {
        "value": 1,
        "unit": "round"
      },
      "intervals": 4,
      "firstSave": "at-onset"
    },
    "effects": {
      "immediate": [
        {
          "kind": "damage",
          "target": "abilityDamage",
          "ability": "str",
          "formula": "1d2"
        }
      ],
      "periodic": [
        {
          "kind": "damage",
          "target": "abilityDamage",
          "ability": "str",
          "formula": "1d2"
        }
      ],
      "oneShot": [
        {
          "kind": "damage",
          "target": "abilityDamage",
          "ability": "str",
          "formula": "1d2"
        }
      ]
    },
    "cure": {
      "successesRequired": 1,
      "consecutive": false
    }
  },
];
