<script lang="ts">
  /** One consistent 24px outline language for the app shell and map tools.
   * Decorative only: the parent button supplies its accessible name/shortcut. */
  let { name, size = 20 }: { name: string; size?: number } = $props();
</script>

<svg
  width={size}
  height={size}
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
  stroke-width="1.8"
  stroke-linecap="round"
  stroke-linejoin="round"
  aria-hidden="true"
  focusable="false"
>
  {#if name === "select"}<path d="m4 3 15 9-7 1.4L9 20 4 3Z" /><path
      d="m12 13.5 3.5 6"
    />
  {:else if name === "pan"}<path
      d="M8 11V5a1.5 1.5 0 0 1 3 0v5-6a1.5 1.5 0 0 1 3 0v6-4a1.5 1.5 0 0 1 3 0v5-2a1.5 1.5 0 0 1 3 0v5c0 4-2.5 7-6 7H9c-2 0-3-.8-4-2l-2-3.5c-.5-1.7 1.3-3 2.6-2L8 16"
    />
  {:else if name === "draw"}<path
      d="m4 20 4.5-1 11-11a2 2 0 0 0-3-3l-11 11L4 20Z"
    /><path d="m15 6 3 3M4 20h16" />
  {:else if name === "text"}<path d="M4 6V4h16v2M12 4v16m-4 0h8" />
  {:else if name === "measure"}<path d="m4 17 13-13 4 4L8 21l-4-4Z" /><path
      d="m13 8 2 2m-6 2 2 2m-6 2 2 2"
    />
  {:else if name === "dice"}<rect
      x="4"
      y="4"
      width="16"
      height="16"
      rx="3"
    /><circle cx="8" cy="8" r=".8" fill="currentColor" /><circle
      cx="16"
      cy="8"
      r=".8"
      fill="currentColor"
    /><circle cx="12" cy="12" r=".8" fill="currentColor" /><circle
      cx="8"
      cy="16"
      r=".8"
      fill="currentColor"
    /><circle cx="16" cy="16" r=".8" fill="currentColor" />
  {:else if name === "fog"}<path d="M3 9h18M3 13h15M5 17h16M6 5h12" /><path
      d="m20 3-2 2m3 14-2 2"
    />
  {:else if name === "wall"}<path
      d="M3 5h18v14H3zM3 10h18M3 15h18m-12-10v5m6 0v5m-6 0v4"
    />
  {:else if name === "light" || name === "lighting"}<circle
      cx="12"
      cy="12"
      r="4"
    /><path
      d="M12 2v2m0 16v2M2 12h2m16 0h2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M19.1 4.9l-1.4 1.4M6.3 17.7l-1.4 1.4"
    />
  {:else if name === "pin"}<path
      d="M18 10c0 4-6 11-6 11S6 14 6 10a6 6 0 1 1 12 0Z"
    /><circle cx="12" cy="10" r="2" />
  {:else if name === "path"}<circle cx="5" cy="18" r="2" /><circle
      cx="19"
      cy="6"
      r="2"
    /><path d="M7 18h4a3 3 0 0 0 0-6H9a3 3 0 0 1 0-6h8" />
  {:else if name === "map" || name === "mapImport"}<path
      d="m3 6 6-2 6 2 6-2v14l-6 2-6-2-6 2V6Zm6-2v14m6-12v14"
    />{#if name === "mapImport"}<path d="M16 11v5m-2.5-2.5h5" />{/if}
  {:else if name === "tokens" || name === "actors"}<circle
      cx="12"
      cy="8"
      r="3"
    /><path d="M5 20v-2a7 7 0 0 1 14 0v2H5Z" />
  {:else if name === "gm" || name === "permissions"}<path
      d="m12 2 8 3v6c0 5-3 8-8 11-5-3-8-6-8-11V5l8-3Z"
    /><path d="m9 12 2 2 4-4" />
  {:else if name === "zoomIn" || name === "zoomOut"}<circle
      cx="10.5"
      cy="10.5"
      r="6.5"
    /><path d="m16 16 5 5M7.5 10.5h6" />{#if name === "zoomIn"}<path
        d="M10.5 7.5v6"
      />{/if}
  {:else if name === "fit"}<path
      d="M9 3H4a1 1 0 0 0-1 1v5m12-6h5a1 1 0 0 1 1 1v5M3 15v5a1 1 0 0 0 1 1h5m12-6v5a1 1 0 0 1-1 1h-5"
    />
  {:else if name === "turn" || name === "addTurn"}<path
      d="M5 6h14M5 12h14M5 18h9"
    />{#if name === "addTurn"}<path d="M19 16v6m-3-3h6" />{/if}
  {:else if name === "settings"}<path
      d="M10 2h4l.5 2.2 1.8.8 1.9-1.1 2.8 2.8-1.1 1.9.8 1.8L23 10v4l-2.3.5-.8 1.8 1.1 1.9-2.8 2.8-1.9-1.1-1.8.8L14 23h-4l-.5-2.3-1.8-.8-1.9 1.1-2.8-2.8 1.1-1.9-.8-1.8L1 14v-4l2.3-.5.8-1.8L3 5.8 5.8 3l1.9 1.1 1.8-.8L10 2Z"
    /><circle cx="12" cy="12" r="3.2" />
  {:else if name === "sliders"}<path d="M4 7h16M4 12h16M4 17h16" /><circle
      cx="9" cy="7" r="2" fill="var(--vtt-panel, #151b24)"
    /><circle cx="16" cy="12" r="2" fill="var(--vtt-panel, #151b24)" /><circle
      cx="11" cy="17" r="2" fill="var(--vtt-panel, #151b24)"
    />
  {:else if name === "help"}<circle cx="12" cy="12" r="9" /><path
      d="M9.6 9a2.6 2.6 0 0 1 5.1.7c0 2-2.7 2.4-2.7 4.3m0 3h.01"
    />
  {:else if name === "trash"}<path
      d="M4 7h16m-13 0 1 13h8l1-13M9 7V4h6v3m-5 4v5m4-5v5"
    />
  {:else if name === "addToken"}<circle cx="10" cy="7" r="3" /><path
      d="M3 20v-2a7 7 0 0 1 9-6.7m6.5 1.7v8m-4-4h8"
    />
  {:else if name === "undo"}<path d="M9 6 4 11l5 5M4 11h10a6 6 0 0 1 0 12" />
  {:else if name === "redo"}<path d="m15 6 5 5-5 5m5-5H10a6 6 0 0 0 0 12" />
  {:else if name === "macro"}<path d="m13 2-3 8h7l-6 12 2-9H6l7-11Z" />
  {:else if name === "share"}<circle cx="18" cy="5" r="2" /><circle
      cx="6"
      cy="12"
      r="2"
    /><circle cx="18" cy="19" r="2" /><path d="m8 11 8-5m-8 7 8 5" />
  {:else if name === "export"}<path d="M12 3v12m-4-4 4 4 4-4M4 17v3h16v-3" />
  {:else if name === "close"}<path
      d="M10 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h5M14 7l5 5-5 5m5-5H9"
    />
  {:else if name === "extras"}<path
      d="m12 2 1.8 6.2L20 10l-6.2 1.8L12 18l-1.8-6.2L4 10l6.2-1.8L12 2Zm7 13 .8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8L19 15Z"
    />
  {:else if name === "armies"}<path
      d="M4 20V8l8-5 8 5v12H4ZM9 20v-7h6v7M4 10h16"
    />
  {:else if name === "tables" || name === "compendia"}<rect
      x="4"
      y="4"
      width="16"
      height="16"
      rx="2"
    /><path d="M4 10h16M10 10v10" />
  {:else if name === "chat"}<path d="M4 5h16v12H9l-5 4V5Z" /><path
      d="M8 9h8m-8 4h5"
    />
  {:else if name === "combat"}<path
      d="m4 20 5-5m6-6 5-5M7 3l14 14-4 4L3 7l4-4Z"
    />
  {:else if name === "journals"}<path
      d="M5 3h12a2 2 0 0 1 2 2v15H7a2 2 0 0 1-2-2V3Zm0 14a2 2 0 0 1 2-2h12M8 7h7m-7 4h5"
    />
  {:else if name === "playlists"}<path d="M9 18V5l11-2v13M9 9l11-2" /><circle
      cx="6"
      cy="19"
      r="3"
    /><circle cx="17" cy="17" r="3" />
  {:else if name === "wifi"}<path
      d="M2 9a16 16 0 0 1 20 0M5 13a11 11 0 0 1 14 0m-11 4a6 6 0 0 1 8 0"
    /><circle cx="12" cy="21" r=".8" fill="currentColor" />
  {:else if name === "chevronLeft"}<path d="m15 5-7 7 7 7" />
  {:else if name === "chevronRight"}<path d="m9 5 7 7-7 7" />
  {:else if name === "x"}<path d="M5 5 19 19M19 5 5 19" />
  {:else}<circle cx="12" cy="12" r="8" /><circle cx="12" cy="12" r="2" />{/if}
</svg>
