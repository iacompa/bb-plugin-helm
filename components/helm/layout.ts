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
  /** The drawing spans x0..w and y0..h (x0 and y0 are 0 unless a node was dragged above or left of the origin). */
  bounds: { w: number; h: number; x0?: number; y0?: number };
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
  /** Agents beside the Orchestrator in its column: the Planner (no edge) and custom agents with no app (an edge from their supervisor). */
  side?: Array<{ id: string; parentId: string | null }>;
  /** Observatory ghost ids */
  ghosts?: string[];
  ghostLabel?: string;
}

const plural = (n: number, a: string) => `${n} ${n === 1 ? a : `${a}s`}`;

/** Vertical gap between the rows of the top-down layout (Orchestrator, managers, apps). */
const VG = 64;

/** Columns for an app's agents under its lead: as close to a square as fits. */
export const squareCols = (n: number) => Math.max(2, Math.min(4, Math.ceil(Math.sqrt(n))));

/**
 * Lay out apps in a grid of up to two columns, rows centred in the grid's width. An expanded app
 * takes a full row as a frame: its lead on top, the other agents in a square grid below.
 */
function appGrid(appIds: string[], input: PortfolioInput): { h: number; w: number; place: (x0: number, top: number, out: Layout, parent: string, hue?: string | null) => void } {
  const cellW = D.app.w + 10;
  type Row = { kind: "cards"; ids: string[] } | { kind: "frame"; id: string; cols: number; rows: number; w: number; h: number };
  const rows: Row[] = [];
  let cur: string[] = [];
  for (const id of appIds) {
    if (input.expanded.has(id)) {
      if (cur.length) rows.push({ kind: "cards", ids: cur });
      cur = [];
      const others = Math.max(0, (input.members[id]?.length ?? 0) - 1);
      const cols = squareCols(others);
      const r = Math.ceil(others / cols);
      const w = Math.max(D.cols * cellW - 10, D.pad * 2 + cols * D.mini.w + (cols - 1) * D.ng);
      const h = D.head + D.pad * 2 + D.mini.h + (r ? D.ng * 3 + r * D.mini.h + (r - 1) * D.ng : 0);
      rows.push({ kind: "frame", id, cols, rows: r, w, h });
    } else {
      cur.push(id);
      if (cur.length === D.cols) {
        rows.push({ kind: "cards", ids: cur });
        cur = [];
      }
    }
  }
  if (cur.length) rows.push({ kind: "cards", ids: cur });
  const rowW = (r: Row) => (r.kind === "cards" ? r.ids.length * cellW - 10 : r.w);
  const rowH = (r: Row) => (r.kind === "cards" ? D.app.h : r.h);
  const h = rows.reduce((a, r) => a + rowH(r), 0) + Math.max(0, rows.length - 1) * D.gy;
  const w = rows.reduce((m, r) => Math.max(m, rowW(r)), 0);
  const place = (x0: number, top: number, out: Layout, parent: string, hue?: string | null) => {
    let y = top;
    for (const r of rows) {
      const x = x0 + (w - rowW(r)) / 2;
      if (r.kind === "cards") {
        r.ids.forEach((id, i) => {
          out.rects[id] = { x: x + i * cellW, y, w: D.app.w, h: D.app.h, mode: "app" };
          out.edges.push({ from: parent, to: id, kind: parent === input.orchId ? "direct" : "app" });
        });
      } else {
        const fid = `frame:${r.id}`;
        out.frames[fid] = { x, y, w: r.w, h: r.h };
        out.clusters.push({ id: fid, x, y, w: r.w, h: r.h, label: `${input.appNames[r.id] ?? r.id} · ${plural(input.members[r.id]?.length ?? 0, "agent")}`, hue });
        out.edges.push({ from: parent, to: fid, kind: parent === input.orchId ? "direct" : "app" });
        const [lead, ...others] = input.members[r.id] ?? [];
        const ly = y + D.head + D.pad;
        if (lead) out.rects[lead] = { x: x + (r.w - D.mini.w) / 2, y: ly, w: D.mini.w, h: D.mini.h, mode: "agent" };
        const gridW = r.cols * D.mini.w + (r.cols - 1) * D.ng;
        const gx = x + (r.w - gridW) / 2;
        const gy = ly + D.mini.h + D.ng * 3;
        others.forEach((nid, i) => {
          out.rects[nid] = { x: gx + (i % r.cols) * (D.mini.w + D.ng), y: gy + Math.floor(i / r.cols) * (D.mini.h + D.ng), w: D.mini.w, h: D.mini.h, mode: "agent" };
        });
      }
      y += rowH(r) + D.gy;
    }
  };
  return { h, w, place };
}

