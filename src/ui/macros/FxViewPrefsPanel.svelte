<!--
  D-295 (SQ-13/SQ-16) — "Effects on this device".

  Every switch here is a *local* choice: reduced camera motion, muted FX sounds, how
  far ahead to prefetch media and what to do with a cue whose bytes arrived late. The
  panel exists in both shells (the GM's Settings window and the player's "Session &
  guide"), because the person who needs it is the one watching the table, not the GM
  — and it says so in one line so nobody worries it turned off someone else's effect.
-->
<script lang="ts">
  import { onDestroy } from "svelte";
  import { MAX_PRELOAD_AHEAD_MS, fxViewPrefs, setFxViewPrefs, type FxViewPrefs } from "../../core/fxPrefs";
  import { SOUND_CHANNELS, SOUND_CHANNEL_LABELS, type FxSoundChannel } from "../../core/fxSound";
  import { stopFxSounds, subscribeFxSounds, type LiveFxSound } from "../../client/fxSounds";

  let prefs = $state<FxViewPrefs>(fxViewPrefs());
  /** What THIS browser is playing right now (D-297) — not the host's instances. */
  let playing = $state<LiveFxSound[]>([]);
  let localNote = $state("");
  const offSounds = subscribeFxSounds((sounds) => { playing = sounds; });
  onDestroy(() => { offSounds(); });

  function update(patch: Partial<FxViewPrefs>): void {
    prefs = setFxViewPrefs(patch);
  }
  function setChannel(channel: FxSoundChannel, value: number): void {
    update({ soundMix: { ...prefs.soundMix,
      channels: { ...prefs.soundMix.channels, [channel]: value } } });
  }
  function stop(sound: LiveFxSound): void {
    stopFxSounds({ runId: sound.runId });
    localNote = `Stopped ${sound.name ?? "this sound"} on this device — other people still hear the timeline.`;
  }
  function stopAll(): void {
    const count = stopFxSounds();
    localNote = count === 0 ? "Nothing was playing here." : `Stopped ${count} sound(s) on this device only.`;
  }
</script>

<section class="fx-prefs" aria-label="Effects on this device" data-fx-prefs>
  <label class="check">
    <input type="checkbox" data-fx-pref-reduced-motion aria-label="Reduce motion"
      checked={prefs.reduceMotion}
      onchange={(event) => update({ reduceMotion: event.currentTarget.checked })} />
    Reduce camera motion (pan by cutting to the destination, skip shakes)
  </label>
  <label class="check">
    <input type="checkbox" data-fx-pref-mute-sound aria-label="Mute FX sounds"
      checked={prefs.muteSound}
      onchange={(event) => update({ muteSound: event.currentTarget.checked })} />
    Mute FX sounds on this device
  </label>
  <label>Preload media ahead
    <span class="inline">
      <input type="number" data-fx-pref-preload aria-label="Preload ahead milliseconds"
        min="0" max={MAX_PRELOAD_AHEAD_MS} step="250" value={prefs.preloadAheadMs}
        onchange={(event) => update({ preloadAheadMs: Number(event.currentTarget.value) })} />
      <small>ms (0 fetches only when a cue starts)</small>
    </span>
  </label>
  <label>When media is late
    <select data-fx-pref-late-media aria-label="Late media behaviour" value={prefs.lateMedia}
      onchange={(event) => update({ lateMedia: event.currentTarget.value === "skip" ? "skip" : "delay" })}>
      <option value="delay">Start as soon as it loads</option>
      <option value="skip">Skip that cue</option>
    </select>
  </label>
  <fieldset data-fx-mix>
    <legend>Sound mix on this device</legend>
    {#each SOUND_CHANNELS as channel (channel)}
      <label>{SOUND_CHANNEL_LABELS[channel]}
        <span class="inline">
          <input type="range" min="0" max="1" step="0.05" data-fx-mix-channel={channel}
            aria-label={`${SOUND_CHANNEL_LABELS[channel]} volume`} value={prefs.soundMix.channels[channel]}
            oninput={(event) => setChannel(channel, Number(event.currentTarget.value))} />
          <small data-fx-mix-value={channel}>{Math.round(prefs.soundMix.channels[channel] * 100)}%</small>
        </span>
      </label>
    {/each}
  </fieldset>
  <div class="playing" data-fx-playing>
    <div class="row"><strong>Playing on this device</strong>
      {#if playing.length > 0}
        <button type="button" data-fx-stop-sounds onclick={stopAll}>Stop all here</button>
      {/if}
    </div>
    {#each playing as sound (sound.id)}
      <div class="row" data-fx-playing-sound={sound.id}>
        <span>{sound.name ?? "FX sound"} · {SOUND_CHANNEL_LABELS[sound.channel]}
          {#if sound.persistent}<em>loop</em>{/if}
          <small>{Math.round(sound.gain * 100)}%</small></span>
        <button type="button" data-fx-stop-sound={sound.id} onclick={() => stop(sound)}>Stop here</button>
      </div>
    {:else}
      <small data-fx-playing-empty>Nothing is playing on this device.</small>
    {/each}
    {#if localNote}<small role="status" data-fx-sound-note>{localNote}</small>{/if}
  </div>
  <p class="hint">Saved in this browser only. These settings change what <em>you</em> see and hear;
    other people's effects are unaffected, and nothing here is sent to the host. Stopping a sound here
    silences it on this device — a persistent cue is still running for everyone else until the GM stops it in Live FX.</p>
</section>

<style>
  .fx-prefs { display: grid; gap: 5px; font-size: 0.8125rem; }
  label { display: flex; flex-direction: column; gap: 2px; }
  .check { flex-direction: row; align-items: center; gap: 6px; }
  .check input { width: auto; }
  .inline { display: flex; align-items: center; gap: 5px; }
  .inline input { width: 6.5em; }
  .inline small { color: #aab6c6; }
  .hint { margin: 0; color: #b4bdc8; }
  fieldset { display: grid; gap: 4px; border: 1px solid #53586a; border-radius: 4px; padding: 6px; }
  fieldset label { flex-direction: row; align-items: center; justify-content: space-between; gap: 8px; }
  input[type="range"] { width: 9em; }
  .playing { display: grid; gap: 4px; }
  .row { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
  .playing small { color: #aab6c6; }
  .playing em { color: #9fd8b6; font-style: normal; }
  .playing button { padding: 1px 6px; }
</style>
