/**
 * src/core barrel (§18). Contracts + shared primitives; the lowest layer —
 * every other layer may import from here, core imports from nowhere above (§3).
 */
export * from "./ids";
export * from "./documents";
export * from "./ops";
export * from "./ownership";
export * from "./projection";
export * from "./strategic";
export * from "./sim";
export * from "./net";
export * from "./rules";
export * from "./events";
export * from "./messages";
export * from "./result";
export * from "./diff";
export * from "./permissions";
export * from "./store";
export * from "./oplog";
export * from "./ratelimit";
export * from "./undo";
