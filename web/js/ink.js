import { S, bus, uid, nextZ, mark, commit, touch, toWorld, $ } from './store.js';

const canvas = $('#ink');
const ctx = canvas.getContext('2d');
const cache = new WeakMap();
let list = [];
let listDirty = true;
let raf = 0;
let autoColor = '#1f2328';

export function setAutoColor(c) { autoColor = c; requestDraw(); }
export const resolveColor = (c) => (c === 'auto' ? autoColor : c);

export function resize() {
  const dpr = window.devicePixelRatio || 1;
  const r = canvas.parentElement.getBoundingClientRect();
  canvas.width = Math.round(r.width * dpr);
  canvas.height = Math.round(r.height * dpr);
  canvas.style.width = r.width + 'px';
  canvas.style.height = r.height + 'px';
  requestDraw();
}

export function reloadStrokes() { listDirty = true; requestDraw(); }

export function requestDraw() {
  if (raf) return;
  raf = requestAnimationFrame(() => { raf = 0; draw(); });
}

bus.on('items', (ids) => {
  if (ids.some((id) => { const it = S.items.get(id); return !it || it.kind === 'stroke'; })) {
    listDirty = true;
    requestDraw();
  }
});
bus.on('view', requestDraw);

function strokes() {
  if (listDirty) {
    list = [...S.items.values()].filter((i) => i.kind === 'stroke').sort((a, b) => a.z - b.z);
    listDirty = false;
  }
  return list;
}

function info(s) {
  let c = cache.get(s);
  if (c && c.pts === s.pts && c.n === s.pts.length) return c;
  const p = new Path2D();
  const a = s.pts;
  let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
  for (let i = 0; i < a.length; i += 2) {
    if (a[i] < minx) minx = a[i]; if (a[i] > maxx) maxx = a[i];
    if (a[i + 1] < miny) miny = a[i + 1]; if (a[i + 1] > maxy) maxy = a[i + 1];
  }
  if (a.length === 2) {
    p.moveTo(a[0], a[1]); p.lineTo(a[0] + 0.01, a[1]);
  } else {
    p.moveTo(a[0], a[1]);
    for (let i = 2; i < a.length - 2; i += 2) {
      p.quadraticCurveTo(a[i], a[i + 1], (a[i] + a[i + 2]) / 2, (a[i + 1] + a[i + 3]) / 2);
    }
    p.lineTo(a[a.length - 2], a[a.length - 1]);
  }
  c = { pts: s.pts, n: a.length, path: p, bbox: [minx, miny, maxx, maxy] };
  cache.set(s, c);
  return c;
}

function setTransform() {
  const dpr = window.devicePixelRatio || 1;
  const { x, y, k } = S.view;
  ctx.setTransform(dpr * k, 0, 0, dpr * k, dpr * x, dpr * y);
}

function draw() {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  setTransform();
  const { x, y, k } = S.view;
  const w = canvas.clientWidth / k, h = canvas.clientHeight / k;
  const vx = -x / k, vy = -y / k;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const s of strokes()) {
    const c = info(s);
    const m = s.size / 2;
    const b = c.bbox;
    if (b[2] + m < vx || b[0] - m > vx + w || b[3] + m < vy || b[1] - m > vy + h) continue;
    ctx.globalAlpha = s.alpha ?? 1;
    ctx.strokeStyle = resolveColor(s.color);
    ctx.lineWidth = s.size;
    ctx.stroke(c.path);
  }
  ctx.globalAlpha = 1;
}

const r1 = (v) => Math.round(v * 10) / 10;

