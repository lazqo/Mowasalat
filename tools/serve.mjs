/**
 * A static file server for trying the built page on a phone.
 *
 * Not a deployment tool. It exists so `npm run dev` in apps/web-passenger
 * prints an address a phone on the same wifi can open, without installing
 * anything.
 */

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";
import { networkInterfaces } from "node:os";

const dir = resolve(process.argv[2] ?? "dist");
const port = Number(process.env.PORT ?? 5173);

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
};

createServer(async (req, res) => {
  const path = new URL(req.url ?? "/", "http://localhost").pathname;
  // normalize collapses any ".." before it is joined, so a request cannot
  // reach outside the directory being served.
  const file = join(dir, normalize(path) === "/" ? "index.html" : normalize(path));
  if (!file.startsWith(dir)) {
    res.writeHead(403).end("forbidden");
    return;
  }

  try {
    const body = await readFile(file);
    res.writeHead(200, {
      "content-type": TYPES[extname(file)] ?? "application/octet-stream",
      "cache-control": "no-store",
    });
    res.end(body);
  } catch {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("not found");
  }
}).listen(port, () => {
  const lan = Object.values(networkInterfaces())
    .flat()
    .find((i) => i && i.family === "IPv4" && !i.internal)?.address;

  console.log(`serving ${dir}`);
  console.log(`  This machine   http://localhost:${port}`);
  if (lan) console.log(`  From a phone   http://${lan}:${port}`);
  console.log("");
  console.log("  Note: browsers only give a page your location over https or");
  console.log("  on localhost. For a phone test, use a tunnel or a real deploy.");
});
