/*
 * core.js — the emulator's core resource library (D-484).
 *
 * Foundry modules reference resources that ship with Foundry itself, not with the module: core
 * template paths (`templates/generic/tab-navigation.hbs` as an ApplicationV2 PART, the dice and
 * dialog templates), core translation keys (`COMMON.Yes`, `TOKEN.DISPOSITION.HOSTILE`,
 * `SETTINGS.Save`) and core CSS classes (`.standard-form`, `.flexrow`, `.tabs.vertical`).
 * Telling a module to "ship its own" would turn Foundry's packaging rule against the module
 * author; an emulator provides the surface. Everything in this file is ArenaStar's own
 * implementation of that surface — written from the contract modules depend on (which context
 * fields a template consumes, which classes and data attributes it emits, which keys exist), not
 * from Foundry's files, which are proprietary and were not consulted.
 *
 * Published as `globalThis.__aisFoundryCore` for `ui.js` (templates, css) and `adapter.js` (lang).
 */
(() => {
  "use strict";

  // ═══════════════════════════ templates ═══════════════════════════
  // Each entry documents the context it consumes and the DOM it guarantees. Paths are the ones
  // modules write; `aliases` map the names of other Foundry generations onto the same template so
  // a module written for v11 renders on the v13 surface and vice versa.
  const templates = Object.freeze({
    /**
     * ApplicationV2 tab strip. Context: `tabs` — record or array of
     * `{ id, group, icon?, label?, active?, cssClass? }` (what `_prepareTabs(group)` returns);
     * optional `tabClasses`/`verticalTabs` (newer modules pass "vertical").
     * DOM: `nav.sheet-tabs.tabs[data-group] > a.item[data-action=tab][data-group][data-tab]`,
     * the active tab carries `.active`.
     */
    "templates/generic/tab-navigation.hbs": [
      '<nav class="sheet-tabs tabs{{#if tabClasses}} {{tabClasses}}{{/if}}{{#if verticalTabs}} vertical{{/if}}" data-group="{{#each tabs}}{{#if @first}}{{group}}{{/if}}{{/each}}" role="tablist">',
      "{{#each tabs}}",
      '<a class="item{{#if cssClass}} {{cssClass}}{{else}}{{#if active}} active{{/if}}{{/if}}" data-action="tab" data-group="{{group}}" data-tab="{{id}}" role="tab" aria-selected="{{#if active}}true{{else}}false{{/if}}">',
      '{{#if icon}}<i class="{{icon}}" inert></i>{{/if}}',
      "{{#if label}}<span>{{localize label}}</span>{{/if}}",
      "</a>",
      "{{/each}}",
      "</nav>",
    ].join(""),

    /**
     * ApplicationV2 form footer. Context: `buttons` — array of
     * `{ type?, action?, icon?, label?, cssClass?, name?, value?, disabled? }`.
     * DOM: `footer.form-footer > button[type][data-action]`; a missing `type` keeps the HTML
     * default (submit), exactly what a form-tagged application relies on.
     */
    "templates/generic/form-footer.hbs": [
      '<footer class="form-footer">',
      "{{#each buttons}}",
      '<button{{#if type}} type="{{type}}"{{/if}}{{#if action}} data-action="{{action}}"{{/if}}{{#if cssClass}} class="{{cssClass}}"{{/if}}{{#if name}} name="{{name}}"{{/if}}{{#if value}} value="{{value}}"{{/if}}{{#if disabled}} disabled{{/if}}>',
      '{{#if icon}}<i class="{{icon}}" inert></i>{{/if}}',
      "{{#if label}}<span>{{localize label}}</span>{{/if}}",
      "</button>",
      "{{/each}}",
      "</footer>",
    ].join(""),

    /**
     * One labelled form row. Context: `{ label?, hint?, input|fields (HTML), stacked?, classes?,
     * rootId?, localize?, units? }`. DOM: `.form-group > label + .form-fields + p.hint`.
     */
    "templates/generic/form-group.hbs": [
      '<div class="form-group{{#if stacked}} stacked{{/if}}{{#if classes}} {{classes}}{{/if}}">',
      '{{#if label}}<label{{#if rootId}} for="{{rootId}}"{{/if}}>{{#if localize}}{{localize label}}{{else}}{{label}}{{/if}}{{#if units}} <span class="units">({{localize units}})</span>{{/if}}</label>{{/if}}',
      '<div class="form-fields">{{{input}}}</div>',
      '{{#if hint}}<p class="hint">{{#if localize}}{{localize hint}}{{else}}{{hint}}{{/if}}</p>{{/if}}',
      "</div>",
    ].join(""),

    /**
     * A run of form groups from data fields. Context: `fields` — array of
     * `{ field, value?, name?, label?, hint?, ... }` (anything `formGroup` accepts) or `{ html }`.
     */
    "templates/generic/form-fields.hbs": [
      "{{#each fields}}",
      "{{#if html}}{{{html}}}{{else}}{{formGroup field value=value name=name label=label hint=hint choices=choices blank=blank placeholder=placeholder disabled=disabled stacked=stacked localize=true}}{{/if}}",
      "{{/each}}",
    ].join(""),

    /**
     * Dialog (v1) body. Context: `{ content (HTML), buttons: { key: { icon?, label?, cssClass?,
     * disabled? } }, default? }`. DOM: `.dialog-content` + `.dialog-buttons > button.dialog-button.<key>[data-button]`,
     * the default button also carries `.default.bright`.
     */
    "templates/hud/dialog.html": [
      '<div class="dialog-content">{{{content}}}</div>',
      '<div class="dialog-buttons flexrow">',
      "{{#each buttons}}",
      '<button type="button" class="dialog-button {{@key}}{{#if cssClass}} {{cssClass}}{{/if}}{{#if (eq @key @root.default)}} default bright{{/if}}" data-button="{{@key}}"{{#if disabled}} disabled{{/if}}>{{{icon}}}{{#if label}}<span>{{label}}</span>{{/if}}</button>',
      "{{/each}}",
      "</div>",
    ].join(""),

    /**
     * Rendered roll card. Context: `{ formula, total, tooltip (HTML from the tooltip template),
     * flavor?, user?, isPrivate? }`. DOM: `.dice-roll > .dice-result > .dice-formula, .dice-tooltip, h4.dice-total`.
     */
    "templates/dice/roll.html": [
      '<div class="dice-roll{{#if isPrivate}} private{{/if}}">',
      '<div class="dice-result">',
      '{{#if isPrivate}}<div class="dice-formula">???</div><h4 class="dice-total">?</h4>{{else}}',
      '{{#if flavor}}<div class="dice-flavor">{{flavor}}</div>{{/if}}',
      '<div class="dice-formula">{{formula}}</div>',
      "{{{tooltip}}}",
      '<h4 class="dice-total">{{total}}</h4>{{/if}}',
      "</div>",
      "</div>",
    ].join(""),

    /**
     * Roll breakdown. Context: `{ parts: [{ formula, total, faces?, flavor?, rolls: [{ result, classes? }] }] }`.
     * DOM: `.dice-tooltip > section.tooltip-part > .dice > header.part-header (.part-formula, .part-flavor, .part-total) + ol.dice-rolls > li.roll.die.d<faces>`.
     */
    "templates/dice/tooltip.html": [
      '<div class="dice-tooltip">',
      "{{#each parts}}",
      '<section class="tooltip-part">',
      '<div class="dice">',
      '<header class="part-header flexrow"><span class="part-formula">{{formula}}</span>{{#if flavor}}<span class="part-flavor">{{flavor}}</span>{{/if}}<span class="part-total">{{total}}</span></header>',
      '<ol class="dice-rolls">',
      '{{#each rolls}}<li class="roll {{#if classes}}{{classes}}{{else}}die d{{../faces}}{{/if}}">{{result}}</li>{{/each}}',
      "</ol>",
      "</div>",
      "</section>",
      "{{/each}}",
      "</div>",
    ].join(""),

    /**
     * Roll-table draw. Context: `{ description?, rollHTML?, table?, results: [{ id?, icon?, text, type? }] }`.
     * DOM: `.table-draw > .table-description?, ol.table-results > li.table-result > .result-text`.
     */
    "templates/dice/table-result.html": [
      '<div class="table-draw"{{#if table.id}} data-table-id="{{table.id}}"{{/if}}>',
      '{{#if description}}<div class="table-description">{{{description}}}</div>{{/if}}',
      "{{{rollHTML}}}",
      '<ol class="table-results">',
      '{{#each results}}<li class="table-result flexrow"{{#if id}} data-result-id="{{id}}"{{/if}}>{{#if icon}}<img class="result-image" src="{{icon}}" alt="">{{/if}}<div class="result-text">{{{text}}}</div></li>{{/each}}',
      "</ol>",
      "</div>",
    ].join(""),

    /**
     * "Create document" form used by create dialogs. Context: `{ name?, defaultName?, hasTypes?,
     * type?, types?: { value: label }, folders?: [{ id, name }], folder?, content? (HTML) }`.
     * DOM: `form.document-create` with `input[name=name]`, `select[name=type]`, `select[name=folder]`.
     */
    "templates/sidebar/document-create.html": [
      '<form class="document-create standard-form" autocomplete="off">',
      '<div class="form-group"><label>{{localize "Name"}}</label><div class="form-fields"><input type="text" name="name" value="{{name}}" placeholder="{{defaultName}}" autofocus></div></div>',
      '{{#if hasTypes}}<div class="form-group"><label>{{localize "Type"}}</label><div class="form-fields"><select name="type">{{selectOptions types selected=type localize=true}}</select></div></div>{{/if}}',
      '{{#if folders.length}}<div class="form-group"><label>{{localize "Folder"}}</label><div class="form-fields"><select name="folder">{{selectOptions folders selected=folder blank="" valueAttr="id" labelAttr="name"}}</select></div></div>{{/if}}',
      "{{{content}}}",
      "</form>",
    ].join(""),

    /**
     * Chat message markup. Context: `{ message: { _id?, content, flavor?, timestamp? }, alias?,
     * cssClass?, borderColor?, isWhisper?, whisperTo?, canDelete? }`.
     * DOM: `li.chat-message.message[data-message-id] > header.message-header (.message-sender,
     * .message-metadata > time.message-timestamp, .flavor-text, .whisper-to) + .message-content`.
     */
    "templates/sidebar/chat-message.html": [
      '<li class="chat-message message flexcol{{#if cssClass}} {{cssClass}}{{/if}}"{{#if message._id}} data-message-id="{{message._id}}"{{/if}}{{#if borderColor}} style="border-color: {{borderColor}}"{{/if}}>',
      '<header class="message-header flexrow">',
      '<h4 class="message-sender">{{alias}}</h4>',
      '<span class="message-metadata">{{#if message.timestamp}}<time class="message-timestamp">{{timeSince message.timestamp}}</time>{{/if}}{{#if canDelete}}<a class="message-delete" data-action="deleteMessage"><i class="fas fa-trash" inert></i></a>{{/if}}</span>',
      '{{#if message.flavor}}<span class="flavor-text">{{{message.flavor}}}</span>{{/if}}',
      '{{#if isWhisper}}<span class="whisper-to">{{localize "CHAT.To"}}: {{whisperTo}}</span>{{/if}}',
      "</header>",
      '<div class="message-content">{{{message.content}}}</div>',
      "</li>",
    ].join(""),
  });

  const aliases = Object.freeze({
    "templates/hud/dialog.hbs": "templates/hud/dialog.html",
    "templates/dice/roll.hbs": "templates/dice/roll.html",
    "templates/dice/tooltip.hbs": "templates/dice/tooltip.html",
    "templates/dice/table-result.hbs": "templates/dice/table-result.html",
    "templates/sidebar/entity-create.html": "templates/sidebar/document-create.html",
    "templates/sidebar/document-create.hbs": "templates/sidebar/document-create.html",
    "templates/chat/chat-message.hbs": "templates/sidebar/chat-message.html",
    "templates/chat/chat-message.html": "templates/sidebar/chat-message.html",
    "templates/chat/message.hbs": "templates/sidebar/chat-message.html",
    "templates/generic/form-group.html": "templates/generic/form-group.hbs",
    "templates/generic/tab-navigation.html": "templates/generic/tab-navigation.hbs",
    "templates/generic/form-footer.html": "templates/generic/form-footer.hbs",
  });

  /** Canonical library path for a module-facing path, or null when the library has no entry. */
  const resolveTemplate = (path) => {
    const p = String(path ?? "").replace(/\\/g, "/").replace(/^\/+/, "");
    if (Object.hasOwn(templates, p)) return p;
    if (Object.hasOwn(aliases, p)) return aliases[p];
    return null;
  };

  // ═══════════════════════════ translations ═══════════════════════════
  // Core keys modules reference without shipping them. Our words, Foundry's key names.
  const lang = Object.freeze({
    Yes: "Yes", No: "No", OK: "OK", Cancel: "Cancel", Close: "Close", Save: "Save", Submit: "Submit", Confirm: "Confirm",
    Delete: "Delete", Edit: "Edit", Create: "Create", Update: "Update", Add: "Add", Remove: "Remove", Reset: "Reset", Apply: "Apply",
    Import: "Import", Export: "Export", Search: "Search", Filter: "Filter", Clear: "Clear", Copy: "Copy", Duplicate: "Duplicate",
    Rename: "Rename", Configure: "Configure", Settings: "Settings", Name: "Name", Type: "Type", Folder: "Folder", None: "None",
    Default: "Default", Label: "Label", Value: "Value", Description: "Description", Notes: "Notes", Image: "Image", Icon: "Icon",
    Color: "Color", Width: "Width", Height: "Height", Size: "Size", Scale: "Scale", Rotation: "Rotation", Opacity: "Opacity",
    Visible: "Visible", Hidden: "Hidden", Locked: "Locked", Unknown: "Unknown", Enabled: "Enabled", Disabled: "Disabled",
    Enable: "Enable", Disable: "Disable", Loading: "Loading…", Warning: "Warning", Error: "Error", Info: "Info",
    AreYouSure: "Are you sure?", Title: "Title", Author: "Author", Version: "Version", Permissions: "Permissions",
    Player: "Player", Players: "Players", Gamemaster: "Game Master", User: "User", Users: "Users", World: "World", System: "System",
    Module: "Module", Modules: "Modules", Scene: "Scene", Scenes: "Scenes", Actor: "Actor", Actors: "Actors", Item: "Item", Items: "Items",
    Token: "Token", Tokens: "Tokens", Macro: "Macro", Macros: "Macros", Journal: "Journal", Table: "Table", Tables: "Tables",
    Compendium: "Compendium", Playlist: "Playlist", Combat: "Combat", Chat: "Chat",
    COMMON: {
      Yes: "Yes", No: "No", OK: "OK", Cancel: "Cancel", Close: "Close", Save: "Save", Submit: "Submit", Confirm: "Confirm", Delete: "Delete",
      Edit: "Edit", Create: "Create", Update: "Update", Add: "Add", Remove: "Remove", Reset: "Reset", Apply: "Apply", Clear: "Clear",
      Import: "Import", Export: "Export", Search: "Search", Filter: "Filter", Name: "Name", Type: "Type", Folder: "Folder", None: "None",
      Default: "Default", Unknown: "Unknown", Enabled: "Enabled", Disabled: "Disabled", Visible: "Visible", Hidden: "Hidden",
      AreYouSure: "Are you sure?", Warning: "Warning", Error: "Error", Loading: "Loading…", Configure: "Configure", Settings: "Settings",
      Description: "Description", Label: "Label", Value: "Value", Image: "Image", Color: "Color", Size: "Size", Width: "Width", Height: "Height",
      Scale: "Scale", Rotation: "Rotation", Opacity: "Opacity", Locked: "Locked", Copy: "Copy", Duplicate: "Duplicate", Rename: "Rename",
      Title: "Title", Author: "Author", Version: "Version", Player: "Player", Gamemaster: "Game Master",
    },
    SETTINGS: {
      Title: "Settings", Save: "Save Changes", Reset: "Reset Defaults", Configure: "Configure Settings", ConfigTitle: "Configure Game Settings",
      Core: "Core Settings", System: "System Settings", Modules: "Module Settings", Client: "Client", World: "World", Scope: "Scope",
      ResetInfo: "Restore every setting of this package to its default.", RequiresReload: "Changing this setting requires a reload.",
      Search: "Search settings", Filter: "Filter", NoneFound: "No settings match the filter.",
      PrototypeTokenOverrides: { TABS: { AllTypes: { Label: "All Types" } } },
    },
    SHEETS: { FormNavLabel: "Form sections", DefaultSheet: "Default Sheet", SheetTitle: "Sheet Configuration" },
    DOCUMENT: {
      Create: "Create {type}", Update: "Update {type}", Delete: "Delete {type}", New: "New {type}", Duplicate: "Duplicate {type}", Configure: "Configure {type}",
      Actor: "Actor", Item: "Item", Scene: "Scene", Token: "Token", Macro: "Macro", Folder: "Folder", JournalEntry: "Journal Entry",
      JournalEntryPage: "Journal Page", RollTable: "Roll Table", Playlist: "Playlist", ChatMessage: "Chat Message", Combat: "Combat",
      Combatant: "Combatant", User: "User", ActiveEffect: "Active Effect", Cards: "Cards", Card: "Card", Setting: "Setting",
      Drawing: "Drawing", Tile: "Tile", Wall: "Wall", AmbientLight: "Light Source", AmbientSound: "Sound Source", MeasuredTemplate: "Template",
      Note: "Map Note", Region: "Region", TableResult: "Table Result", Adventure: "Adventure",
    },
    FOLDER: { Create: "Create Folder", Update: "Update Folder", Name: "Folder Name", Parent: "Parent Folder", Color: "Folder Color", Delete: "Delete Folder", Remove: "Remove Folder", Sort: "Sort Mode", SortAlphabetical: "Alphabetical", SortManual: "Manual" },
    OWNERSHIP: { INHERIT: "Default", NONE: "None", LIMITED: "Limited", OBSERVER: "Observer", OWNER: "Owner" },
    PERMISSION: { INHERIT: "Default", NONE: "None", LIMITED: "Limited", OBSERVER: "Observer", OWNER: "Owner", Title: "Configure Ownership" },
    USER: { RoleNone: "None", RolePlayer: "Player", RoleTrusted: "Trusted Player", RoleAssistant: "Assistant GM", RoleGamemaster: "Game Master", Role: "Role", Name: "Name", Color: "Color", Avatar: "Avatar", Character: "Character" },
    TYPES: { Actor: { base: "Base", character: "Character", npc: "NPC" }, Item: { base: "Base" }, JournalEntryPage: { text: "Text", image: "Image", pdf: "PDF", video: "Video" } },
    TOKEN: {
      Name: "Token Name", Title: "Token Configuration", TitlePrototype: "Prototype Token", DisplayName: "Display Name", Disposition: "Disposition",
      Dimensions: "Dimensions", Vision: "Vision", Light: "Light", Resources: "Resources", Identity: "Identity", Appearance: "Appearance",
      DISPLAY_NONE: "Never Displayed", DISPLAY_CONTROL: "When Controlled", DISPLAY_OWNER_HOVER: "Hovered by Owner", DISPLAY_HOVER: "Hovered by Anyone",
      DISPLAY_OWNER: "Always for Owner", DISPLAY_ALWAYS: "Always for Everyone",
      DISPOSITION: { SECRET: "Secret", HOSTILE: "Hostile", NEUTRAL: "Neutral", FRIENDLY: "Friendly" },
      TABS: { identity: "Identity", appearance: "Appearance", vision: "Vision", light: "Light", resources: "Resources", ring: "Ring", movement: "Movement" },
      RING: { SHEET: { legend: "Dynamic Token Ring" } },
      TURNMARKER: { SHEET: { legend: "Turn Marker" }, MODES: { DISABLED: "Disabled", DEFAULT: "Default", CUSTOM: "Custom" } },
      FIELDS: {
        name: { label: "Token Name" }, displayName: { label: "Display Name" }, disposition: { label: "Disposition" }, displayBars: { label: "Display Bars" },
        appendNumber: { label: "Append Number" }, prependAdjective: { label: "Prepend Adjective" }, lockRotation: { label: "Lock Rotation" },
        width: { label: "Width" }, height: { label: "Height" }, elevation: { label: "Elevation" }, rotation: { label: "Rotation" }, alpha: { label: "Opacity" },
        hidden: { label: "Hidden" }, actorLink: { label: "Link Actor Data" }, texture: { src: { label: "Image" }, scaleX: { label: "Scale (X)" }, scaleY: { label: "Scale (Y)" }, tint: { label: "Tint" } },
        occludable: { radius: { label: "Occlusion Radius" } }, bar1: { attribute: { label: "Bar 1 Attribute" } }, bar2: { attribute: { label: "Bar 2 Attribute" } },
        sight: { enabled: { label: "Has Vision" }, range: { label: "Vision Range" }, angle: { label: "Vision Angle" }, visionMode: { label: "Vision Mode" } },
        light: { bright: { label: "Bright Radius" }, dim: { label: "Dim Radius" }, angle: { label: "Emission Angle" }, color: { label: "Light Color" }, alpha: { label: "Light Intensity" } },
        ring: { enabled: { label: "Enable Ring" }, colors: { ring: { label: "Ring Color" }, background: { label: "Background Color" } } },
        turnMarker: { mode: { label: "Turn Marker Mode" }, animation: { label: "Animation" }, src: { label: "Image" }, disposition: { label: "Use Disposition Color" } },
      },
    },
    COMBAT: {
      Begin: "Begin Combat", End: "End Combat", NextTurn: "Next Turn", PreviousTurn: "Previous Turn", NextRound: "Next Round", PreviousRound: "Previous Round",
      Round: "Round", Turn: "Turn", Initiative: "Initiative", RollAll: "Roll All", RollNPC: "Roll NPCs", Reset: "Reset Initiative", Create: "Create Encounter", Delete: "Delete Encounter",
      TURN_MARKERS: { ANIMATIONS: { SPIN: "Spin", SPIN_PULSE: "Spin & Pulse", PULSE: "Pulse" } },
    },
    CHAT: { To: "To", From: "From", Whisper: "Whisper", RollPublic: "Public Roll", RollPrivate: "Private GM Roll", RollBlind: "Blind GM Roll", RollSelf: "Self Roll", RollVisibility: "Roll Visibility", Flavor: "Flavor", Message: "Message", Delete: "Delete Message", Pop: "Pop out" },
    DICE: { Roll: "Roll", Rolls: "Rolls", Formula: "Formula", Total: "Total", Reroll: "Reroll", Keep: "Keep", Drop: "Drop", Explode: "Explode", Advantage: "Advantage", Disadvantage: "Disadvantage" },
    MACRO: { Name: "Macro Name", Type: "Macro Type", Command: "Command", Execute: "Execute Macro", TypeScript: "Script", TypeChat: "Chat", Create: "Create Macro" },
    SCENE: { Name: "Scene Name", Activate: "Activate", View: "View", Configure: "Configure Scene", Toggle: "Toggle Navigation", Grid: "Grid", GridSize: "Grid Size", Background: "Background Image", Dimensions: "Dimensions" },
    KEYBINDINGS: { Title: "Configure Controls", Save: "Save Changes", Reset: "Reset Defaults", Core: "Core Keybindings", ActionName: "Action", Editable: "Editable" },
    TOUR: { Start: "Start Tour", Exit: "Exit Tour", Next: "Next", Previous: "Previous" },
    FILES: { Browse: "Browse", Upload: "Upload", Select: "Select File", Title: "File Browser", Search: "Search files" },
    JOURNAL: { Title: "Journal", Create: "Create Journal Entry", PageTitle: "Page Title", ViewMode: "View Mode", EditMode: "Edit Mode", ShowPlayers: "Show Players" },
    PACKAGE: { Type: { module: "Module", system: "System", world: "World" }, Title: "Title", Version: "Version", Author: "Author", Dependencies: "Dependencies", Incompatible: "Incompatible" },
    ERROR: { TooManyDocuments: "Too many documents.", RequiredField: "This field is required.", InvalidValue: "The value {value} is not valid.", MissingDocument: "The requested document could not be found." },
    WALL: { Title: "Wall Configuration", Direction: "Wall Direction", Door: "Door Type", DoorState: "Door State", Move: "Movement Restriction", Sense: "Sense Restriction" },
    LIGHT: { Title: "Light Configuration", Color: "Light Color", Dim: "Dim Radius", Bright: "Bright Radius", Angle: "Emission Angle", Animation: "Animation Type", Intensity: "Intensity", Speed: "Speed" },
    Localization: { Language: "Language" },
    DRAWING: { Title: "Drawing Configuration", StrokeColor: "Stroke Color", FillColor: "Fill Color", TextLabel: "Text Label" },
    TILE: { Title: "Tile Configuration", Overhead: "Overhead", Roof: "Roof" },
    PLAYLIST: { Title: "Playlist", Play: "Play", Pause: "Pause", Stop: "Stop", Volume: "Volume", Loop: "Loop" },
    AUDIO: { Title: "Audio", Volume: "Volume", Mute: "Mute" },
    NOTE: { Title: "Map Note", Text: "Text", Icon: "Icon" },
    TEMPLATE: { Title: "Measured Template", Type: "Template Type", Distance: "Distance", Angle: "Angle" },
    SIDEBAR: { Create: "Create {type}", Delete: "Delete", Duplicate: "Duplicate", Import: "Import Data", Export: "Export Data", Configure: "Configure", CharArt: "View Character Artwork", TokenArt: "View Token Artwork", Chat: "Chat Messages", Combat: "Combat Encounters", Scenes: "Scenes", Actors: "Actors", Items: "Items", Journal: "Journal Entries", Tables: "Rollable Tables", Cards: "Card Stacks", Playlists: "Playlists", Compendium: "Compendium Packs", Settings: "Game Settings", Macros: "Macros", Collapse: "Collapse", Expand: "Expand" },
    CARDS: { Title: "Cards", Deck: "Deck", Hand: "Hand", Pile: "Pile", Draw: "Draw", Shuffle: "Shuffle", Deal: "Deal", Pass: "Pass", Reset: "Reset", Face: "Face", Back: "Back" },
    EFFECT: { Title: "Active Effect", Name: "Name", Icon: "Icon", Duration: "Duration", Changes: "Changes", Disabled: "Disabled", Transfer: "Transfer", MODE_CUSTOM: "Custom", MODE_MULTIPLY: "Multiply", MODE_ADD: "Add", MODE_DOWNGRADE: "Downgrade", MODE_UPGRADE: "Upgrade", MODE_OVERRIDE: "Override" },
    GRID: { Type: "Grid Type", Size: "Grid Size", Color: "Grid Color", Alpha: "Grid Opacity", Distance: "Grid Distance", Units: "Grid Units" },
    MEASUREMENT: { Distance: "Distance", Units: "Units" },
    Controls: { Select: "Select", Target: "Target", Ruler: "Ruler", Measure: "Measure" },
    CONTROLS: { Select: "Select Tokens", Target: "Target Tokens", Ruler: "Measure Distance", BasicControls: "Basic Controls", Toggle: "Toggle" },
  });

  // ═══════════════════════════ core stylesheet ═══════════════════════════
  // Class names are the contract; the look is ArenaStar's (dark, compact), tuned to the panel.
  const css = `
    .standard-form { display: flex; flex-direction: column; gap: 8px; }
    .standard-form .form-group { margin: 0; }
    .standard-form fieldset, fieldset { display: flex; flex-direction: column; gap: 6px; margin: 0 0 6px; padding: 8px 10px; border: 1px solid #4b4a55; border-radius: 4px; min-width: 0; }
    fieldset > legend, legend { padding: 0 4px; font-weight: 600; color: #e0b341; }
    fieldset.disabled, fieldset:disabled { opacity: .6; }
    .form-group > label > .units, .form-group .units { font-weight: 400; color: #a9a39a; font-size: 12px; }
    .form-group.slim { margin: 0; } .form-group.slim > label { flex: 1; }
    .form-group .form-fields > * { flex: 1 1 auto; min-width: 0; }
    .form-group .form-fields > label { flex: 0 0 auto; font-weight: 400; }
    .form-group .form-fields input[type="checkbox"], .form-group .form-fields input[type="color"] { flex: 0 0 auto; }
    .form-group .form-fields .sep { flex: 0 0 auto; color: #a9a39a; }
    .form-group .form-fields .range-value { flex: 0 0 3em; text-align: center; }
    .form-group.stacked > label { flex: 0 0 auto; }
    p.hint, .hint { margin: 0; font-size: 12px; line-height: 1.35; color: #a9a39a; }
    p.notes, .notes { font-size: 12px; color: #a9a39a; font-style: italic; }
    .form-footer { flex: 0 0 auto; display: flex; gap: 6px; justify-content: flex-end; align-items: stretch; margin-top: 8px; flex-wrap: wrap; }
    .form-footer button { flex: 1 1 auto; display: inline-flex; align-items: center; justify-content: center; gap: 6px; min-height: 28px; }
    .form-footer button i, button > i, a > i { pointer-events: none; }
    .standard-form button[type="submit"], button.bright, .dialog-button.bright { background: #5a4a2a; border-color: #d9a441; }
    .standard-form button[type="submit"]:hover, button.bright:hover { background: #6d5a33; }
    .tabs.vertical, nav.tabs.vertical { flex-direction: column; border-bottom: 0; border-right: 1px solid #4b4a55; margin: 0 8px 0 0; }
    .tabs.vertical .item, nav.tabs.vertical > a { text-align: left; border-bottom: 0; border-right: 2px solid transparent; }
    .tabs.vertical .item.active, nav.tabs.vertical > a.active { border-right-color: #d9a441; }
    .tabs .item i, nav.tabs > a i { margin-right: 4px; }
    .tab.scrollable, section.scrollable, .scrollable { overflow: hidden auto; }
    .window-content.standard-form, .window-content > form.standard-form { gap: 8px; }
    .flexrow.nowrap { flex-wrap: nowrap; } .flex-wrap { flex-wrap: wrap; }
    .center, .text-center { text-align: center; } .right, .text-right { text-align: right; } .left, .text-left { text-align: left; }
    .nowrap { white-space: nowrap; } .disabled { opacity: .6; pointer-events: none; } .inactive { opacity: .6; }
    .no-margin { margin: 0; } .hidden { display: none !important; } .invisible { visibility: hidden; }
    .items-list, ol.items-list, ul.items-list { list-style: none; margin: 0; padding: 0; }
    .items-list .item, .items-list > li { display: flex; align-items: center; gap: 6px; padding: 3px 4px; border-bottom: 1px solid #3a3946; }
    .items-list .items-header, .items-list > .header { font-weight: 600; background: #2b2a33; border-bottom: 1px solid #4b4a55; }
    .items-list .item-name { flex: 2; display: flex; align-items: center; gap: 6px; overflow: hidden; text-overflow: ellipsis; }
    .items-list .item-image, .items-list .item-img { flex: 0 0 24px; width: 24px; height: 24px; border: 0; }
    .items-list .item-controls { flex: 0 0 auto; display: flex; gap: 4px; }
    .items-list .item-control, .item-control { cursor: pointer; color: #cfc9bd; } .item-control:hover { color: #fff; }
    .directory, .directory-list { list-style: none; margin: 0; padding: 0; }
    .directory .directory-item, .directory-list > li { display: flex; align-items: center; gap: 6px; padding: 3px 4px; border-bottom: 1px solid #3a3946; cursor: pointer; }
    .directory .folder-header, .directory-item.folder > header { font-weight: 600; background: #2b2a33; }
    a.content-link, a.inline-roll, .content-link, .inline-roll { display: inline-block; background: #2b2a33; border: 1px solid #5a4a2a; border-radius: 3px; padding: 0 4px; color: #e8e4dc; text-decoration: none; white-space: nowrap; }
    .content-link.broken { border-style: dashed; color: #a9a39a; }
    .dice-roll { display: flex; flex-direction: column; gap: 4px; margin: 4px 0; }
    .dice-roll .dice-result { display: flex; flex-direction: column; gap: 4px; }
    .dice-roll .dice-formula, .dice-roll .dice-total { background: #15141a; border: 1px solid #4b4a55; border-radius: 3px; padding: 2px 6px; text-align: center; margin: 0; }
    .dice-roll .dice-total { font: 700 18px/1.4 system-ui, sans-serif; }
    .dice-roll .dice-flavor { font-style: italic; color: #a9a39a; }
    .dice-roll .dice-tooltip { display: none; } .dice-roll.expanded .dice-tooltip, .dice-tooltip.expanded { display: block; }
    .dice-tooltip .tooltip-part { border-bottom: 1px solid #3a3946; padding: 2px 0; }
    .dice-tooltip .part-header { display: flex; justify-content: space-between; gap: 6px; font-size: 12px; color: #a9a39a; }
    .dice-tooltip .part-formula { flex: 1; } .dice-tooltip .part-total { flex: 0 0 auto; font-weight: 600; color: #e8e4dc; }
    .dice-tooltip .dice-rolls { list-style: none; display: flex; flex-wrap: wrap; gap: 3px; margin: 2px 0 0; padding: 0; }
    .dice-tooltip .dice-rolls .roll { min-width: 22px; height: 22px; line-height: 22px; text-align: center; border: 1px solid #4b4a55; border-radius: 3px; background: #15141a; font-size: 12px; }
    .dice-tooltip .dice-rolls .roll.max, .dice-tooltip .dice-rolls .roll.success { color: #7fd17f; border-color: #3f8f3f; }
    .dice-tooltip .dice-rolls .roll.min, .dice-tooltip .dice-rolls .roll.failure { color: #e07070; border-color: #8f3f3f; }
    .dice-tooltip .dice-rolls .roll.discarded, .dice-tooltip .dice-rolls .roll.rerolled { opacity: .45; text-decoration: line-through; }
    .dice-tooltip .dice-rolls .roll.exploded { color: #e0b341; }
    .table-draw .table-description { font-style: italic; color: #a9a39a; margin-bottom: 4px; }
    .table-draw .table-results { list-style: none; margin: 0; padding: 0; }
    .table-draw .table-result { display: flex; align-items: center; gap: 6px; padding: 3px 0; border-top: 1px solid #3a3946; }
    .table-draw .result-image { flex: 0 0 28px; width: 28px; height: 28px; }
    .chat-message, li.chat-message { list-style: none; margin: 4px 0; padding: 6px 8px; background: #26252d; border: 1px solid #4b4a55; border-left-width: 3px; border-radius: 4px; }
    .chat-message .message-header { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 8px; font-size: 12px; color: #a9a39a; }
    .chat-message .message-sender { flex: 1; margin: 0; font: 600 13px/1.3 system-ui, sans-serif; color: #e8e4dc; }
    .chat-message .message-metadata { flex: 0 0 auto; display: flex; gap: 6px; }
    .chat-message .flavor-text { flex: 0 0 100%; font-style: italic; }
    .chat-message .whisper-to { flex: 0 0 100%; }
    .chat-message .message-content { margin-top: 4px; }
    .chat-message.whisper { background: #2a2740; } .chat-message.blind { background: #2f2a3a; } .chat-message.emote { font-style: italic; }
    .document-create .form-group { margin: 4px 0; }
    .notification, .notification-pip { padding: 4px 8px; border-radius: 3px; background: #2b2a33; border: 1px solid #4b4a55; }
    .notification.warning, .notification.warn { border-color: #d9a441; } .notification.error { border-color: #c0392b; } .notification.info { border-color: #3a7bd5; }
    .color-picker, color-picker { display: inline-flex; gap: 4px; align-items: center; }
    .file-picker { flex: 0 0 auto; }
    .window-app .sheet-header, .application .sheet-header { display: flex; gap: 8px; align-items: center; margin-bottom: 6px; }
    .sheet-header .profile, .sheet-header img { flex: 0 0 64px; width: 64px; height: 64px; object-fit: cover; }
    .sheet-header h1, .sheet-header .charname { flex: 1; margin: 0; }
    .sheet-header h1 input, .charname input { width: 100%; font: 600 18px/1.3 system-ui, sans-serif; background: transparent; border: 0; border-bottom: 1px solid #4b4a55; }
    .sheet-body { flex: 1; overflow: auto; }
    .editor, .editor-content { min-height: 60px; } .editor-content { padding: 4px; }
    .editor-edit { float: right; cursor: pointer; color: #cfc9bd; }
    hr { border: 0; border-top: 1px solid #4b4a55; margin: 6px 0; }
    h1, h2, h3, h4 { margin: 0 0 6px; } h3, h4 { font-size: 14px; }
    table { border-collapse: collapse; width: 100%; } th, td { padding: 3px 5px; border-bottom: 1px solid #3a3946; text-align: left; }
    thead th, th { background: #2b2a33; font-weight: 600; }
    code, pre { font: 12px/1.4 ui-monospace, monospace; background: #15141a; border-radius: 3px; padding: 1px 3px; } pre { padding: 6px; overflow: auto; }
    input:focus, select:focus, textarea:focus, button:focus-visible { outline: 1px solid #d9a441; outline-offset: 0; }
    input[readonly], textarea[readonly] { color: #a9a39a; }
    input::placeholder, textarea::placeholder { color: #6f6a62; }
    select[multiple], multi-select { min-height: 60px; }
    textarea { min-height: 48px; resize: vertical; width: 100%; }
    input[type="range"] + .range-value, range-picker .range-value { flex: 0 0 3em; text-align: center; }
    label.checkbox { display: inline-flex; align-items: center; gap: 4px; font-weight: 400; }
    button.icon, a.button.icon { padding: 2px 6px; } button.icon > i { margin: 0; }
    button > i + span, a > i + span { margin-left: 4px; }
    .window-title i.window-icon, i.window-icon { margin-right: 4px; }
    .flexrow > .flex0, .flexcol > .flex0 { flex: 0 0 auto; }
    .flexrow > .flex1, .flexcol > .flex1 { flex: 1 1 0; } .flexrow > .flex2 { flex: 2 1 0; } .flexrow > .flex3 { flex: 3 1 0; }
    .flexrow.justify-between { justify-content: space-between; } .align-center { align-items: center; }
    .pulse, .glow { box-shadow: 0 0 6px #d9a441; }
    .border, .bordered { border: 1px solid #4b4a55; border-radius: 3px; padding: 4px; }
    .controls, .control-buttons { display: flex; gap: 4px; }
    .ais-core-fallback { padding: 8px; border: 1px dashed #8f3f3f; color: #e07070; font-size: 12px; }
  `;

  globalThis.__aisFoundryCore = Object.freeze({ templates, aliases, resolveTemplate, lang, css, templatePaths: Object.freeze(Object.keys(templates)) });
})();
