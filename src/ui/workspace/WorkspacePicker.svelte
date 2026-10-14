<script lang="ts">
  import { onMount } from "svelte";
  import { WORKSPACE_PROFILES, WORKSPACE_PROFILE_INFO, type WorkspaceProfile } from "../../core/workspaceUi";
  import { workspaceUi, setWorkspaceProfile, setWorkspaceScheme, setWorkspacePanel } from "./state";
  import Icon from "../icons/Icon.svelte";
  let { onClose, onColors = null }: { onClose: () => void; onColors?: (() => void) | null } = $props();
  let dialog: HTMLDialogElement;
  onMount(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialog.showModal();
    return () => { dialog.close(); previous?.focus(); };
  });
  function choose(profile: WorkspaceProfile) { setWorkspaceProfile(profile); }
</script>

<dialog bind:this={dialog} class="workspace-picker" aria-labelledby="workspace-title" data-workspace-picker
  oncancel={(event) => { event.preventDefault(); onClose(); }} onkeydown={(event) => event.stopPropagation()}>
  <header><div><span class="eyebrow">MAKE YOURSELF AT HOME</span><h2 id="workspace-title">Your table. Your workspace.</h2></div>
    <button type="button" class="close" aria-label="Close workspace chooser" onclick={onClose}><Icon name="x" /></button></header>
  <p class="intro">Three ways to play the same world. This choice stays on your device—not everyone else’s screen.</p>
  <div class="profile-grid">
    {#each WORKSPACE_PROFILES as profile (profile)}
      <button class="profile" class:active={$workspaceUi.profile === profile} data-workspace-mode={profile}
        aria-pressed={$workspaceUi.profile === profile} onclick={() => choose(profile)}>
        <div class="preview" class:modern={profile === "modern"} class:foundry={profile === "foundry"} class:roll20={profile === "roll20"} aria-hidden="true">
          <div class="map"><span>✦</span><span>✦</span><i></i></div>
          <div class="preview-top"><b></b><i></i><i></i><i></i></div>
          <div class="preview-tools">{#each { length: 7 }, i (i)}<i></i>{/each}</div>
          {#if profile === "foundry"}<div class="preview-subtools">{#each { length: 4 }, i (i)}<i></i>{/each}</div>{/if}
          <div class="preview-tabs">{#each { length: 7 }, i (i)}<i></i>{/each}</div>
          <div class="preview-panel"><b></b><i></i><i></i><i></i></div>
          <div class="preview-hotbar">{#each { length: 10 }, i (i)}<i></i>{/each}</div>
        </div>
        <div class="profile-copy"><span class="profile-label">{WORKSPACE_PROFILE_INFO[profile].label}</span>
          <div class="profile-title"><strong>{WORKSPACE_PROFILE_INFO[profile].name}</strong><span class="radio"></span></div>
          <span class="description">{WORKSPACE_PROFILE_INFO[profile].description}</span>
        </div>
      </button>
    {/each}
  </div>
  <div class="options">
    <label><input type="checkbox" data-workspace-sidebar checked={$workspaceUi.panels[$workspaceUi.profile]}
      onchange={(event) => setWorkspacePanel(event.currentTarget.checked)} /> Keep the content panel open</label>
    {#if $workspaceUi.profile === "roll20"}
      <label>Roll20 appearance <select data-workspace-scheme value={$workspaceUi.roll20Scheme}
        onchange={(event) => setWorkspaceScheme(event.currentTarget.value === "dark" ? "dark" : "light")}>
        <option value="light">Light</option><option value="dark">Dark</option></select></label>
    {:else if $workspaceUi.profile === "modern" && onColors}
      <button class="subtle" data-workspace-colors onclick={() => { onClose(); onColors?.(); }}><Icon name="palette" size={16} /> Optional appearance modules</button>
    {/if}
  </div>
  <p class="detail">{WORKSPACE_PROFILE_INFO[$workspaceUi.profile].detail}</p>
  {#if $workspaceUi.profile !== "modern"}<p class="reference-note">Compatibility layout, not the original product. Pixel-perfect parity across every window and system sheet is not certified.</p>{/if}
  <footer><span>Change this any time from the workspace button.</span><button class="done" data-workspace-done onclick={onClose}>Back to the table <span aria-hidden="true">→</span></button></footer>
</dialog>

<style>
  .workspace-picker { position:fixed; inset:50% auto auto 50%; transform:translate(-50%,-50%); margin:0; width:min(990px,calc(100% - 40px)); max-height:calc(100dvh - 40px); overflow:auto; border:1px solid #3a414b; border-radius:16px; padding:28px; background:#14181f; color:#eef0f4; box-shadow:0 24px 100px #0008; font:14px/1.5 Inter,system-ui,sans-serif; }
  .workspace-picker::backdrop { background:#080b11b5; backdrop-filter:blur(7px); }
  header { display:flex; justify-content:space-between; align-items:start; gap:16px; } h2 { margin:6px 0; font-size:29px; font-weight:550; letter-spacing:-.045em; }
  .eyebrow { color:#a4a8b5; font-size:10px; font-weight:600; letter-spacing:.16em; } .intro { color:#aab0bd; margin:6px 0 24px; font-size:13px; }
  button,select { font:inherit; color:inherit; cursor:pointer; } .close { background:transparent; border:1px solid #3a414b; border-radius:7px; width:30px; height:30px; display:grid; place-items:center; padding:0; }
  .profile-grid { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:14px; }
  .profile { padding:0; text-align:left; overflow:hidden; border:1px solid #363e4b; border-radius:11px; background:#1b2029; }
  .profile.active { border-color:#90adfa; box-shadow:0 0 0 1px #90adfa; } .profile:hover { border-color:#768cbd; }
  .profile-copy { display:flex; flex-direction:column; padding:16px; } .profile-label { color:#9ca4b3; font-size:10px; text-transform:uppercase; letter-spacing:.1em; }
  .profile-title { display:flex; justify-content:space-between; align-items:center; margin:5px 0 9px; } strong { font-weight:600; font-size:19px; letter-spacing:-.03em; }
  .radio { width:15px; height:15px; border:1px solid #607084; border-radius:50%; } .active .radio { border:4px solid #8dabff; background:#1c283f; }
  .description { color:#bac0ca; font-size:12px; line-height:1.6; min-height:39px; }
  .preview { height:170px; position:relative; background:#202731; border-bottom:1px solid #343b47; overflow:hidden; }
  .map { position:absolute; inset:0; background:radial-gradient(ellipse at 45% 58%,#48575c 0 8%,#28363b 9% 13%,#52605a 14% 16%,transparent 17%),linear-gradient(35deg,transparent 40%,#51605b44 41% 66%,transparent 67%),repeating-linear-gradient(0deg,#34413f 0 17px,#3d4a471a 17px 18px); }
  .map span { position:absolute; top:58%; left:32%; color:#e2c696; font-size:14px; } .map span+span { top:43%; left:61%; color:#bfd5dc; }
  .preview-top { position:absolute; top:0; left:0; right:0; height:20px; background:#171c23; display:flex; align-items:center; gap:6px; padding:5px 8px; }
  .preview-top b { width:36%; height:4px; background:#8793a6; margin-right:auto; } .preview-top i { width:5px; height:5px; background:#9ba7b5; border-radius:2px; }
  .preview-tools { position:absolute; top:34px; left:8px; width:18px; display:flex; flex-direction:column; gap:6px; padding:6px; background:#161d25; border-radius:5px; }
  .preview-tools i,.preview-tabs i { width:6px; height:6px; background:#bcc4cf; border-radius:1px; } .preview-tools i:first-child { background:#9eb7ff; }
  .preview-tabs { position:absolute; top:34px; right:7px; display:flex; flex-direction:column; padding:6px; gap:7px; background:#161d25; border-radius:5px; }
  .preview-panel { display:none; } .preview-hotbar { position:absolute; bottom:8px; left:27%; display:flex; gap:2px; padding:3px; border-radius:4px; background:#151b23; }
  .preview-hotbar i { width:8px; height:9px; background:#2b3545; border:1px solid #516079; }
  .foundry { background:#080910; } .foundry .preview-top { top:8px; left:38px; right:54px; width:auto; height:14px; border-radius:3px; background:#100b18dd; }
  .foundry .preview-top b { background:#c5ad8b; } .foundry .preview-top i { display:none; }
  .foundry .preview-tools { background:none; left:6px; top:9px; padding:0; gap:3px; } .foundry .preview-tools i { width:16px; height:16px; background:#13101f; border:1px solid #645340; border-radius:3px; }
  .preview-subtools { position:absolute; left:26px; top:9px; display:flex; flex-direction:column; gap:3px; } .preview-subtools i { width:16px; height:16px; background:#171321; border:1px solid #5b534c; border-radius:3px; }
  .foundry .preview-tabs { top:8px; right:5px; background:none; gap:5px; } .foundry .preview-tabs i { width:12px; height:12px; background:#171320; border-radius:3px; }
  .foundry .preview-hotbar { left:18%; bottom:5px; border:1px solid #6d5645; border-radius:3px; background:#11101ae8; }
  .roll20 .preview-top { display:none; } .roll20 .preview-tools { top:0; bottom:0; left:0; border-radius:0; padding:8px 7px; width:21px; background:#101313; }
  .roll20 .preview-tools i { width:7px; height:7px; background:#c9cdcb; } .roll20 .preview-tools i:first-child { background:#5bb883; }
  .roll20 .preview-panel { display:block; position:absolute; width:29%; right:0; top:0; bottom:0; background:#f5f5f5; padding:25px 6px; }
  .roll20 .preview-panel b { display:block; width:60%; height:4px; background:#774494; margin-bottom:9px; } .roll20 .preview-panel i { display:block; width:100%; height:3px; background:#c4c5cb; margin-bottom:6px; }
  .roll20 .preview-tabs { z-index:1; top:0; right:0; width:29%; flex-direction:row; background:#e7e6ed; border-radius:0; padding:5px; gap:3px; } .roll20 .preview-tabs i { width:7px; height:7px; background:#65646b; }
  .roll20 .preview-hotbar { left:25px; bottom:5px; background:transparent; } .roll20 .preview-hotbar i { width:15px; height:9px; background:#efefef; border-color:#aeb0b4; }
  .options { margin:22px 0 14px; display:flex; gap:18px; align-items:center; flex-wrap:wrap; padding:14px; border:1px solid #323a47; border-radius:9px; }
  label { display:flex; gap:8px; align-items:center; color:#c4c8d1; font-size:12px; } input { accent-color:#8dabff; } select { background:#242b36; border:1px solid #475166; border-radius:5px; padding:5px 10px; }
  .subtle { display:flex; gap:7px; align-items:center; margin-left:auto; padding:5px 8px; border:0; border-radius:5px; background:transparent; color:#a7bded; font-size:12px; }
  .detail,.reference-note { color:#a4acb9; font-size:12px; margin:7px 0; } .reference-note { font-size:11px; color:#929ba9; }
  footer { display:flex; justify-content:space-between; align-items:center; gap:15px; margin-top:24px; color:#939dae; font-size:11px; }
  .done { border:1px solid #a4bcf9; background:#a4bcf9; color:#152034; border-radius:7px; padding:8px 13px; font-size:12px; font-weight:650; } .done span { margin-left:20px; }
  @media(max-width:730px) { .workspace-picker { padding:18px; } .profile-grid { grid-template-columns:1fr; } .profile { display:grid; grid-template-columns:130px 1fr; } .preview { height:140px; border:0; } h2 { font-size:24px; } .subtle { margin:0; } footer { align-items:flex-start; } }
</style>
