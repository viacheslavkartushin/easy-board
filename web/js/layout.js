import { S, $, mark, commit, touch, dirty, setSel } from './store.js';
import { rectOf, createCard } from './cards.js';

const guides = document.createElement('div');
guides.id = 'guides';
$('#world').appendChild(guides);

export const GRID = 24;

export function expandWithFrames(ids) {
  const out = new Set(ids);
  const frames = ids.map((i) => S.items.get(i)).filter((i) => i?.type === 'frame');
  if (!frames.length) return [...out];
  for (const f of frames) {
    const fr = rectOf(f.id);
    for (const it of S.items.values()) {
      if (it.kind !== 'card' || out.has(it.id) || it.type === 'frame') continue;
      const r = rectOf(it.id);
      const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
      if (cx >= fr.x && cx <= fr.x + fr.w && cy >= fr.y && cy <= fr.y + fr.h) out.add(it.id);
    }
  }
  for (const it of S.items.values()) {
    if (it.type !== 'frame' || out.has(it.id)) continue;
    const r = rectOf(it.id);
    if ([...frames].some((f) => { const fr = rectOf(f.id); return r.x >= fr.x && r.y >= fr.y && r.x + r.w <= fr.x + fr.w && r.y + r.h <= fr.y + fr.h; })) out.add(it.id);
  }
  return [...out];
}

export function clearGuides() { guides.innerHTML = ''; }
function line(x, y, w, h) {
  const d = document.createElement('i');
  d.style.cssText = `left:${x}px;top:${y}px;width:${w}px;height:${h}px`;
  guides.appendChild(d);
}

export function snapDelta(movingIds, startRects, dx, dy, noSnap) {
  clearGuides();
  if (noSnap || !startRects.length) return { dx, dy };
  const x0 = Math.min(...startRects.map((r) => r.x)), y0 = Math.min(...startRects.map((r) => r.y));
  const x1 = Math.max(...startRects.map((r) => r.x + r.w)), y1 = Math.max(...startRects.map((r) => r.y + r.h));
  const bw = x1 - x0, bh = y1 - y0;
  const thr = 7 / S.view.k;
  const mv = new Set(movingIds);
  const others = [];
  for (const it of S.items.values()) if (it.kind === 'card' && !mv.has(it.id)) others.push(rectOf(it.id));

  const pick = (mine, lines) => {
    let best = null;
    for (const m of mine) for (const l of lines) {
      const d = l.v - m;
      if (Math.abs(d) <= thr && (!best || Math.abs(d) < Math.abs(best.d))) best = { d, l };
    }
    return best;
  };
  const xs = [], ys = [];
  for (const r of others) {
    for (const v of [r.x, r.x + r.w / 2, r.x + r.w]) xs.push({ v, r });
    for (const v of [r.y, r.y + r.h / 2, r.y + r.h]) ys.push({ v, r });
  }
  const bx = x0 + dx, by = y0 + dy;
  const sx = pick([bx, bx + bw / 2, bx + bw], xs);
  const sy = pick([by, by + bh / 2, by + bh], ys);
  let ox = dx, oy = dy;
  if (sx) ox = dx + sx.d;
  else if (S.ui.grid) ox = Math.round(bx / GRID) * GRID - x0;
  if (sy) oy = dy + sy.d;
  else if (S.ui.grid) oy = Math.round(by / GRID) * GRID - y0;
  const t = 1 / S.view.k;
  if (sx) { const r = sx.l.r; const a = Math.min(y0 + oy, r.y), b = Math.max(y0 + oy + bh, r.y + r.h); line(sx.l.v - t / 2, a, t, b - a); }
  if (sy) { const r = sy.l.r; const a = Math.min(x0 + ox, r.x), b = Math.max(x0 + ox + bw, r.x + r.w); line(a, sy.l.v - t / 2, b - a, t); }
  return { dx: ox, dy: oy };
}

function selCards() {
  return [...S.sel].map((i) => S.items.get(i)).filter((i) => i?.kind === 'card');
}
function moveWith(its, fn) {
  const ids = its.map((i) => i.id);
  ids.forEach(mark);
  fn();
  commit();
  touch(ids);
  dirty();
}
export function align(mode) {
  const its = selCards();
  if (its.length < 2) return;
  const R = new Map(its.map((i) => [i.id, rectOf(i.id)]));
  const L = Math.min(...[...R.values()].map((r) => r.x)), Rr = Math.max(...[...R.values()].map((r) => r.x + r.w));
  const T = Math.min(...[...R.values()].map((r) => r.y)), B = Math.max(...[...R.values()].map((r) => r.y + r.h));
  moveWith(its, () => {
    for (const it of its) {
      const r = R.get(it.id);
      if (mode === 'left') it.x = Math.round(L);
      else if (mode === 'right') it.x = Math.round(Rr - r.w);
      else if (mode === 'cx') it.x = Math.round((L + Rr) / 2 - r.w / 2);
      else if (mode === 'top') it.y = Math.round(T);
      else if (mode === 'bottom') it.y = Math.round(B - r.h);
      else if (mode === 'cy') it.y = Math.round((T + B) / 2 - r.h / 2);
    }
  });
}
export function distribute(axis) {
  const its = selCards();
  if (its.length < 3) return;
  const R = new Map(its.map((i) => [i.id, rectOf(i.id)]));
  const pos = axis === 'x' ? 'x' : 'y', size = axis === 'x' ? 'w' : 'h';
  const sorted = [...its].sort((a, b) => R.get(a.id)[pos] - R.get(b.id)[pos]);
  const first = R.get(sorted[0].id), last = R.get(sorted[sorted.length - 1].id);
  const total = last[pos] + last[size] - first[pos];
  const used = sorted.reduce((s, i) => s + R.get(i.id)[size], 0);
  const gap = (total - used) / (sorted.length - 1);
  moveWith(its, () => {
    let cur = first[pos];
    for (const it of sorted) {
      it[pos] = Math.round(cur);
      cur += R.get(it.id)[size] + gap;
    }
  });
}
export function wrapInFrame(ids) {
  const rs = ids.map((i) => S.items.get(i)).filter((i) => i?.kind === 'card' && i.type !== 'frame').map((i) => rectOf(i.id));
  if (!rs.length) return null;
  const x0 = Math.min(...rs.map((r) => r.x)), y0 = Math.min(...rs.map((r) => r.y));
  const x1 = Math.max(...rs.map((r) => r.x + r.w)), y1 = Math.max(...rs.map((r) => r.y + r.h));
  const id = createCard('frame', { w: Math.round(x1 - x0 + 64), h: Math.round(y1 - y0 + 64 + 28) }, { x: x0 - 32, y: y0 - 32 - 28 });
  setSel([id]);
  return id;
}
