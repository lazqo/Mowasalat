/**
 * Aggregate counters (docs/PLAN.md §6.3).
 *
 * Three rules from the plan are enforced here rather than merely intended:
 *
 *  1. No counter may be keyed by any identifier of a person. Keys are built
 *     from a fixed set of dimensions, and a pseudonym or token is not one of
 *     them.
 *  2. Cells thinner than k are suppressed on read.
 *  3. Counters are append-only integers. There is no event list behind them,
 *     because that list would be the trail we declined to keep.
 */

export type CounterName =
  | "demand"
  | "unserved"
  | "coverage_gap"
  | "line_health"
  | "match_quality"
  | "corridor_fit";

/** The only dimensions a counter may be keyed by. A person is not among them. */
export type Dimensions = {
  routeId?: string;
  dir?: 0 | 1;
  zoneSeq?: number;
  destinationId?: string;
  area?: string;
  hourBucket: number;
  outcome?: "matched" | "expired" | "started" | "completed" | "off_corridor" | "empty";
};

const ALLOWED_KEYS = new Set([
  "routeId",
  "dir",
  "zoneSeq",
  "destinationId",
  "area",
  "hourBucket",
  "outcome",
]);

export class PersonalDimension extends Error {
  constructor(key: string) {
    super(`"${key}" is not an allowed counter dimension: counters must not be keyed by a person`);
    this.name = "PersonalDimension";
  }
}

export function hourBucket(atMs: number): number {
  return Math.floor(atMs / 3_600_000);
}

function cellKey(name: CounterName, dims: Dimensions): string {
  for (const key of Object.keys(dims)) {
    if (!ALLOWED_KEYS.has(key)) throw new PersonalDimension(key);
  }
  const parts = [...ALLOWED_KEYS]
    .filter((k) => (dims as Record<string, unknown>)[k] !== undefined)
    .sort()
    .map((k) => `${k}=${(dims as Record<string, unknown>)[k]}`);
  return `${name}|${parts.join("|")}`;
}

export class Counters {
  private cells = new Map<string, number>();

  increment(name: CounterName, dims: Dimensions, by = 1): void {
    const key = cellKey(name, dims);
    this.cells.set(key, (this.cells.get(key) ?? 0) + by);
  }

  /** Reads one cell, suppressing it if thinner than k. */
  read(name: CounterName, dims: Dimensions, k: number): number | null {
    const value = this.cells.get(cellKey(name, dims)) ?? 0;
    return value < k ? null : value;
  }

  /** Every cell at or above k. Thin cells are not merely hidden; they are not returned. */
  report(k: number): { cell: string; count: number }[] {
    return [...this.cells.entries()]
      .filter(([, count]) => count >= k)
      .map(([cell, count]) => ({ cell, count }))
      .sort((a, b) => b.count - a.count);
  }
}
