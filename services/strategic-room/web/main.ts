import { mount } from "svelte";
import HostedRoom from "../../../src/ui/strategicRoom/HostedRoom.svelte";

const target = document.querySelector("#app");
if (!target) throw new Error("Hosted room root missing.");
mount(HostedRoom, { target });
