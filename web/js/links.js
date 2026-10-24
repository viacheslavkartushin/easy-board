import { S, bus, uid, nextZ, mark, commit, touch, toWorld, setSel, $ } from './store.js';
import { rectOf, hitCard } from './cards.js';
import { resolveColor } from './ink.js';

const svg = $('#links');
const NS = 'http://www.w3.org/2000/svg';
const els = new Map();

const mk = (tag, attrs = {}) => {
  const e = document.createElementNS(NS, tag);
  for (const k in attrs) e.setAttribute(k, attrs[k]);
  return e;
};

export function geom(a, b, arrowSize = 0) {
  const ac = { x: a.x + a.w / 2, y: a.y + a.h / 2 };
  const bc = { x: b.x + b.w / 2, y: b.y + b.h / 2 };
  const dx = bc.x - ac.x, dy = bc.y - ac.y;
  const horizontal = Math.abs(dx) / ((a.w + b.w) / 2 + 1) > Math.abs(dy) / ((a.h + b.h) / 2 + 1);
  const off = Math.max(40, Math.hypot(dx, dy) * 0.3);
  let p1, p2, c1, c2;
  if (horizontal) {
    const s = dx >= 0 ? 1 : -1;
    p1 = { x: s > 0 ? a.x + a.w : a.x, y: ac.y };
    p2 = { x: s > 0 ? b.x : b.x + b.w, y: bc.y };
    if (b.w === 0) p2 = { x: bc.x, y: bc.y };
    c1 = { x: p1.x + s * off, y: p1.y };
    c2 = { x: p2.x - s * off, y: p2.y };
  } else {
    const s = dy >= 0 ? 1 : -1;
    p1 = { x: ac.x, y: s > 0 ? a.y + a.h : a.y };
    p2 = { x: bc.x, y: s > 0 ? b.y : b.y + b.h };
    if (b.h === 0) p2 = { x: bc.x, y: bc.y };
    c1 = { x: p1.x, y: p1.y + s * off };
    c2 = { x: p2.x, y: p2.y - s * off };
  }
  let tx = p2.x - c2.x, ty = p2.y - c2.y;
  const tl = Math.hypot(tx, ty) || 1;
  tx /= tl; ty /= tl;
  const end = arrowSize ? { x: p2.x - tx * arrowSize * 0.8, y: p2.y - ty * arrowSize * 0.8 } : p2;
  const d = `M${p1.x},${p1.y} C${c1.x},${c1.y} ${c2.x},${c2.y} ${end.x},${end.y}`;
  const mid = {
    x: (p1.x + 3 * c1.x + 3 * c2.x + p2.x) / 8,
    y: (p1.y + 3 * c1.y + 3 * c2.y + p2.y) / 8,
  };
  return { d, p2, tx, ty, mid };
}

function head(p, tx, ty, size) {
  const nx = -ty, ny = tx, h = size * 0.5;
  const bx = p.x - tx * size, by = p.y - ty * size;
  return `M${p.x},${p.y} L${bx + nx * h},${by + ny * h} L${bx - nx * h},${by - ny * h} Z`;
}

function render(l) {
  const a = S.items.get(l.from), b = S.items.get(l.to);
  const ra = a && rectOf(l.from), rb = b && rectOf(l.to);
  let g = els.get(l.id);
  if (!ra || !rb) { if (g) { g.remove(); els.delete(l.id); } return; }
  if (!g) {
    g = mk('g', { 'data-link': l.id, class: 'link' });
    g.append(mk('path', { class: 'hit' }), mk('path', { class: 'vis' }), mk('path', { class: 'head' }), mk('text', { class: 'lbl' }));
    svg.appendChild(g);
    els.set(l.id, g);
  }
  const size = l.arrow ? 9 + l.width * 1.6 : 0;
  const gm = geom(ra, rb, size);
  const col = resolveColor(l.color);
  const [hit, vis, hd, lbl] = g.children;
  hit.setAttribute('d', gm.d);
  vis.setAttribute('d', gm.d);
  vis.style.stroke = col;
  vis.style.strokeWidth = l.width;
  vis.style.strokeDasharray = l.dashed ? `${l.width * 3} ${l.width * 2.5}` : '';
  if (l.arrow) { hd.setAttribute('d', head(gm.p2, gm.tx, gm.ty, size)); hd.style.fill = col; hd.style.display = ''; }
  else hd.style.display = 'none';
  lbl.textContent = l.label || '';
  lbl.setAttribute('x', gm.mid.x);
  lbl.setAttribute('y', gm.mid.y - 6);
  lbl.style.fill = col;
  g.style.zIndex = l.z;
  g.classList.toggle('sel', S.sel.has(l.id));
}

export function renderAll() {
  const seen = new Set();
  for (const it of S.items.values()) if (it.kind === 'link') { render(it); seen.add(it.id); }
  for (const [id, g] of els) if (!seen.has(id)) { g.remove(); els.delete(id); }
}

function relink(ids) {
  const set = new Set(ids);
  for (const it of S.items.values()) {
    if (it.kind === 'link' && (set.has(it.id) || set.has(it.from) || set.has(it.to))) render(it);
  }
  for (const id of ids) if (els.has(id) && !S.items.has(id)) { els.get(id).remove(); els.delete(id); }
}
bus.on('items', relink);
bus.on('cardsize', (id) => relink([id]));
bus.on('select', () => { for (const [id, g] of els) g.classList.toggle('sel', S.sel.has(id)); });
bus.on('theme', renderAll);

export function createLink(from, to) {
  for (const it of S.items.values()) {
    if (it.kind === 'link' && it.from === from && it.to === to) { setSel([it.id]); return it.id; }
  }
  const l = {
    kind: 'link', id: uid(), z: nextZ(), from, to,
    color: S.link.color, width: S.link.width, arrow: S.link.arrow, dashed: S.link.dashed, label: '',
  };
  mark(l.id);
  S.items.set(l.id, l);
  commit();
  touch([l.id]);
  setSel([l.id]);
  return l.id;
}

export function beginLink(e, fromId, drag) {
  const a = rectOf(fromId);
  const prev = mk('path', { class: 'prev' });
  svg.appendChild(prev);
  let target = null;
  const upd = (ev) => {
    const p = toWorld(ev.clientX, ev.clientY);
    const hid = hitCard(p.x, p.y);
    target = hid && hid !== fromId ? hid : null;
    const b = target ? rectOf(target) : { x: p.x, y: p.y, w: 0, h: 0 };
    prev.setAttribute('d', geom(a, b).d);
    prev.style.stroke = resolveColor(S.link.color);
    bus.emit('linktarget', target);
  };
  upd(e);
  drag({
    move: upd,
    up() {
      prev.remove();
      bus.emit('linktarget', null);
      if (target) createLink(fromId, target);
    },
  });
}
