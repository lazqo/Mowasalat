/**
 * Builds the passenger page into `dist/`, which is what gets deployed.
 *
 * esbuild is the one build dependency. It is here because browsers do not
 * strip TypeScript types the way Node does, and because the corridor package
 * is shared source rather than a published module — the alternative is
 * maintaining a second copy of the geometry, which is how two clients start
 * disagreeing about where a bus is.
 *
 *   API_BASE=https://api.example node build.mjs
 *
 * API_BASE is baked into the page's meta tag and into the Content-Security-
 * Policy, so a built page can talk to that API and to nothing else.
 */

import { build } from "esbuild";
import { cp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, "dist");

const apiBase = (process.env.API_BASE ?? "").replace(/\/$/, "");

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

await build({
  entryPoints: [join(here, "src/main.ts")],
  bundle: true,
  format: "esm",
  target: ["es2022"],
  minify: true,
  sourcemap: true,
  outfile: join(dist, "app.js"),
  // Loud rather than silently shipping a page that cannot reach anything.
  logLevel: "info",
});

const html = (await readFile(join(here, "index.html"), "utf8"))
  .replace("__API_BASE__", apiBase)
  // Same origin always; the API too when it is somewhere else. Nothing more:
  // no font host, no tile server, no telemetry endpoint can be added later
  // without this line changing, which is the point of writing it down.
  .replace("__CONNECT_SRC__", apiBase ? `'self' ${apiBase}` : "'self'");

await writeFile(join(dist, "index.html"), html);
await cp(join(here, "styles.css"), join(dist, "styles.css"));

console.log(`built → ${dist}${apiBase ? ` (api ${apiBase})` : " (api: same origin)"}`);
