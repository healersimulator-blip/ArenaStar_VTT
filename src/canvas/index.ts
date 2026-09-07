/**
 * src/canvas barrel (§18): stage bootstrap, camera/grid/token math,
 * §9A layers (ModelLayer) and spatial hash.
 * Pure modules (camera, grid, tokens, layers/ModelLayer/lod, spatial) are
 * environment-free; stage.ts + ModelLayer pull PixiJS v8 and only run where
 * DOM/WebGL exist (browser/e2e).
 */
export * from "./camera";
export * from "./grid";
export * from "./tokens";
export * from "./spatial";
export * from "./vision";
export * from "./stage";
export * from "./layers";
