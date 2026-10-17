// Graph layout, semantic zoom and viewport culling. Pure and deterministic:
// layout runs when the structure changes, never per frame.

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}
export type NodeMode = "orch" | "mgr" | "app" | "agent" | "chip" | "ghost";
export interface PlacedRect extends Rect {
  mode: NodeMode;
}
export interface LayoutEdge {
  from: string;
  to: string;
  kind: "mgr" | "app" | "direct" | "v" | "frame" | "gate";
}
export interface Cluster extends Rect {
  id: string;
  label: string;
  hue?: string | null;
  dashed?: boolean;
}
export interface Layout {
  rects: Record<string, PlacedRect>;
  /** non-node targets edges can point at (squad frames, expanded app frames) */
  frames: Record<string, Rect>;
  edges: LayoutEdge[];
  clusters: Cluster[];
  labels: Array<{ x: number; y: number; text: string }>;
  deco: Array<{ x: number; y1: number; y2: number; text: string }>;
  bounds: { w: number; h: number };
}

export const D = {
  orch: { w: 216, h: 110 },
  mgr: { w: 224, h: 106 },
  app: { w: 206, h: 82 },
  gx: 64,
  gy: 12,
  cgap: 30,
  cols: 2,
  W1: 232,
  nw: 224,
  nh: 92,
  ng: 10,
  pad: 14,
  head: 22,
  mini: { w: 196, h: 92 },
};

export interface PortfolioInput {
  orchId: string;
  managers: Array<{ id: string; name: string; appIds: string[]; hue?: string | null }>;
  /** apps reporting straight to the Orchestrator (C1/C2, or unassigned in C3) */
  directAppIds: string[];
  appNames: Record<string, string>;
  /** managers whose apps are hidden */
  collapsed: ReadonlySet<string>;
  /** apps expanded in place to show their members */
  expanded: ReadonlySet<string>;
  /** member node ids per app (lead first) */
  members: Record<string, string[]>;
  /** Observatory ghost ids */
  ghosts?: string[];
  ghostLabel?: string;
}

const plural = (n: number, a: string) => `${n} ${n === 1 ? a : `${a}s`}`;

/** Lay out apps in a two-column grid; an expanded app takes a full row as a frame of mini cards. */
function appGrid(
  appIds: string[],
  input: PortfolioInput,
  x0: number,
): { h: number; w: number; place: (top: number, out: Layout, parent: string, hue?: string | null) => void } {
  const cellW = D.app.w + 10;
  const fullW = D.cols * cellW - 10;
  type Row = { kind: "cards"; ids: string[] } | { kind: "frame"; id: string; rows: number };
  const rows: Row[] = [];
  let cur: string[] = [];
  for (const id of appIds) {
    if (input.expanded.has(id)) {
      if (cur.length) rows.push({ kind: "cards", ids: cur });
      cur = [];
      rows.push({ kind: "frame", id, rows: Math.max(1, Math.ceil((input.members[id]?.length ?? 0) / 2)) });
    } else {
      cur.push(id);
      if (cur.length === D.cols) {
        rows.push({ kind: "cards", ids: cur });
        cur = [];
      }
    }
  }
  if (cur.length) rows.push({ kind: "cards", ids: cur });
  const frameH = (r: number) => D.head + D.pad * 2 + r * D.mini.h + (r - 1) * D.ng;
  const rowH = (r: Row) => (r.kind === "cards" ? D.app.h : frameH(r.rows));
  const h = rows.reduce((a, r) => a + rowH(r), 0) + Math.max(0, rows.length - 1) * D.gy;
  const anyFrame = rows.some((r) => r.kind === "frame");
  const maxCards = rows.reduce((m, r) => (r.kind === "cards" ? Math.max(m, r.ids.length) : m), 0);
  const w = appIds.length ? (anyFrame ? fullW : maxCards * cellW - 10) : 0;
  const place = (top: number, out: Layout, parent: string, hue?: string | null) => {
    let y = top;
    for (const r of rows) {
      if (r.kind === "cards") {
        r.ids.forEach((id, i) => {
          out.rects[id] = { x: x0 + i * cellW, y, w: D.app.w, h: D.app.h, mode: "app" };
          out.edges.push({ from: parent, to: id, kind: parent === input.orchId ? "direct" : "app" });
        });
      } else {
        const fid = `frame:${r.id}`;
        const fh = frameH(r.rows);
        out.frames[fid] = { x: x0, y, w: fullW, h: fh };
        out.clusters.push({ id: fid, x: x0, y, w: fullW, h: fh, label: `${input.appNames[r.id] ?? r.id} · ${plural(input.members[r.id]?.length ?? 0, "agent")}`, hue });
        out.edges.push({ from: parent, to: fid, kind: parent === input.orchId ? "direct" : "app" });
        const innerW = (fullW - D.pad * 2 - D.ng) / 2;
        (input.members[r.id] ?? []).forEach((nid, i) => {
          out.rects[nid] = { x: x0 + D.pad + (i % 2) * (innerW + D.ng), y: y + D.head + D.pad + Math.floor(i / 2) * (D.mini.h + D.ng), w: innerW, h: D.mini.h, mode: "agent" };
        });
      }
      y += rowH(r) + D.gy;
    }
  };
  return { h, w, place };
}

