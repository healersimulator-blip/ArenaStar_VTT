<script lang="ts">
  let {
    announcement,
    resolveAsset,
    onDismiss,
  }: {
    announcement: { assetId: string; name: string; senderName: string };
    resolveAsset: (assetId: string) => string | null;
    onDismiss: () => void;
  } = $props();

  const imageUrl = $derived.by(() =>
    /^[a-f0-9]{64}$/i.test(announcement.assetId) ? resolveAsset(announcement.assetId) : null,
  );
</script>

<dialog open class="shared-image" aria-modal="true" aria-labelledby="shared-image-title" data-shared-image>
  <header>
    <div>
      <p class="eyebrow">IMAGE SHARED WITH THE TABLE</p>
      <h2 id="shared-image-title">{announcement.name || "Shared image"}</h2>
      <p class="sender">From {announcement.senderName}</p>
    </div>
    <button type="button" class="close" aria-label="Close shared image" onclick={onDismiss}>×</button>
  </header>
  <div class="frame">
    {#if imageUrl}
      <img src={imageUrl} alt={announcement.name || "Shared image"} />
    {:else}
      <p role="status">Loading shared image…</p>
    {/if}
  </div>
  <footer><button type="button" onclick={onDismiss}>Close</button></footer>
</dialog>

<style>
  .shared-image {
    position: fixed;
    inset: 0;
    z-index: 5100;
    display: flex;
    flex-direction: column;
    gap: 12px;
    width: min(92vw, 900px);
    max-width: 92vw;
    max-height: 92vh;
    margin: auto;
    padding: 14px;
    color: #e5ebf2;
    background: #171c23;
    border: 1px solid #526071;
    border-radius: 10px;
    box-shadow: 0 18px 70px #000c;
  }
  header { display:flex; align-items:flex-start; justify-content:space-between; gap:12px; }
  h2 { margin:0; font-size:16px; overflow-wrap:anywhere; }
  .eyebrow { margin:0 0 4px; color:#91a1b4; font-size:9px; letter-spacing:.12em; }
  .sender { margin:4px 0 0; color:#9caabb; font-size:11px; }
  .close { width:32px; height:32px; border:1px solid #46515e; border-radius:5px; background:#222932; color:#e5ebf2; font-size:20px; cursor:pointer; }
  .frame { display:grid; place-items:center; min-height:120px; overflow:auto; background:#0c1015; border:1px solid #303944; border-radius:6px; }
  .frame img { display:block; max-width:100%; max-height:calc(82vh - 120px); object-fit:contain; }
  .frame p { padding:20px; color:#9caabb; }
  footer { display:flex; justify-content:flex-end; }
  footer button { padding:6px 12px; border:1px solid #46515e; border-radius:5px; background:#222932; color:#e5ebf2; cursor:pointer; }
</style>
