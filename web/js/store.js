export const S = {
  items: new Map(),
  view: { x: 0, y: 0, k: 1 },
  z: 1,
  tool: 'select',
  sel: new Set(),
  pen: { color: 'auto', size: 4, alpha: 1 },
  eraser: { size: 28, whole: false },
  link: { color: 'auto', width: 2, arrow: true, dashed: false },
  ui: { theme: 'light', inkAbove: true, wheel: 'zoom', grid: false, minimap: true },
  filter: null,
  whisper: { model: 'small', lang: '' },
  project: { id: null, name: '' },
  projects: [],
  moved: false,
};

export const bus = (() => {
  const m = {};
  return {
    on(n, f) { (m[n] ||= []).push(f); },
    emit(n, a) { (m[n] || []).forEach((f) => f(a)); },
  };
})();

export const uid = () => Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4);
export const nextZ = () => ++S.z;
export const clone = (o) => structuredClone(o);
export const $ = (s, r = document) => r.querySelector(s);

const PREF_KEY = 'board.prefs.v1';
export function loadPrefs() {
  try {
    const p = JSON.parse(localStorage.getItem(PREF_KEY) || '{}');
    for (const k of ['pen', 'eraser', 'link', 'ui', 'whisper']) if (p[k]) Object.assign(S[k], p[k]);
  } catch { /* localStorage may be unavailable */ }
}
export function savePrefs() {
  try {
    localStorage.setItem(PREF_KEY, JSON.stringify({ pen: S.pen, eraser: S.eraser, link: S.link, ui: S.ui, whisper: S.whisper }));
  } catch { /* ignore */ }
}

export const toWorld = (sx, sy) => ({ x: (sx - S.view.x) / S.view.k, y: (sy - S.view.y) / S.view.k });
export const toScreen = (wx, wy) => ({ x: wx * S.view.k + S.view.x, y: wy * S.view.k + S.view.y });

// Call mark(id) before changing an object, and commit() after the gesture.
const pending = new Map();
const undoStack = [];
const redoStack = [];

export function mark(id) {
  if (pending.has(id)) return;
  const it = S.items.get(id);
  pending.set(id, it ? clone(it) : null);
}

export function commit() {
  if (!pending.size) return;
  const entry = [];
  for (const [id, before] of pending) {
    const cur = S.items.get(id);
    const after = cur ? clone(cur) : null;
    if (JSON.stringify(before) !== JSON.stringify(after)) entry.push({ id, before, after });
  }
  pending.clear();
  if (!entry.length) return;
  undoStack.push(entry);
  if (undoStack.length > 300) undoStack.shift();
  redoStack.length = 0;
  dirty();
  bus.emit('history');
}

// Fields that appear “on their own” (results of server/browser work) — undo does not roll them back.
const STICKY = ['transcript', 'tjob', 'peaks', 'ocr', 'ojob'];

function apply(entry, key) {
  const ids = [];
  for (const e of entry) {
    const st = e[key];
    if (st) {
      const n = clone(st);
      const cur = S.items.get(e.id);
      if (cur) for (const f of STICKY) if (f in cur) n[f] = cur[f]; else delete n[f];
      S.items.set(e.id, n);
    } else S.items.delete(e.id);
    ids.push(e.id);
  }
  for (const id of [...S.sel]) if (!S.items.has(id)) S.sel.delete(id);
  touch(ids);
  bus.emit('select');
  dirty();
  bus.emit('history');
}

export function undo() {
  commit();
  const e = undoStack.pop();
  if (!e) return;
  redoStack.push(e);
  apply(e, 'before');
}
export function redo() {
  const e = redoStack.pop();
  if (!e) return;
  undoStack.push(e);
  apply(e, 'after');
}
export const canUndo = () => undoStack.length > 0;
export const canRedo = () => redoStack.length > 0;

export function setSel(ids) { S.sel = new Set(ids); bus.emit('select'); }

export function touch(ids) { bus.emit('items', ids); }

let timer = null, saving = false, version = 0, savedVersion = 0;

export function dirty() {
  version++;
  bus.emit('save', 'dirty');
  clearTimeout(timer);
  timer = setTimeout(save, 700);
}
export const hasUnsaved = () => version !== savedVersion;

async function save() {
  if (saving) { timer = setTimeout(save, 300); return; }
  saving = true;
  const v = version;
  try {
    const body = JSON.stringify({ version: 1, view: S.view, z: S.z, items: [...S.items.values()] });
    const r = await fetch(`/api/projects/${S.project.id}/board`, {
      method: 'PUT',
      headers: { 'X-Board': '1', 'Content-Type': 'application/json' },
      body,
    });
    if (!r.ok) throw new Error(r.status);
    savedVersion = v;
    bus.emit('save', v === version ? 'saved' : 'dirty');
  } catch {
    bus.emit('save', 'error');
    clearTimeout(timer);
    timer = setTimeout(save, 3000);
  } finally {
    saving = false;
  }
}

export async function api(path, body, method = 'POST') {
  const r = await fetch(path, {
    method,
    headers: { 'X-Board': '1', 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(data.error || r.status), { confirm: data.confirm });
  return data;
}

export async function initProject() {
  S.projects = await (await fetch('/api/projects')).json();
  const want = new URLSearchParams(location.search).get('p');
  let last = null;
  try { last = localStorage.getItem('board.last'); } catch { /* ignore */ }
  let p = S.projects.find((x) => x.id === want) || S.projects.find((x) => x.id === last) || S.projects[0];
  if (!p) {
    p = await api('/api/projects', { name: 'Main' });
    S.projects = [p];
  }
  S.project = { id: p.id, name: p.name };
  try { localStorage.setItem('board.last', p.id); } catch { /* ignore */ }
  const hm = /^#card=([\w-]+)(?:&t=(\d+(?:\.\d+)?))?$/.exec(location.hash);
  if (hm) S.pendingCard = { cid: hm[1], t: hm[2] != null ? +hm[2] : null };
  history.replaceState(null, '', '?p=' + p.id);
  document.title = p.name + ' — Board';
}

export async function load() {
  const r = await fetch(`/api/projects/${S.project.id}/board`);
  const b = await r.json();
  for (const it of b.items || []) {
    S.items.set(it.id, it);
    if (typeof it.z === 'number') S.z = Math.max(S.z, it.z);
  }
  S.z = Math.max(S.z, b.z || 0);
  if (b.view) Object.assign(S.view, b.view);
}

export async function flush() {
  clearTimeout(timer);
  for (let i = 0; i < 40 && hasUnsaved(); i++) {
    await save();
    if (hasUnsaved()) await new Promise((r) => setTimeout(r, 150));
  }
}

export function viewChanged() {
  version++;
  clearTimeout(timer);
  timer = setTimeout(save, 1500);
}

export function toast(msg, ms = 2500) {
  const t = $('#toast');
  const d = document.createElement('div');
  d.textContent = msg;
  t.appendChild(d);
  setTimeout(() => d.remove(), ms);
}