export function portfolioLayout(input: PortfolioInput): Layout {
  const out: Layout = { rects: {}, frames: {}, edges: [], clusters: [], labels: [], deco: [], bounds: { w: 0, h: 0 } };
  const xMgr = D.orch.w + D.gx;
  const xApp = xMgr + D.mgr.w + D.gx;
  type Block = { kind: "mgr"; m: PortfolioInput["managers"][number]; grid: ReturnType<typeof appGrid>; h: number } | { kind: "direct"; grid: ReturnType<typeof appGrid>; h: number };
  const blocks: Block[] = input.managers.map((m) => {
    const grid = appGrid(input.collapsed.has(m.id) ? [] : m.appIds, input, xApp);
    return { kind: "mgr", m, grid, h: Math.max(D.mgr.h, grid.h) + 28 };
  });
  if (input.directAppIds.length) {
    const grid = appGrid(input.directAppIds, input, xMgr);
    blocks.push({ kind: "direct", grid, h: grid.h + 28 });
  }
  const total = blocks.reduce((a, b) => a + b.h, 0) + D.cgap * Math.max(0, blocks.length - 1);
  let y = 0;
  let maxR = xMgr + D.mgr.w;
  for (const b of blocks) {
    const cy = y + b.h / 2;
    if (b.kind === "mgr") {
      out.rects[b.m.id] = { x: xMgr, y: cy - D.mgr.h / 2, w: D.mgr.w, h: D.mgr.h, mode: "mgr" };
      b.grid.place(cy - b.grid.h / 2, out, b.m.id, b.m.hue);
      const right = b.grid.w ? xApp + b.grid.w + 14 : xMgr + D.mgr.w + 14;
      maxR = Math.max(maxR, right);
      out.clusters.push({ id: `cl-${b.m.id}`, x: xMgr - 14, y, w: right - (xMgr - 14), h: b.h, label: `${b.m.name} · ${plural(b.m.appIds.length, "app")}`, hue: b.m.hue });
      out.edges.push({ from: input.orchId, to: b.m.id, kind: "mgr" });
    } else {
      b.grid.place(cy - b.grid.h / 2, out, input.orchId);
      const right = xMgr + b.grid.w + 14;
      maxR = Math.max(maxR, right);
      if (input.managers.length) out.clusters.push({ id: "cl-direct", x: xMgr - 14, y, w: right - (xMgr - 14), h: b.h, label: `Reports to the Orchestrator · ${plural(input.directAppIds.length, "app")}`, dashed: true });
    }
    y += b.h + D.cgap;
  }
  const height = Math.max(total, D.orch.h);
  out.rects[input.orchId] = { x: 0, y: height / 2 - D.orch.h / 2, w: D.orch.w, h: D.orch.h, mode: "orch" };
  let h = height;
  const ghosts = input.ghosts ?? [];
  if (ghosts.length) {
    const oy = height + 54;
    out.labels.push({ x: xMgr - 14, y: oy - 24, text: input.ghostLabel ?? `Outside this run · ${plural(ghosts.length, "thread")} · read-only` });
    ghosts.forEach((id, i) => {
      out.rects[id] = { x: xMgr - 14 + (i % 3) * (D.app.w + 12), y: oy + Math.floor(i / 3) * 96, w: D.app.w, h: 84, mode: "ghost" };
    });
    h = oy + Math.ceil(ghosts.length / 3) * 96;
    maxR = Math.max(maxR, xMgr - 14 + Math.min(3, ghosts.length) * (D.app.w + 12));
  }
  out.bounds = { w: maxR + 4, h };
  return out;
}

