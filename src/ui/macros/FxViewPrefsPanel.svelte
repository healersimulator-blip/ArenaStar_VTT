<!--
  D-295 (SQ-13/SQ-16) — "Effects on this device".

  Every switch here is a *local* choice: reduced camera motion, muted FX sounds, how
  far ahead to prefetch media and what to do with a cue whose bytes arrived late. The
  panel exists in both shells (the GM's Settings window and the player's "Session &
  guide"), because the person who needs it is the one watching the table, not the GM
  — and it says so in one line so nobody worries it turned off someone else's effect.
-->
<script lang="ts">
  import { MAX_PRELOAD_AHEAD_MS, fxViewPrefs, setFxViewPrefs, type FxViewPrefs } from "../../core/fxPrefs";

  let prefs = $state<FxViewPrefs>(fxViewPrefs());

  function update(patch: Partial<FxViewPrefs>): void {
    prefs = setFxViewPrefs(patch);
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
  <p class="hint">Saved in this browser only. These settings change what <em>you</em> see and hear;
    other people's effects are unaffected, and nothing here is sent to the host.</p>
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
</style>
