<script lang="ts">
  import type { ClientSync, ClientEvents } from "../../client/sync";
  import type { EventBus } from "../../core/events";
  import type { ActorDocument } from "../../core/documents";
  import PF1eActorSheet from "./PF1eActorSheet.svelte";
  import { observePF1eSheetActor } from "./pf1eSheetWindow";

  let {
    client,
    bus,
    actorId,
  }: { client: ClientSync; bus: EventBus<ClientEvents>; actorId: string } = $props();
  let actor = $state<ActorDocument | null>(null);

  // Window payload/client changes replace the subscription as well as its content.
  $effect(() =>
    observePF1eSheetActor(client, bus, actorId, (value) => {
      // Fresh identity also invalidates ownership-derived UI on welcome/rejection events.
      actor = value ? { ...value } : null;
    }),
  );
</script>

{#if actor}
  {#key actor._id}
    <PF1eActorSheet doc={actor} {client} {bus} />
  {/key}
{:else}
  <p role="status">
    Actor unavailable. It may have been deleted or your access may have changed.
  </p>
{/if}