export interface SquadInput {
  /** chain above the lead, top first (e.g. ["orch", "m0"]) — empty when the Orchestrator leads */
  chain: string[];
  leadId: string;
  specialists: string[];
  gates: string[];
  hue?: string | null;
}

export function squadLayout(a: SquadInput): Layout {
  const out: Layout = { rects: {}, frames: {}, edges: [], clusters: [], labels: [], deco: [], bounds: { w: 0, h: 0 } };
  const { W1, nw, nh, ng, pad, head } = D;
  const rows = Math.max(1, Math.ceil(a.specialists.length / 2));
  const sfW = nw * 2 + ng + pad * 2;
  const sfH = head + rows * nh + (rows - 1) * ng + pad * 2;
  const gRows = Math.max(1, Math.ceil(a.gates.length / 2));
  const gfH = head + gRows * nh + (gRows - 1) * ng + pad * 2;
  const gap = 44;
  const x2 = W1 + 64;
  const totalH = sfH + gap + gfH;
  const gfY = sfH + gap;
  out.clusters.push({ id: "sf", x: x2, y: 0, w: sfW, h: sfH, label: `Specialists · ${a.specialists.length}`, hue: a.hue });
  out.frames.sf = { x: x2, y: 0, w: sfW, h: sfH };
  a.specialists.forEach((id, i) => {
    out.rects[id] = { x: x2 + pad + (i % 2) * (nw + ng), y: head + pad + Math.floor(i / 2) * (nh + ng), w: nw, h: nh, mode: "agent" };
  });
  out.clusters.push({ id: "gf", x: x2, y: gfY, w: sfW, h: gfH, label: "Quality gates · spawned on demand", dashed: true });
  out.frames.gf = { x: x2, y: gfY, w: sfW, h: gfH };
  a.gates.forEach((id, i) => {
    out.rects[id] = { x: x2 + pad + (i % 2) * (nw + ng), y: gfY + head + pad + Math.floor(i / 2) * (nh + ng), w: nw, h: nh, mode: "agent" };
  });
  const leadH = 136;
  const chipH = 46;
  const vg = 28;
  const leadY = Math.max(a.chain.length * (chipH + vg), totalH / 2 - leadH / 2);
  out.rects[a.leadId] = { x: 0, y: leadY, w: W1, h: leadH, mode: "agent" };
  let prev = a.leadId;
  [...a.chain].reverse().forEach((id, i) => {
    out.rects[id] = { x: 0, y: leadY - (i + 1) * (vg + chipH), w: W1, h: chipH, mode: "chip" };
    out.edges.push({ from: id, to: prev, kind: "v" });
    prev = id;
  });
  out.edges.push({ from: a.leadId, to: "sf", kind: "frame" }, { from: a.leadId, to: "gf", kind: "gate" });
  out.deco.push({ x: x2 + sfW / 2, y1: sfH + 6, y2: gfY - 6, text: "integrate → review → slop check" });
  out.bounds = { w: x2 + sfW, h: Math.max(totalH, leadY + leadH) };
  return out;
}

