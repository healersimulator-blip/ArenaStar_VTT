<script lang="ts">
  /**
   * D-476: the schema-driven form for one module's `interconnect.settings`. Both shells use it —
   * the GM's packages view renders world + device scope, the player's Shared-modules card renders
   * device scope only (world scope is shown read-only there). The component never decides what a
   * value may be: `onChange` goes to the runtime, which coerces against the declaration and either
   * commits (world) or stores locally (device); an error comes back as text under the field.
   */
  import type { AisSettingDeclaration, AisSettingValue } from "../../core/automationInterconnect";

  let {
    packageId,
    declarations,
    values,
    editableScopes = ["world", "device"],
    disabled = false,
    onChange,
  }: {
    packageId: string;
    declarations: AisSettingDeclaration[];
    values: Record<string, AisSettingValue>;
    /** Scopes this shell may write; the others render read-only with a note. */
    editableScopes?: Array<"world" | "device">;
    disabled?: boolean;
    onChange: (key: string, value: AisSettingValue) => Promise<unknown>;
  } = $props();

  let errors = $state<Record<string, string>>({});
  let busyKey = $state<string | null>(null);

  async function submit(declaration: AisSettingDeclaration, raw: AisSettingValue): Promise<void> {
    busyKey = declaration.key;
    try {
      await onChange(declaration.key, raw);
      const next = { ...errors };
      Reflect.deleteProperty(next, declaration.key);
      errors = next;
    } catch (error) {
      errors = { ...errors, [declaration.key]: error instanceof Error ? error.message : String(error) };
    } finally {
      busyKey = null;
    }
  }

  function numberOf(declaration: AisSettingDeclaration, text: string): AisSettingValue {
    const parsed = Number(text);
    return Number.isFinite(parsed) ? parsed : declaration.default;
  }

  const scopeLabel = (scope: "world" | "device"): string =>
    scope === "world" ? "world · set by the GM, shared with every player" : "this device only";
</script>

<div class="ais-settings-form" data-ais-settings-form={packageId}>
  {#if declarations.some((declaration) => declaration.hidden)}
    <p class="hint" data-ais-settings-hidden={declarations.filter((declaration) => declaration.hidden).length}>
      {declarations.filter((declaration) => declaration.hidden).length} internal setting(s) are kept by the module itself and not shown here.
    </p>
  {/if}
  {#each declarations.filter((declaration) => !declaration.hidden) as declaration (declaration.key)}
    {@const editable = editableScopes.includes(declaration.scope) && !disabled}
    {@const inputId = `ais-setting-${packageId}-${declaration.key}`}
    <div class="ais-setting" data-ais-setting={declaration.key} data-ais-setting-scope={declaration.scope}>
      <label for={inputId}>
        <span class="label">{declaration.label}</span>
        <span class="scope">{scopeLabel(declaration.scope)}</span>
      </label>
      {#if declaration.type === "boolean"}
        <input id={inputId} type="checkbox" checked={values[declaration.key] === true} disabled={!editable || busyKey === declaration.key}
          onchange={(event) => void submit(declaration, event.currentTarget.checked)} />
      {:else if declaration.type === "number"}
        <input id={inputId} type="number" value={String(values[declaration.key] ?? declaration.default)}
          min={declaration.min} max={declaration.max} step={declaration.step ?? "any"}
          disabled={!editable || busyKey === declaration.key}
          onchange={(event) => void submit(declaration, numberOf(declaration, event.currentTarget.value))} />
      {:else if declaration.type === "choice"}
        <select id={inputId} value={String(values[declaration.key] ?? declaration.default)} disabled={!editable || busyKey === declaration.key}
          onchange={(event) => void submit(declaration, event.currentTarget.value)}>
          {#each declaration.choices ?? [] as choice (choice.value)}
            <option value={choice.value}>{choice.label}</option>
          {/each}
        </select>
      {:else}
        <input id={inputId} type="text" value={String(values[declaration.key] ?? declaration.default)}
          maxlength={declaration.maxLength ?? 256} disabled={!editable || busyKey === declaration.key}
          onchange={(event) => void submit(declaration, event.currentTarget.value)} />
      {/if}
      {#if declaration.hint}<p class="hint">{declaration.hint}</p>{/if}
      {#if errors[declaration.key]}<p class="error" data-ais-setting-error={declaration.key}>{errors[declaration.key]}</p>{/if}
    </div>
  {/each}
</div>

<style>
  .ais-settings-form { display: flex; flex-direction: column; gap: 8px; margin: 6px 0; }
  .ais-setting { display: grid; grid-template-columns: minmax(140px, 1fr) minmax(120px, 220px); gap: 4px 12px; align-items: center; font-size: 13px; }
  .ais-setting label { display: flex; flex-direction: column; }
  .ais-setting .scope { font-size: 11px; opacity: 0.7; }
  .ais-setting .hint, .ais-setting .error { grid-column: 1 / -1; margin: 0; font-size: 12px; }
  .ais-setting .hint { opacity: 0.75; }
  .ais-setting .error { color: var(--danger, #c0392b); }
</style>