export function beginPen(e, drag) {
  const p = toWorld(e.clientX, e.clientY);
  const s = {
    kind: 'stroke', id: uid(), z: nextZ(), pts: [r1(p.x), r1(p.y)],
    color: S.pen.color, size: S.pen.size, alpha: S.pen.alpha,
  };
  mark(s.id);
  S.items.set(s.id, s);
  listDirty = true;
  const incremental = s.alpha >= 1;
  const minD = 0.8 / S.view.k;

  if (incremental) {
    setTransform();
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.strokeStyle = resolveColor(s.color); ctx.lineWidth = s.size; ctx.globalAlpha = 1;
    ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(p.x + 0.01, p.y); ctx.stroke();
  }

  const add = (ev) => {
    const q = toWorld(ev.clientX, ev.clientY);
    const a = s.pts;
    const lx = a[a.length - 2], ly = a[a.length - 1];
    if (Math.hypot(q.x - lx, q.y - ly) < minD) return;
    a.push(r1(q.x), r1(q.y));
    const n = a.length;
    if (incremental) {
      ctx.beginPath();
      if (n === 4) {
        ctx.moveTo(a[0], a[1]);
        ctx.lineTo((a[0] + a[2]) / 2, (a[1] + a[3]) / 2);
      } else {
        ctx.moveTo((a[n - 6] + a[n - 4]) / 2, (a[n - 5] + a[n - 3]) / 2);
        ctx.quadraticCurveTo(a[n - 4], a[n - 3], (a[n - 4] + a[n - 2]) / 2, (a[n - 3] + a[n - 1]) / 2);
      }
      ctx.stroke();
    } else requestDraw();
  };

  drag({
    move(ev) {
      const evs = ev.getCoalescedEvents ? ev.getCoalescedEvents() : [ev];
      for (const c of evs.length ? evs : [ev]) add(c);
    },
    up() {
      commit();
      touch([s.id]);
    },
  });
}

function segDist2(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const l2 = dx * dx + dy * dy;
  let t = l2 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * dx - px, cy = ay + t * dy - py;
  return cx * cx + cy * cy;
}

function eraseStroke(s, ax, ay, bx, by, r) {
  const a = s.pts;
  const reach = r + s.size / 2;
  const reach2 = reach * reach;
  const step = Math.max(r * 0.6, 0.75 / S.view.k);
  const hit = (x, y) => segDist2(x, y, ax, ay, bx, by) <= reach2;
  const dense = [];
  for (let i = 0; i < a.length - 2; i += 2) {
    const x0 = a[i], y0 = a[i + 1], x1 = a[i + 2], y1 = a[i + 3];
    const n = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / step));
    for (let j = 0; j < n; j++) dense.push(x0 + ((x1 - x0) * j) / n, y0 + ((y1 - y0) * j) / n);
  }
  dense.push(a[a.length - 2], a[a.length - 1]);
  let any = false;
  const flags = [];
  for (let i = 0; i < dense.length; i += 2) {
    const h = hit(dense[i], dense[i + 1]);
    flags.push(h);
    if (h) any = true;
  }
  if (!any) return null;
  const pieces = [];
  let cur = [];
  for (let i = 0; i < flags.length; i++) {
    if (flags[i]) { if (cur.length) pieces.push(cur); cur = []; }
    else cur.push(r1(dense[i * 2]), r1(dense[i * 2 + 1]));
  }
  if (cur.length) pieces.push(cur);
  return pieces.filter((p) => p.length >= 4 || (a.length === 2 && p.length === 2));
}

export function beginErase(e, drag) {
  let prev = toWorld(e.clientX, e.clientY);

  const apply = (cur) => {
    const r = S.eraser.size / 2 / S.view.k;
    const minx = Math.min(prev.x, cur.x) - r, maxx = Math.max(prev.x, cur.x) + r;
    const miny = Math.min(prev.y, cur.y) - r, maxy = Math.max(prev.y, cur.y) + r;
    const changed = [];
    for (const s of [...strokes()]) {
      if (!S.items.has(s.id)) continue;
      const b = info(s).bbox, m = s.size / 2;
      if (b[2] + m < minx || b[0] - m > maxx || b[3] + m < miny || b[1] - m > maxy) continue;
      const pieces = eraseStroke(s, prev.x, prev.y, cur.x, cur.y, r);
      if (!pieces) continue;
      mark(s.id);
      changed.push(s.id);
      if (S.eraser.whole || !pieces.length) {
        S.items.delete(s.id);
      } else {
        s.pts = pieces[0];
        for (let i = 1; i < pieces.length; i++) {
          const n = { ...s, id: uid(), pts: pieces[i] };
          mark(n.id);
          S.items.set(n.id, n);
          changed.push(n.id);
        }
      }
    }
    prev = cur;
    if (changed.length) { listDirty = true; touch(changed); }
  };

  apply(prev);
  drag({
    move(ev) {
      const evs = ev.getCoalescedEvents ? ev.getCoalescedEvents() : [ev];
      for (const c of evs.length ? evs : [ev]) apply(toWorld(c.clientX, c.clientY));
    },
    up() { commit(); },
  });
}

new ResizeObserver(resize).observe(canvas.parentElement);