// ───────────── geometry, zoom, culling ─────────────

export const rectOf = (L: Layout, id: string): Rect | undefined => L.rects[id] ?? L.frames[id];

export function pathD(a: Rect, b: Rect, kind: "v" | "h"): string {
  if (kind === "v") {
    const x1 = a.x + a.w / 2;
    const y1 = a.y + a.h;
    const x2 = b.x + b.w / 2;
    const y2 = b.y;
    const d = Math.max(10, (y2 - y1) / 2);
    return `M${x1} ${y1} C${x1} ${y1 + d} ${x2} ${y2 - d} ${x2} ${y2}`;
  }
  const x1 = a.x + a.w;
  const y1 = a.y + a.h / 2;
  const x2 = b.x;
  const y2 = b.y + b.h / 2;
  const d = Math.max(28, (x2 - x1) * 0.5);
  return `M${x1} ${y1} C${x1 + d} ${y1} ${x2 - d} ${y2} ${x2} ${y2}`;
}

export type Lod = "far" | "mid" | "near";
export const lodFor = (zoom: number): Lod => (zoom < 0.6 ? "far" : zoom < 0.82 ? "mid" : "near");

export interface Viewport {
  px: number;
  py: number;
  zoom: number;
  w: number;
  h: number;
}

/** Fit bounds into a canvas, leaving room for the floating controls. */
export function fitTransform(bounds: { w: number; h: number }, cw: number, ch: number): { px: number; py: number; zoom: number } {
  const padX = 44;
  const top = 92;
  const bot = 56;
  const aw = Math.max(1, cw - padX * 2);
  const ah = Math.max(1, ch - top - bot);
  const z = Math.max(0.28, Math.min(1, Math.min(aw / Math.max(1, bounds.w), ah / Math.max(1, bounds.h))));
  return { zoom: z, px: (cw - bounds.w * z) / 2, py: top + (ah - bounds.h * z) / 2 };
}

/** Zoom about a point (canvas coordinates). */
export function zoomAbout(v: { px: number; py: number; zoom: number }, x: number, y: number, nz: number): { px: number; py: number; zoom: number } {
  const z = Math.max(0.25, Math.min(1.8, nz));
  return { zoom: z, px: x - (x - v.px) * (z / v.zoom), py: y - (y - v.py) * (z / v.zoom) };
}

/** The world-space rectangle the viewport shows, grown by a margin (screen px). */
export function worldViewport(v: Viewport, margin = 160): Rect {
  return { x: (-v.px - margin) / v.zoom, y: (-v.py - margin) / v.zoom, w: (v.w + margin * 2) / v.zoom, h: (v.h + margin * 2) / v.zoom };
}
export const intersects = (a: Rect, b: Rect) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;

/** Ids whose rects are in (or near) the viewport. `always` ids (e.g. the selection) are kept. */
export function visibleIds(L: Layout, v: Viewport, always: Iterable<string> = [], margin = 160): string[] {
  const view = worldViewport(v, margin);
  const keep = new Set(always);
  const out: string[] = [];
  for (const id in L.rects) if (keep.has(id) || intersects(L.rects[id], view)) out.push(id);
  return out;
}

/** The visible stand-in for a node: itself, its app card, or its collapsed manager. */
export function visibleIdOf(L: Layout, id: string, appIdOf: (id: string) => string | null, managerOfApp: (appId: string) => string | null): string | null {
  if (L.rects[id]) return id;
  const app = appIdOf(id);
  if (app) {
    if (L.rects[app]) return app;
    if (L.frames[`frame:${app}`]) return `frame:${app}`;
    const m = managerOfApp(app);
    if (m && L.rects[m]) return m;
  }
  return null;
}
