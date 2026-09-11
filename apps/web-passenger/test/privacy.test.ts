import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The promises this page makes, checked against the page that actually ships.
 *
 * A browser is a leakier place than a native app: a stylesheet, a font, an
 * analytics snippet or a map tile is one line of HTML, and any of them would
 * tell a third party roughly where the person holding the phone is standing.
 * So these read the built output, not the intentions.
 */

const app = join(import.meta.dirname, "..");

/**
 * Builds exactly what would be deployed, into a directory this test owns —
 * not into dist/, which someone may be serving locally while the suite runs.
 */
function buildInto(apiBase?: string): string {
  const out = mkdtempSync(join(tmpdir(), "mowasalat-web-"));
  built.push(out);
  execFileSync(process.execPath, [join(app, "build.mjs")], {
    cwd: app,
    env: { ...process.env, API_BASE: apiBase ?? "", OUT_DIR: out },
    stdio: "pipe",
  });
  return out;
}

const built: string[] = [];
after(() => {
  for (const dir of built) rmSync(dir, { recursive: true, force: true });
});

const COORDINATE_KEY = /(^|_|")(lat|latitude|lng|lon|longitude|coords?|position|location)("|_|$)/i;

test("no request body names a coordinate", () => {
  // The bodies are written out field by field in api.ts precisely so this can
  // be read off the source. A spread of an object that happened to carry a
  // coordinate would defeat the check, which is why there is no spread.
  const source = readFileSync(join(app, "src/api.ts"), "utf8");
  const bodies = [...source.matchAll(/this\.post\([^)]*?\{([\s\S]*?)\}\s*\)/g)].map((m) => m[1]);

  assert.ok(bodies.length >= 4, "expected the passenger's POST bodies to be found");
  for (const body of bodies) {
    for (const line of body.split("\n")) {
      const key = line.split(":")[0].trim();
      if (!key) continue;
      assert.ok(!COORDINATE_KEY.test(key), `a request body must never carry ${key}`);
    }
  }
});

test("the page asks nobody but its own API for anything", () => {
  const dist = buildInto("https://api.example.test");

  for (const file of readdirSync(dist)) {
    if (file.endsWith(".map")) continue; // not served to anyone, not parsed by a browser
    const text = readFileSync(join(dist, file), "utf8");

    for (const [url] of text.matchAll(/https?:\/\/[^\s"'`)]+/g)) {
      const allowed =
        url.startsWith("https://api.example.test") ||
        // The SVG namespace is an identifier in the markup, not a fetch.
        url.startsWith("http://www.w3.org/2000/svg");
      assert.ok(allowed, `${file} would reach out to ${url}`);
    }
  }
});

test("the content security policy allows the API and nothing else", () => {
  const dist = buildInto("https://api.example.test");
  const html = readFileSync(join(dist, "index.html"), "utf8");

  const csp = html.match(/Content-Security-Policy"\s*\n?\s*content="([^"]+)"/)?.[1];
  assert.ok(csp, "the page must carry a policy");

  assert.match(csp, /connect-src 'self' https:\/\/api\.example\.test/);
  assert.match(csp, /script-src 'self'/);
  assert.match(csp, /style-src 'self'/);
  assert.doesNotMatch(csp, /connect-src[^;]*\*/, "a wildcard would allow any endpoint at all");
  assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval/);
});

test("with no API configured the page can still only talk to itself", () => {
  const dist = buildInto();
  const html = readFileSync(join(dist, "index.html"), "utf8");
  assert.match(html, /connect-src 'self';/);
  assert.doesNotMatch(html, /__API_BASE__|__CONNECT_SRC__/, "placeholders must be substituted");
});

test("nothing about her is kept, only the public network", () => {
  // localStorage is used, so what goes into it is worth pinning down: the
  // lines and the villages, which are public infrastructure. Her position,
  // her destination and her pseudonym must not outlive the page.
  const source = readFileSync(join(app, "src/main.ts"), "utf8");
  const stored = [...source.matchAll(/localStorage\.setItem\(([^,]+),\s*JSON\.stringify\(([^)]+)\)/g)];

  assert.equal(stored.length, 1, "exactly one thing is cached");
  assert.match(stored[0][1], /CACHE_KEY/);
  assert.match(stored[0][2], /value/, "the network snapshot, and nothing assembled from a position");

  assert.doesNotMatch(source, /setItem\([^)]*(pseudonym|position|ride|destination)/i);
});