/**
 * Top-down portfolio: the Orchestrator in the centre of the first row with the Planner, the Git agent
 * and custom agents with no app beside it; the managers on the second row; the apps (their leads)
 * under their manager; an expanded app's other agents in a square under its lead.
 */
export function portfolioLayout(input: PortfolioInput): Layout {
  const out: Layout = { rects: {}, frames: {}, edges: [], clusters: [], labels: [], deco: [], bounds: { w: 0, h: 0 } };
  const P = 14; // group box padding
  const BG = 40; // gap between groups
  const hasMgr = input.managers.length > 0;
  const mgrY = D.orch.h + VG;
  const appY = hasMgr ? mgrY + D.mgr.h + VG : D.orch.h + VG;
  type Block = { kind: "mgr"; m: PortfolioInput["managers"][number]; grid: ReturnType<typeof appGrid>; w: number } | { kind: "direct"; grid: ReturnType<typeof appGrid>; w: number };
  const blocks: Block[] = input.managers.map((m) => {
    const grid = appGrid(input.collapsed.has(m.id) ? [] : m.appIds, input);
    return { kind: "mgr", m, grid, w: Math.max(D.mgr.w, grid.w) };
  });
  if (input.directAppIds.length) {
    const grid = appGrid(input.directAppIds, input);
    blocks.push({ kind: "direct", grid, w: grid.w });
  }
  const blocksW = blocks.reduce((a, b) => a + b.w + P * 2, 0) + BG * Math.max(0, blocks.length - 1);

  // the first row: Orchestrator centred, the Planner on its left, the Git agent on its right, then the others outward
  const side = input.side ?? [];
  const sideW = D.orch.w;
  const left = side.filter((_, i) => i % 2 === 0);
  const right = side.filter((_, i) => i % 2 === 1);
  const rowW = D.orch.w + Math.max(left.length, right.length) * 2 * (sideW + 24);
  const W = Math.max(blocksW, rowW, D.orch.w);
  const ox = W / 2 - D.orch.w / 2;
  out.rects[input.orchId] = { x: ox, y: 0, w: D.orch.w, h: D.orch.h, mode: "orch" };
  const sy = (D.orch.h - D.nh) / 2;
  const placeSide = (s: { id: string; parentId: string | null }, x: number) => {
    out.rects[s.id] = { x, y: sy, w: sideW, h: D.nh, mode: "agent" };
    if (s.parentId && s.parentId !== input.orchId) out.edges.push({ from: s.parentId, to: s.id, kind: "direct" });
  };
  left.forEach((s, i) => placeSide(s, ox - (i + 1) * (sideW + 24)));
  right.forEach((s, i) => placeSide(s, ox + D.orch.w + 24 + i * (sideW + 24)));

  let x = (W - blocksW) / 2;
  let maxB = D.orch.h;
  for (const b of blocks) {
    const inner = x + P;
    if (b.kind === "mgr") {
      out.rects[b.m.id] = { x: inner + (b.w - D.mgr.w) / 2, y: mgrY, w: D.mgr.w, h: D.mgr.h, mode: "mgr" };
      b.grid.place(inner + (b.w - b.grid.w) / 2, appY, out, b.m.id, b.m.hue);
      const bottom = b.grid.h ? appY + b.grid.h : mgrY + D.mgr.h;
      out.clusters.push({ id: `cl-${b.m.id}`, x, y: mgrY - P - 6, w: b.w + P * 2, h: bottom - mgrY + P * 2 + 6, label: `${b.m.name} · ${plural(b.m.appIds.length, "app")}`, hue: b.m.hue });
      out.edges.push({ from: input.orchId, to: b.m.id, kind: "mgr" });
      maxB = Math.max(maxB, bottom + P);
    } else {
      b.grid.place(inner, appY, out, input.orchId);
      if (hasMgr) out.clusters.push({ id: "cl-direct", x, y: appY - P - 6, w: b.w + P * 2, h: b.grid.h + P * 2 + 6, label: `Reports to the Orchestrator · ${plural(input.directAppIds.length, "app")}`, dashed: true });
      maxB = Math.max(maxB, appY + b.grid.h + P);
    }
    x += b.w + P * 2 + BG;
  }
  let h = maxB;
  let maxR = W;
  const ghosts = input.ghosts ?? [];
  if (ghosts.length) {
    const oy = h + 54;
    const gx = Math.max(0, W / 2 - (Math.min(3, ghosts.length) * (D.app.w + 12)) / 2);
    out.labels.push({ x: gx, y: oy - 24, text: input.ghostLabel ?? `Outside this run · ${plural(ghosts.length, "thread")} · read-only` });
    ghosts.forEach((id, i) => {
      out.rects[id] = { x: gx + (i % 3) * (D.app.w + 12), y: oy + Math.floor(i / 3) * 96, w: D.app.w, h: 84, mode: "ghost" };
    });
    h = oy + Math.ceil(ghosts.length / 3) * 96;
    maxR = Math.max(maxR, gx + Math.min(3, ghosts.length) * (D.app.w + 12));
  }
  // the first row may reach left of 0 when there are many side agents: shift everything right
  const minX = Math.min(0, ...Object.values(out.rects).map((r) => r.x));
  if (minX < 0) {
    for (const r of Object.values(out.rects)) r.x -= minX;
    for (const f of Object.values(out.frames)) f.x -= minX;
    for (const c of out.clusters) c.x -= minX;
    for (const l of out.labels) l.x -= minX;
    maxR -= minX;
  }
  out.bounds = { w: Math.max(maxR, ...Object.values(out.rects).map((r) => r.x + r.w)) + 4, h };
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

/** One app, top-down: its chain of command, the lead, its builders in a square, then the quality gates. */
export function squadLayout(a: SquadInput): Layout {
  const out: Layout = { rects: {}, frames: {}, edges: [], clusters: [], labels: [], deco: [], bounds: { w: 0, h: 0 } };
  const { W1, nw, nh, ng, pad, head } = D;
  const cols = squareCols(a.specialists.length);
  const rows = Math.max(1, Math.ceil(a.specialists.length / cols));
  const sfW = nw * cols + ng * (cols - 1) + pad * 2;
  const sfH = head + rows * nh + (rows - 1) * ng + pad * 2;
  const gRows = Math.max(1, Math.ceil(a.gates.length / cols));
  const gfH = head + gRows * nh + (gRows - 1) * ng + pad * 2;
  const W = Math.max(sfW, W1);
  const cx = W / 2;
  const leadH = 136;
  const chipH = 46;
  const vg = 28;
  let y = 0;
  let prev: string | null = null;
  for (const id of a.chain) {
    out.rects[id] = { x: cx - W1 / 2, y, w: W1, h: chipH, mode: "chip" };
    if (prev) out.edges.push({ from: prev, to: id, kind: "v" });
    prev = id;
    y += chipH + vg;
  }
  out.rects[a.leadId] = { x: cx - W1 / 2, y, w: W1, h: leadH, mode: "agent" };
  if (prev) out.edges.push({ from: prev, to: a.leadId, kind: "v" });
  y += leadH + 44;
  const sx = cx - sfW / 2;
  const sfY = y;
  out.clusters.push({ id: "sf", x: sx, y: sfY, w: sfW, h: sfH, label: `Specialists · ${a.specialists.length}`, hue: a.hue });
  out.frames.sf = { x: sx, y: sfY, w: sfW, h: sfH };
  a.specialists.forEach((id, i) => {
    out.rects[id] = { x: sx + pad + (i % cols) * (nw + ng), y: sfY + head + pad + Math.floor(i / cols) * (nh + ng), w: nw, h: nh, mode: "agent" };
  });
  const gfY = sfY + sfH + 44;
  out.clusters.push({ id: "gf", x: sx, y: gfY, w: sfW, h: gfH, label: "Quality gates · spawned on demand", dashed: true });
  out.frames.gf = { x: sx, y: gfY, w: sfW, h: gfH };
  a.gates.forEach((id, i) => {
    out.rects[id] = { x: sx + pad + (i % cols) * (nw + ng), y: gfY + head + pad + Math.floor(i / cols) * (nh + ng), w: nw, h: nh, mode: "agent" };
  });
  out.edges.push({ from: a.leadId, to: "sf", kind: "frame" });
  out.deco.push({ x: cx, y1: sfY + sfH + 6, y2: gfY - 6, text: "integrate → review → slop check" });
  out.bounds = { w: W, h: gfY + gfH };
  return out;
}

// ───────────── geometry, zoom, culling ─────────────

export const rectOf = (L: Layout, id: string): Rect | undefined => L.rects[id] ?? L.frames[id];

// ───────────── nodes moved by hand ─────────────

export type Offsets = Record<string, { dx: number; dy: number }>;

const inside = (r: Rect, b: Rect) => r.x >= b.x - 1 && r.y >= b.y - 1 && r.x + r.w <= b.x + b.w + 1 && r.y + r.h <= b.y + b.h + 1;

/** A box around its members again after some moved, keeping the padding it had on each side. */
function refit(box: Rect, before: Rect[], after: Rect[]): Rect {
  const bb = (rs: Rect[]) => ({ x0: Math.min(...rs.map((r) => r.x)), y0: Math.min(...rs.map((r) => r.y)), x1: Math.max(...rs.map((r) => r.x + r.w)), y1: Math.max(...rs.map((r) => r.y + r.h)) });
  const o = bb(before);
  const n = bb(after);
  const x = n.x0 - (o.x0 - box.x);
  const y = n.y0 - (o.y0 - box.y);
  return { x, y, w: n.x1 + (box.x + box.w - o.x1) - x, h: n.y1 + (box.y + box.h - o.y1) - y };
}

/**
 * The layout with the nodes the user dragged moved by their offsets. An offset on a frame or group
 * box (`frame:<app>` for an expanded app, a manager's group) moves everything in it; frames and
 * group boxes stretch to hold their members. Nodes may go anywhere, also above or left of the
 * origin: `bounds.x0`/`y0` then say where the drawing starts.
 */
export function withOffsets(L: Layout, off: Offsets): Layout {
  const boxOf = (id: string): Rect | undefined => L.frames[id] ?? L.clusters.find((c) => c.id === id);
  const ids = Object.keys(off).filter((id) => L.rects[id] || boxOf(id));
  if (!ids.length) return L;
  const shift: Record<string, { dx: number; dy: number }> = {};
  const add = (id: string, d: { dx: number; dy: number }) => {
    const s = (shift[id] ??= { dx: 0, dy: 0 });
    s.dx += d.dx;
    s.dy += d.dy;
  };
  for (const id of ids) {
    if (L.rects[id]) add(id, off[id]);
    const box = boxOf(id);
    if (box) for (const m in L.rects) if (inside(L.rects[m], box)) add(m, off[id]);
  }
  const rects: Record<string, PlacedRect> = { ...L.rects };
  for (const id in shift) {
    const r = L.rects[id];
    rects[id] = { ...r, x: r.x + shift[id].dx, y: r.y + shift[id].dy };
  }
  const regroup = <T extends Rect>(box: T): T => {
    const members = Object.keys(L.rects).filter((m) => inside(L.rects[m], box));
    if (!members.some((m) => shift[m])) return box;
    return { ...box, ...refit(box, members.map((m) => L.rects[m]), members.map((m) => rects[m])) };
  };
  const frames: Record<string, Rect> = {};
  for (const k in L.frames) frames[k] = regroup(L.frames[k]);
  const clusters = L.clusters.map(regroup);
  const all = [...Object.values(rects), ...Object.values(frames), ...clusters];
  const bounds = {
    w: Math.max(L.bounds.w, ...all.map((r) => r.x + r.w + 20)),
    h: Math.max(L.bounds.h, ...all.map((r) => r.y + r.h + 20)),
    x0: Math.min(L.bounds.x0 ?? 0, ...all.map((r) => r.x - 20)),
    y0: Math.min(L.bounds.y0 ?? 0, ...all.map((r) => r.y - 20 - 10)),
  };
  return { ...L, rects, frames, clusters, bounds };
}

/**
 * An edge between two boxes: top-down (bottom of the upper box to the top of the lower one) when
 * they are apart vertically, side to side when they share a row. `"h"` forces side to side.
 */
export function pathD(a: Rect, b: Rect, kind: "v" | "h" | "auto" = "auto"): string {
  const vertical = kind === "v" || (kind === "auto" && (b.y >= a.y + a.h + 8 || a.y >= b.y + b.h + 8));
  if (vertical) {
    const [top, bot] = b.y >= a.y + a.h || kind === "v" ? [a, b] : [b, a];
    const x1 = top.x + top.w / 2;
    const y1 = top.y + top.h;
    const x2 = bot.x + bot.w / 2;
    const y2 = bot.y;
    const d = Math.max(10, (y2 - y1) / 2);
    return `M${x1} ${y1} C${x1} ${y1 + d} ${x2} ${y2 - d} ${x2} ${y2}`;
  }
  const [l, r] = b.x >= a.x ? [a, b] : [b, a];
  const x1 = l.x + l.w;
  const y1 = l.y + l.h / 2;
  const x2 = r.x;
  const y2 = r.y + r.h / 2;
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
export function fitTransform(bounds: { w: number; h: number; x0?: number; y0?: number }, cw: number, ch: number): { px: number; py: number; zoom: number } {
  const padX = 44;
  const top = 92;
  const bot = 56;
  const x0 = bounds.x0 ?? 0;
  const y0 = bounds.y0 ?? 0;
  const bw = bounds.w - x0;
  const bh = bounds.h - y0;
  const aw = Math.max(1, cw - padX * 2);
  const ah = Math.max(1, ch - top - bot);
  const z = Math.max(0.28, Math.min(1, Math.min(aw / Math.max(1, bw), ah / Math.max(1, bh))));
  return { zoom: z, px: (cw - bw * z) / 2 - x0 * z, py: top + (ah - bh * z) / 2 - y0 * z };
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
