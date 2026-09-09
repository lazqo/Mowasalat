/**
 * Reading and writing country packs.
 *
 * Two rules the repository enforces, both from docs/PLAN.md §5.4 ("ops owns the
 * network so it stays clean"):
 *
 *  - A route that fails validation is never written. There is no force flag.
 *  - Writes are atomic. A half-written route file would be shipped to phones as
 *    a broken line, so the file is replaced by rename, never edited in place.
 */
import { readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { validateRoute, type Problem } from "../../../packages/corridor/src/validate.ts";
import type { Route } from "../../../packages/corridor/src/types.ts";

export type CountryConfig = {
  code: string;
  nameAr: string;
  locale: string;
  remaining_bucket_m: number;
  k_anonymity_min: number;
  default_corridor_width_m: number;
  vouching_authorities: string[];
  tier2_thresholds: { trips: number; distinct_days: number };
  [key: string]: unknown;
};

export class InvalidRoute extends Error {
  problems: Problem[];
  constructor(problems: Problem[]) {
    super(`route is invalid: ${problems.map((p) => `${p.field} ${p.message}`).join("; ")}`);
    this.name = "InvalidRoute";
    this.problems = problems;
  }
}

export class Pack {
  readonly dir: string;
  readonly config: CountryConfig;
  private routeDir: string;

  constructor(dir: string) {
    this.dir = dir;
    this.routeDir = join(dir, "routes");
    this.config = JSON.parse(readFileSync(join(dir, "config.json"), "utf8"));
  }

  private fileFor(routeId: string): string {
    // Route ids are "jo-irbid-malka"; files drop the country prefix.
    const slug = routeId.replace(/^[a-z]{2}-/, "");
    if (!/^[a-z0-9-]+$/.test(slug)) throw new Error(`unsafe route id: ${routeId}`);
    return join(this.routeDir, `${slug}.json`);
  }

  listRoutes(): Route[] {
    return readdirSync(this.routeDir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => JSON.parse(readFileSync(join(this.routeDir, f), "utf8")) as Route)
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  getRoute(routeId: string): Route | null {
    try {
      return JSON.parse(readFileSync(this.fileFor(routeId), "utf8")) as Route;
    } catch {
      return null;
    }
  }

  /** Validates, then replaces the file atomically. Throws rather than writing a broken route. */
  saveRoute(route: Route): Route {
    const problems = validateRoute(route);
    if (problems.length > 0) throw new InvalidRoute(problems);

    const target = this.fileFor(route.id);
    const temp = `${target}.tmp-${process.pid}`;
    writeFileSync(temp, JSON.stringify(route, null, 2) + "\n");
    renameSync(temp, target);
    return route;
  }

  /** Checks a route without writing it, so the editor can show problems as they are made. */
  check(route: Route): Problem[] {
    return validateRoute(route);
  }
}
