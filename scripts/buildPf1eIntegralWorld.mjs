#!/usr/bin/env node
/** The unified starter and its integral scene use the genuine pinned upstream stack. */
import { buildRealPf1FullWorld } from "./buildRealPf1FullWorld.mjs";
await buildRealPf1FullWorld({ integral: true });
