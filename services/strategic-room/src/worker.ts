import { parentPort, workerData } from "node:worker_threads";
import { resolveFrozen } from "./resolve";
import type { Frozen } from "./state";

if (!parentPort) throw new Error("Run the resolver in a worker thread.");
const result = resolveFrozen(workerData as Frozen);
parentPort.postMessage(result, [result.state.bytes.buffer as ArrayBuffer]);
