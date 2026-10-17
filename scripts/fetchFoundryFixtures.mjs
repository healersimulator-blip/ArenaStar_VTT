#!/usr/bin/env node
/** Download pinned upstream source mirrors. Archives and provenance stay git-ignored. */
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { get } from "node:https";
import { rootCertificates } from "node:tls";
import { pipeline } from "node:stream/promises";

const root = fileURLToPath(new URL("../", import.meta.url));
const destination = resolve(
  process.env.VTT_FOUNDRY_FIXTURES ??
    join(root, "tools/content/vendor/foundry-fixtures"),
);
const manifest = JSON.parse(
  await readFile(join(root, "tools/content/foundry-fixtures.json"), "utf8"),
);
await mkdir(destination, { recursive: true });
// Keep TLS verification enabled and include OS trust (e.g. a sandbox's managed CA).
const trustedCertificates = [...rootCertificates];
try {
  trustedCertificates.push(
    await readFile("/etc/ssl/certs/ca-certificates.crt", "utf8"),
  );
} catch {
  /* Platforms without this file use Node's trust store. */
}
for (const source of manifest.sources) {
  const path = join(destination, `${source.id}.zip`);
  const partial = `${path}.partial`;
  const receipt = `${path}.source.json`;
  try {
    const previous = JSON.parse(await readFile(receipt, "utf8"));
    if (previous.commit === source.commit) {
      const hash = createHash("sha256");
      for await (const chunk of createReadStream(path)) hash.update(chunk);
      if (hash.digest("hex") === previous.sha256) {
        console.log(`Verified cached ${source.id} at ${source.commit}`);
        continue;
      }
    }
  } catch {
    /* Missing/corrupt receipt or archive: fetch it again. */
  }
  console.log(`Fetching ${source.id} from ${source.archive}`);
  try {
    await new Promise((resolve, reject) => {
      const request = get(
        source.archive,
        { ca: trustedCertificates },
        (response) => {
          if (response.statusCode !== 200) {
            response.resume();
            reject(new Error(`HTTP ${response.statusCode}`));
            return;
          }
          pipeline(response, createWriteStream(partial)).then(resolve, reject);
        },
      );
      request.setTimeout(600000, () =>
        request.destroy(new Error("Archive download timed out")),
      );
      request.on("error", reject);
    });
    const hash = createHash("sha256");
    let bytes = 0;
    for await (const chunk of createReadStream(partial)) {
      hash.update(chunk);
      bytes += chunk.length;
    }
    await rename(partial, path);
    await writeFile(
      receipt,
      JSON.stringify(
        { ...source, sha256: hash.digest("hex"), bytes },
        null,
        2,
      ) + "\n",
    );
    console.log(`Saved ${source.id}: ${bytes} bytes`);
  } catch (error) {
    await rm(partial, { force: true });
    throw new Error(`Could not fetch ${source.id}: ${error.message}`, {
      cause: error,
    });
  }
}
console.log(`Fixtures ready: ${destination}`);
console.log(
  `VTT_FOUNDRY_FIXTURES=${destination} node scripts/buildRealPf1WorldFiltered.mjs`,
);
console.log(
  `VTT_FOUNDRY_FIXTURES=${destination} node scripts/buildRealPf1FullWorld.mjs`,
);
