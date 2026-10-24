// No auto-refresh: only manual (↻ on the card), undoable with Ctrl+Z.
import { S, bus, uid, nextZ, mark, commit, touch, dirty, setSel, api, toast } from './store.js';
import { createCard, defaultSize } from './cards.js';

S.fetching = new Set();
const jobs = new Map();
const URL_RE = /^https?:\/\/[^\s]+$/i;
export const isUrl = (s) => URL_RE.test((s || '').trim());

export function parseBoardRef(url) {
  try {
    const u = new URL(url);
    if (u.origin !== location.origin) return null;
    const pid = u.searchParams.get('p');
    const m = /^#card=([\w-]+)(?:&t=(\d+(?:\.\d+)?))?$/.exec(u.hash);
    if (!pid || !/^[\w-]+$/.test(pid) || !m) return null;
    return { pid, cid: m[1], t: m[2] != null ? +m[2] : null };
  } catch { return null; }
}
export const cardLink = (id) => `${location.origin}/?p=${S.project.id}#card=${id}`;

const KEEP_ON_REFRESH = ['id', 'kind', 'x', 'y', 'z', 'tags', 'accent'];

function imageSize(url) {
  return new Promise((res) => {
    const i = new Image();
    i.onload = () => res({ w: i.naturalWidth, h: i.naturalHeight });
    i.onerror = () => res(null);
    i.src = url;
  });
}

async function applyResult(id, res, refresh) {
  const old = S.items.get(id);
  if (!old) return;
  const n = {};
  for (const k of KEEP_ON_REFRESH) n[k] = old[k];
  Object.assign(n, res);
  const dflt = defaultSize(res.type);
  n.w = refresh && old.type === res.type ? old.w : dflt.w;
  if (res.type === 'image' && res.url) {
    const s = await imageSize(res.url);
    if (s) { n.ar = s.w / s.h; if (!(refresh && old.type === 'image')) n.w = Math.min(s.w, 480); }
  }
  if (res.type === 'embed' && res.h) n.h = res.h;
  if (old.url && old.url === res.url) for (const k of ['transcript', 'peaks', 'start', 'end', 'color']) if (old[k] !== undefined) n[k] = old[k];
  S.items.set(id, n);
}

function finish(id) {
  const j = jobs.get(id);
  if (j) clearTimeout(j.timer);
  jobs.delete(id);
  S.fetching.delete(id);
  bus.emit('fetchstate', { id, pct: null });
}

function poll(id, jid, refresh) {
  const j = { jid, timer: 0 };
  jobs.set(id, j);
  S.fetching.add(id);
  const tick = async () => {
    if (jobs.get(id) !== j) return;
    if (!S.items.has(id)) { fetch(`/api/fetch/${jid}/cancel`, { method: 'POST', headers: { 'X-Board': '1' } }); return finish(id); }
    try {
      const st = await (await fetch(`/api/fetch/${jid}`)).json();
      if (jobs.get(id) !== j) return;
      const pct = st.total ? st.bytes / st.total : 0;
      if (st.status === 'done') {
        if (refresh) mark(id);
        await applyResult(id, st.result, refresh);
        if (refresh) commit();
        finish(id);
        touch([id]);
        dirty();
        return;
      }
      if (st.status === 'error' || st.status === 'cancelled') {
        finish(id);
        failCard(id, st.status === 'cancelled' ? 'cancelled' : st.error || 'download failed', refresh);
        return;
      }
      const it = S.items.get(id);
      if (it && !refresh) { it.progress = pct; touch([id]); }
      bus.emit('fetchstate', { id, pct: refresh ? pct || 0.02 : null });
    } catch (e) {
      finish(id);
      failCard(id, 'no connection to the server', refresh);
      return;
    }
    j.timer = setTimeout(tick, 500);
  };
  j.timer = setTimeout(tick, 250);
}

// Failure: a new card keeps a bookmark with just the link; a card being refreshed keeps its previous snapshot.
function failCard(id, msg, refresh) {
  const it = S.items.get(id);
  if (!it) return;
  if (refresh) { if (msg !== 'cancelled') toast('Refresh failed: ' + msg + ' — the previous copy was kept', 5000); return; }
  if (msg === 'cancelled') {
    S.items.delete(id);
    touch([id]);
    dirty();
    return;
  }
  const n = { ...it, loading: false, progress: 0, error: msg };
  delete n.fid;
  S.items.set(id, n);
  touch([id]);
  dirty();
  toast('Link saved without a snapshot: ' + msg, 4500);
}

export async function addUrl(url, at) {
  url = url.trim();
  const ref = parseBoardRef(url);
  if (ref) return addRef(ref.pid, ref.cid, at);
  const id = createCard('link', { href: url, loading: true, progress: 0 }, at);
  S.fetching.add(id);
  touch([id]);
  try {
    const st = await api('/api/fetch', { url });
    poll(id, st.id, false);
  } catch (e) {
    S.fetching.delete(id);
    failCard(id, e.message, false);
  }
  return id;
}

export async function addUrls(urls, at) {
  const ids = [];
  let i = 0;
  for (const u of urls) {
    ids.push(await addUrl(u, { x: at.x + i * 380, y: at.y }));
    i++;
  }
  setSel(ids.filter(Boolean));
  return ids;
}

export async function refreshCard(id) {
  const it = S.items.get(id);
  const url = it && (it.src || it.href);
  if (!url || jobs.has(id)) return;
  try {
    const st = await api('/api/fetch', { url });
    bus.emit('fetchstate', { id, pct: 0.02 });
    poll(id, st.id, true);
  } catch (e) { toast('Refresh failed: ' + e.message, 4000); }
}

export function cancelFetch(id) {
  const j = jobs.get(id);
  if (!j) return;
  fetch(`/api/fetch/${j.jid}/cancel`, { method: 'POST', headers: { 'X-Board': '1' } });
  const it = S.items.get(id);
  const refresh = !it?.loading;
  finish(id);
  failCard(id, 'cancelled', refresh);
  if (refresh) bus.emit('fetchstate', { id, pct: null });
}

export function addRef(pid, cid, at) {
  const here = pid === S.project.id;
  const tgt = here ? S.items.get(cid) : null;
  const pr = S.projects.find((p) => p.id === pid);
  const label = tgt ? labelFor(tgt) : '';
  return createCard('ref', { pid, cid, label, pname: pr ? pr.name : pid }, at);
}
import { labelOf } from './cards.js';
const labelFor = labelOf;
