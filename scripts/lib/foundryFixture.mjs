/** Build-time only: load shared TS admission code and faithfully transcode YAML documents. */
import { createServer } from "vite";
import { parseDocument } from "yaml";

export async function foundryFixtureTools() {
  const server = await createServer({
    configFile: false,
    server: { middlewareMode: true },
    appType: "custom",
  });
  try {
    const manifest = await server.ssrLoadModule(
      "/src/core/foundryModuleManifest.ts",
    );
    const storage = await server.ssrLoadModule(
      "/src/packages/foundryPackStorage.ts",
    );
    const documents = await server.ssrLoadModule("/src/core/aisDocuments.ts");
    return { ...manifest, ...storage, ...documents };
  } finally {
    await server.close();
  }
}

export function transcodeYamlPacks(files) {
  const output = {};
  for (const [path, text] of Object.entries(files)) {
    if (!/(?:^|\/)packs\//.test(path) || !/\.ya?ml$/i.test(path)) {
      output[path] = text;
      continue;
    }
    const parsed = parseDocument(text);
    if (parsed.errors.length)
      throw new Error(
        `Invalid YAML pack source ${path}: ${parsed.errors[0].message}`,
      );
    const value = parsed.toJS({ maxAliasCount: 100 });
    if (!value || typeof value !== "object" || typeof value._id !== "string")
      throw new Error(`YAML pack source ${path} has no document _id`);
    const target = path.replace(/\.ya?ml$/i, ".json");
    if (files[target] !== undefined)
      throw new Error(`YAML conversion would overwrite ${target}`);
    output[target] = JSON.stringify(value);
  }
  return output;
}
