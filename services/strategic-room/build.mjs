import { build } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("./", import.meta.url));
for (const [i, name] of ["worker", "main"].entries()) {
  await build({
    configFile: false,
    root,
    build: {
      ssr: `src/${name}.ts`,
      target: "node22",
      outDir: "dist/server",
      emptyOutDir: i === 0,
      rollupOptions: {
        external: name === "main" ? ["pg", "ws"] : [],
        output: { entryFileNames: `${name}.mjs`, codeSplitting: false },
      },
    },
    ssr: { noExternal: name === "worker" ? true : [/^(?!pg$|ws$)/] },
  });
}
await build({
  configFile: false,
  root: `${root}web`,
  base: "./",
  plugins: [svelte()],
  build: { target: "es2022", outDir: "../dist/web", emptyOutDir: true },
});
