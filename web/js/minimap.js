import { S, bus, $ } from './store.js';
import { rectOf } from './cards.js';
import { centerOn } from './nav.js';

const box = document.createElement('div');
box.id = 'minimap';
box.className = 'panel';
box.innerHTML = '<canvas width="400" height="280"></canvas>';
document.body.appendChild(box);
const cv = box.firstChild;
const ctx = cv.getContext('2d');
const W = 400, H = 280;
let map = null, raf = 0, lock = null;

const css = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();

function draw() {
  raf = 0;
  box.style.display = S.ui.minimap ? '' : 'none';
  if (!S.ui.minimap) return;
  const st = $('#stage').getBoundingClientRect();
  const k = S.view.k;
  const vp = { x: -S.view.x / k, y: -S.view.y / k, w: st.width / k, h: st.height / k };
  let x0 = vp.x, y0 = vp.y, x1 = vp.x + vp.w, y1 = vp.y + vp.h;
  const cards = [];
  for (const it of S.items.values()) {
    if (it.kind !== 'card') continue;
    const r = rectOf(it.id);
    cards.push({ it, r });
    x0 = Math.min(x0, r.x); y0 = Math.min(y0, r.y); x1 = Math.max(x1, r.x + r.w); y1 = Math.max(y1, r.y + r.h);
  }
  const pad = Math.max(x1 - x0, y1 - y0) * 0.05 + 20;
  x0 -= pad; y0 -= pad; x1 += pad; y1 += pad;
  let s = Math.min(W / (x1 - x0), H / (y1 - y0));
  let ox = (W - (x1 - x0) * s) / 2, oy = (H - (y1 - y0) * s) / 2;
  map = lock || { x0, y0, s, ox, oy };
  ({ x0, y0, s, ox, oy } = map);
  ctx.clearRect(0, 0, W, H);
  const P = (x, y) => [ox + (x - x0) * s, oy + (y - y0) * s];
  const fg = css('--muted') || '#888', ac = css('--accent') || '#4f6df5';
  for (const { it, r } of cards.sort((a, b) => (a.it.type === 'frame' ? -1 : 0) - (b.it.type === 'frame' ? -1 : 0))) {
    const [px, py] = P(r.x, r.y);
    const w = Math.max(2, r.w * s), h = Math.max(2, r.h * s);
    if (it.type === 'frame') {
      ctx.strokeStyle = it.color || ac; ctx.globalAlpha = 0.8; ctx.lineWidth = 1.5; ctx.strokeRect(px, py, w, h); ctx.globalAlpha = 1;
    } else {
      ctx.fillStyle = it.accent || (it.type === 'note' ? it.color : fg);
      ctx.globalAlpha = it.accent || it.type === 'note' ? 0.95 : 0.55;
      ctx.fillRect(px, py, w, h);
      ctx.globalAlpha = 1;
    }
  }
  const [vx, vy] = P(vp.x, vp.y);
  ctx.strokeStyle = ac; ctx.lineWidth = 2; ctx.fillStyle = ac;
  ctx.globalAlpha = 0.12; ctx.fillRect(vx, vy, vp.w * s, vp.h * s); ctx.globalAlpha = 1;
  ctx.strokeRect(vx, vy, vp.w * s, vp.h * s);
}
const redraw = () => { if (!raf) raf = requestAnimationFrame(draw); };
for (const e of ['items', 'view', 'applyview', 'theme', 'cardsize', 'ready', 'minimap']) bus.on(e, redraw);

function at(ev) {
  const r = cv.getBoundingClientRect();
  const px = ((ev.clientX - r.left) / r.width) * W, py = ((ev.clientY - r.top) / r.height) * H;
  return { x: map.x0 + (px - map.ox) / map.s, y: map.y0 + (py - map.oy) / map.s };
}
cv.addEventListener('pointerdown', (e) => {
  if (!map) return;
  e.preventDefault();
  e.stopPropagation();
  cv.setPointerCapture(e.pointerId);
  lock = map;
  const p = at(e);
  centerOn(p.x, p.y, true);
  const mv = (ev) => { const q = at(ev); centerOn(q.x, q.y, true); };
  const up = () => { lock = null; redraw(); cv.removeEventListener('pointermove', mv); cv.removeEventListener('pointerup', up); };
  cv.addEventListener('pointermove', mv);
  cv.addEventListener('pointerup', up);
});
cv.addEventListener('wheel', (e) => e.stopPropagation());
redraw();
