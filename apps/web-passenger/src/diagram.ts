/**
 * The line, drawn.
 *
 * Deliberately not a slippy map. A tiled basemap would mean the page asking a
 * third party for the tiles around wherever she is standing — which is exactly
 * the location disclosure the whole design exists to avoid, handed to a company
 * that never agreed to any of it. It would also be the heaviest thing on the
 * page, on the cheapest phones, over the worst connection.
 *
 * So the line is drawn as itself: the villages in order, where she is standing,
 * and where the bus is. That is the entire question she has, and it renders as
 * a few hundred bytes of SVG that works with no network at all.
 */

import { humaniseDistance } from "./strings.ts";

export type DiagramZone = { nameAr: string; remainingM: number };
export type DiagramBus = { pseudonym: string; remainingM: number; stopped: boolean };

export type Diagram = {
  zones: DiagramZone[];
  /** Where she is, in remaining distance to this direction's endpoint. */
  youRemainingM: number;
  buses: DiagramBus[];
};

const W = 320;
const SPINE_X = 214;
const LABEL_GAP = 14;
const TOP = 24;
const BOTTOM = 24;

/**
 * Renders to an SVG string.
 *
 * Vertical, with the far end at the top and the destination at the bottom, so
 * a bus moves *down* the page towards her as it approaches.
 *
 * The SVG sets `direction="rtl"` explicitly rather than inheriting it, and the
 * anchors read inverted on purpose: in a right-to-left run `start` is the
 * right-hand edge of the text and `end` the left-hand one. Getting this wrong
 * does not fail loudly — the labels simply render backwards across the line
 * they are labelling, and "4.0 كم" comes out as "كم 4.0". Village names sit to
 * the left of the line and live markers to the right, so a name and a distance
 * never land on top of each other.
 */
export function renderDiagram(d: Diagram): string {
  const rows = Math.max(d.zones.length, 2);
  const height = Math.max(200, TOP + BOTTOM + rows * 64);
  const usable = height - TOP - BOTTOM;

  // The span drawn is the line itself, widened if a bus sits behind its start.
  const all = [d.youRemainingM, ...d.zones.map((z) => z.remainingM), ...d.buses.map((b) => b.remainingM)];
  const maxRemaining = Math.max(...all, 1);

  const y = (remainingM: number) => TOP + usable * (1 - remainingM / maxRemaining);

  const parts: string[] = [];
  parts.push(
    `<svg viewBox="0 0 ${W} ${height}" width="100%" height="${height}" direction="rtl" role="img" aria-hidden="true" xmlns="http://www.w3.org/2000/svg">`,
  );

  parts.push(`<line x1="${SPINE_X}" y1="${TOP}" x2="${SPINE_X}" y2="${height - BOTTOM}" class="spine"/>`);

  // The villages, named to the left of the line.
  for (const zone of d.zones) {
    const zy = round(y(zone.remainingM));
    parts.push(`<circle cx="${SPINE_X}" cy="${zy}" r="5" class="zone"/>`);
    parts.push(
      `<text x="${SPINE_X - LABEL_GAP}" y="${zy}" class="zone-label" text-anchor="start" dominant-baseline="middle">${esc(zone.nameAr)}</text>`,
    );
  }

  // Her, on the line. Drawn after the villages so a village never covers her.
  const yy = round(y(d.youRemainingM));
  parts.push(`<circle cx="${SPINE_X}" cy="${yy}" r="9" class="you"/>`);
  parts.push(
    `<text x="${SPINE_X + LABEL_GAP}" y="${yy}" class="you-label" text-anchor="end" dominant-baseline="middle">إنت</text>`,
  );

  // The buses, above her, coming down. Labelled with how far they still have
  // to come — the number she is actually waiting on.
  for (const bus of d.buses) {
    const by = y(bus.remainingM);
    parts.push(
      `<rect x="${SPINE_X - 9}" y="${round(by - 9)}" width="18" height="18" rx="4" class="bus${bus.stopped ? " stopped" : ""}"/>`,
    );
    parts.push(
      `<text x="${SPINE_X + LABEL_GAP}" y="${round(by)}" class="bus-label" text-anchor="end" dominant-baseline="middle">${esc(
        humaniseDistance(Math.max(0, bus.remainingM - d.youRemainingM)),
      )}</text>`,
    );
  }

  parts.push("</svg>");
  return parts.join("");
}

function round(n: number): string {
  return n.toFixed(1);
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}
