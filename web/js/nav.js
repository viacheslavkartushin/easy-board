import { S, bus, $, setSel, viewChanged, toast, flush } from './store.js';
import { rectOf, cardEl, bringToFront } from './cards.js';

let anim = 0;

function animateTo(t, dur = 420) {
  const v0 = { ...S.view }, t0 = performance.now();
  cancelAnimationFrame(anim);
  const step = (now) => {
    const p = Math.min(1, (now - t0) / dur), q = 1 - Math.pow(1 - p, 3);
    S.view.k = v0.k + (t.k - v0.k) * q;
    S.view.x = v0.x + (t.x - v0.x) * q;
    S.view.y = v0.y + (t.y - v0.y) * q;
    bus.emit('applyview');
    if (p < 1) anim = requestAnimationFrame(step); else viewChanged();
  };
  anim = requestAnimationFrame(step);
}

export function flyToRect(r, { minK = 0.15, maxK = 1.5, fill = 0.7 } = {}) {
  const st = $('#stage').getBoundingClientRect();
  const k = Math.min(maxK, Math.max(minK, Math.min((st.width * fill) / r.w, (st.height * fill) / r.h)));
  animateTo({ k, x: st.width / 2 - (r.x + r.w / 2) * k, y: st.height / 2 - (r.y + r.h / 2) * k });
}
export function centerOn(x, y, instant = false) {
  const st = $('#stage').getBoundingClientRect();
  const t = { k: S.view.k, x: st.width / 2 - x * S.view.k, y: st.height / 2 - y * S.view.k };
  if (instant) { Object.assign(S.view, t); bus.emit('applyview'); viewChanged(); } else animateTo(t, 250);
}

export function flyTo(id, { t = null } = {}) {
  const it = S.items.get(id);
  if (!it || it.kind !== 'card') { toast('Card not found — it may have been deleted', 3000); return false; }
  const r = rectOf(id);
  flyToRect(r, { maxK: 1.5, minK: 0.15, fill: 0.7 });
  setSel([id]);
  bringToFront(id);
  const el = cardEl(id);
  if (el) { el.classList.remove('pulse'); void el.offsetWidth; el.classList.add('pulse'); setTimeout(() => el.classList.remove('pulse'), 2000); }
  if (t != null) setTimeout(() => bus.emit('seek', { id, t }), 450);
  return true;
}

export async function goRef(ref) {
  if (!ref) return;
  if (ref.pid === S.project.id) { flyTo(ref.cid, { t: ref.t ?? null }); return; }
  await flush();
  location.href = `/?p=${encodeURIComponent(ref.pid)}#card=${encodeURIComponent(ref.cid)}${ref.t != null ? '&t=' + ref.t : ''}`;
}

export const parseHash = (h) => {
  const m = /^#card=([\w-]+)(?:&t=(\d+(?:\.\d+)?))?$/.exec(h || '');
  return m ? { cid: m[1], t: m[2] != null ? +m[2] : null } : null;
};
