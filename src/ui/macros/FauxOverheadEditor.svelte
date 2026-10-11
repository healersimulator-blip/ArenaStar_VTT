<script lang="ts">
  import type { ClientSync } from "../../client/sync";
  import type {
    FauxOverheadBehavior,
    Json,
    RegionDocument,
  } from "../../core/documents";
  import { regionGeometryError } from "../../core/regionGeometry";
  let {
    client,
    sceneId,
    region,
  }: { client: ClientSync; sceneId: string; region: RegionDocument } = $props();
  let enabled = $state(false);
  let coverZ = $state(10);
  let bottom = $state("0");
  let top = $state("10");
  let footprint = $state("");
  let status = $state("");
  $effect(() => {
    const cover = region.fauxOverhead;
    enabled = !!cover;
    coverZ = cover?.coverZ ?? 10;
    bottom = cover ? String(cover.affectedElevation.bottom ?? "") : "0";
    top = cover ? String(cover.affectedElevation.top ?? "") : "10";
    footprint = cover?.footprint
      ? JSON.stringify(cover.footprint, null, 2)
      : "";
    status = "";
  });
  function addOpening(): void {
    footprint = JSON.stringify(
      {
        version: 2,
        components: [
          {
            outer: region.shape.points.map(([x, y]) => ({ x, y })),
            holes: [
              [
                { x: 0.4, y: 0.4 },
                { x: 0.6, y: 0.4 },
                { x: 0.6, y: 0.6 },
                { x: 0.4, y: 0.6 },
              ],
            ],
          },
        ],
      },
      null,
      2,
    );
  }
  function save(): void {
    if (client.user?.role !== "GM" && client.user?.role !== "ASSISTANT") return;
    const ref = {
      coll: "regions" as const,
      id: region._id,
      parent: { coll: "scenes" as const, id: sceneId },
    };
    if (!enabled) {
      if (region.fauxOverhead)
        client.submit([
          { kind: "update", ref, diff: { "-=fauxOverhead": null } },
        ]);
      status = "Cover removal submitted.";
      return;
    }
    try {
      const cover: FauxOverheadBehavior = {
        kind: "fauxOverhead",
        coverZ,
        affectedElevation: {
          bottom: bottom.trim() === "" ? null : Number(bottom),
          top: top.trim() === "" ? null : Number(top),
        },
        ...(footprint.trim() ? { footprint: JSON.parse(footprint) } : {}),
      };
      // Enabling is an explicit public-geometry edit; concealed automation regions must not
      // silently give the GM a mask that players never receive.
      const candidate = {
        ...region,
        hidden: false,
        ownership: { default: 1 as const },
        fauxOverhead: cover,
      };
      const error = regionGeometryError(candidate);
      if (error) {
        status = error;
        return;
      }
      client.submit([
        {
          kind: "update",
          ref,
          diff: {
            fauxOverhead: cover as unknown as Json,
            hidden: false,
            ownership: { default: 1 },
          },
        },
      ]);
      status = "Cover edit submitted as one undoable change.";
    } catch {
      status =
        "Footprint must be valid JSON with normalized points, components and holes.";
    }
  }
</script>

<details data-faux-overhead-editor>
  <summary>Faux Overhead · native region cover</summary>
  <p>
    Conceal tokens beneath artwork painted into the map, without creating a tile
    or revealing surrounding pixels.
  </p>
  <label
    ><input type="checkbox" bind:checked={enabled} /> Enable solid cover</label
  >
  {#if enabled}
    <div class="fields">
      <label
        >Cover height <input
          type="number"
          min="-1000000"
          max="1000000"
          bind:value={coverZ}
        /></label
      >
      <label
        >Affected feet: from (inclusive) <input
          type="text"
          inputmode="decimal"
          bind:value={bottom}
          placeholder="Unbounded"
        /></label
      >
      <label
        >Affected feet: to (exclusive) <input
          type="text"
          inputmode="decimal"
          bind:value={top}
          placeholder="Unbounded"
        /></label
      >
    </div>
    <p class="notice">
      Applying publishes this region document, including its name and metadata, to all players. Heights
      use scene units. Blank range bounds mean unbounded. Tokens at or above the
      cover are not clipped.
    </p>
    <details>
      <summary>Concave footprint and openings (advanced)</summary>
      <p>
        Blank uses the region outline. V2 components are a union; each component
        has its own holes. Coordinates range from 0 to 1 in this region's
        rotated frame. Maximum 512 vertices.
      </p>
      <button type="button" onclick={addOpening}>Draft central opening</button>
      <button type="button" onclick={() => (footprint = "")}
        >Use region outline</button
      >
      <label
        >Footprint JSON <textarea
          rows="10"
          maxlength="65536"
          bind:value={footprint}
          spellcheck="false"></textarea></label
      >
    </details>
  {/if}
  <button type="button" data-faux-apply onclick={save}>Apply cover</button>
  <p class="hint">
    Presentation only: no floor physics, light barrier, fog exploration or new
    LOS. Labels, badges and HP bars are suppressed near cover; covered pixels
    cannot be picked. Ghosts and level navigation are not enabled in this first
    slice.
  </p>
  {#if status}<p role="status">{status}</p>{/if}
</details>

<style>
  details {
    padding: 0.65rem;
    border: 1px solid var(--border, #444);
    border-radius: 6px;
    margin: 0.5rem 0;
  }
  summary {
    cursor: pointer;
    font-weight: 600;
  }
  p {
    font-size: 0.85rem;
    line-height: 1.4;
  }
  .fields {
    display: flex;
    flex-wrap: wrap;
    gap: 0.6rem;
  }
  label {
    display: flex;
    gap: 0.35rem;
    margin: 0.4rem 0;
    align-items: center;
  }
  .fields label {
    flex-direction: column;
    align-items: flex-start;
  }
  input[type="number"] {
    width: 10rem;
  }
  textarea {
    display: block;
    width: 100%;
    font-family: monospace;
  }
  .notice {
    color: var(--warning, #e1bd77);
  }
  .hint {
    opacity: 0.8;
  }
  button {
    margin: 0.4rem 0.4rem 0.4rem 0;
  }
</style>
