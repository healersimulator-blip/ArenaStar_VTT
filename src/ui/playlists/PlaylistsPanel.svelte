<script lang="ts">
  /**
   * §10/§7 Playlists panel — sounds with play/stop. Playback requests ride
   * client.sendAudioCmd → host stamps + rebroadcasts → every client's
   * AudioPlayer starts at atHostTime − clockOffset (§7).
   */
  import { onMount } from "svelte";
  import type { ClientSync } from "../../client/sync";
  import type { ClientEvents } from "../../client/sync";
  import type { EventBus } from "../../core/events";
  import type { PlaylistDocument, PlaylistSoundDocument } from "../../core/documents";
  import { parsePlaylistMode, PLAYLIST_MODES, type PlaylistMode } from "../../core/audio";

  let {
    client,
    bus,
    player = null,
  }: {
    client: ClientSync;
    bus: EventBus<ClientEvents>;
    player?: {
      state(soundId: string): string | null;
      lastDelays: Map<string, number>;
    } | null;
  } = $props();

  let playlists = $state<PlaylistDocument[]>([]);
  let selectedId = $state<string | null>(null);
  let newSound = $state("");
  const playlist = $derived(playlists.find((p) => p._id === selectedId) ?? null);
  const isGm = $derived(client.user?.role === "GM" || client.user?.role === "ASSISTANT");

  function refresh(): void {
    playlists = [...(client.store.getAll("playlists") as readonly PlaylistDocument[])];
    if (selectedId && !playlists.some((p) => p._id === selectedId))
      selectedId = playlists[0]?._id ?? null;
    if (!selectedId && playlists[0]) selectedId = playlists[0]._id;
  }

  function createPlaylist(): void {
    const doc: PlaylistDocument = {
      _id: globalThis.crypto.randomUUID(),
      type: "playlist",
      name: `Playlist ${playlists.length + 1}`,
      ownership: { default: 1 },
      flags: {},
      system: {},
      mode: "off",
      sounds: [],
    };
    client.submit([{ kind: "create", coll: "playlists", data: doc }]);
  }

  function addSound(): void {
    if (!playlist || !newSound.trim()) return;
    const sound: PlaylistSoundDocument = {
      _id: globalThis.crypto.randomUUID(),
      type: "playlistSound",
      name: newSound.trim().slice(0, 40),
      ownership: { default: 1 },
      flags: {},
      system: {},
      audio: newSound.trim(),
      volume: 0.8,
      loop: false,
    };
    client.submit([
      {
        kind: "update",
        ref: { coll: "playlists", id: playlist._id },
        diff: { sounds: [...playlist.sounds, sound] },
      },
    ]);
    newSound = "";
  }

  function setMode(mode: PlaylistMode): void {
    if (!playlist) return;
    client.submit([
      { kind: "update", ref: { coll: "playlists", id: playlist._id }, diff: { mode } },
    ]);
  }

  function play(soundId: string): void {
    if (!playlist) return;
    client.sendAudioCmd({ playlistId: playlist._id, soundId, action: "play", offset: 0 });
  }

  function stop(soundId: string): void {
    if (!playlist) return;
    client.sendAudioCmd({ playlistId: playlist._id, soundId, action: "stop", offset: 0 });
  }

  onMount(() => {
    const offSnapshot = bus.on("snapshot", refresh);
    const offOps = bus.on("ops", refresh);
    refresh();
    return () => {
      offSnapshot();
      offOps();
    };
  });
</script>

<section class="playlists" aria-label="Playlists">
  <h3>Playlists</h3>
  {#if isGm}
    <button id="playlist-create" type="button" onclick={createPlaylist}>New playlist</button>
  {/if}
  <ul class="list">
    {#each playlists as p (p._id)}
      <li>
        <button type="button" class:sel={p._id === selectedId} onclick={() => (selectedId = p._id)}>
          {p.name}
        </button>
      </li>
    {/each}
  </ul>
  {#if playlist}
    <label class="mode">
      Mode
      <select
        value={parsePlaylistMode(playlist.mode)}
        onchange={(e) => setMode((e.target as HTMLSelectElement).value as PlaylistMode)}
      >
        {#each PLAYLIST_MODES as m (m)}
          <option value={m}>{m}</option>
        {/each}
      </select>
    </label>
    <ul class="sounds">
      {#each playlist.sounds as s (s._id)}
        <li class="sound" data-sound={s._id}>
          <span class="name">{s.name}</span>
          <span class="state" data-state>{player?.state(s._id) ?? "—"}</span>
          <button type="button" onclick={() => play(s._id)}>▶</button>
          <button type="button" onclick={() => stop(s._id)}>■</button>
        </li>
      {/each}
    </ul>
    {#if isGm}
      <form
        onsubmit={(e) => {
          e.preventDefault();
          addSound();
        }}
      >
        <input
          id="playlist-sound"
          type="text"
          bind:value={newSound}
          placeholder="Sound name (audio ref = name)"
        />
        <button id="playlist-add" type="submit">Add sound</button>
      </form>
    {/if}
  {/if}
</section>

<style>
  .playlists {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
  }
  button.sel {
    background: #2c4a6e;
  }
  .sounds {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 3px;
  }
  .sound {
    display: flex;
    align-items: center;
    gap: 4px;
  }
  .name {
    flex: 1;
    font-size: 12px;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .state {
    font-size: 10px;
    opacity: 0.7;
    min-width: 4em;
  }
  .mode {
    font-size: 12px;
    display: flex;
    gap: 4px;
    align-items: center;
  }
</style>
