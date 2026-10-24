import {
  S, bus, $, uid, nextZ, mark, commit, touch, dirty, setSel, toWorld, undo, redo, canUndo, canRedo,
  loadPrefs, savePrefs, load, viewChanged, hasUnsaved, toast, initProject, flush,
} from './store.js';
import { initProjectsUI } from './projects.js';
import { I } from './icons.js';
import { beginPen, beginErase, setAutoColor, requestDraw } from './ink.js';
import {
  createCard, syncAll, setEditing, editing, EDITABLE, NOTE_COLORS, hitCard, cardsInRect, cardEl,
  bringToFront, contentBounds, rectOf, defaultSize, playEmbed, assetOk, safeHref, embedOk, labelOf,
  editFrameTitle, FRAME_COLORS, ACCENTS,
} from './cards.js';
import { expandWithFrames, snapDelta, clearGuides, align, distribute, wrapInFrame } from './layout.js';
import { beginLink, renderAll as renderLinks } from './links.js';
import { addFiles } from './files.js';
import { flyTo, goRef, parseHash } from './nav.js';
import './search.js';
import './minimap.js';
import './export.js';
import './models.js';
import { addUrls, isUrl, refreshCard, cancelFetch, cardLink, parseBoardRef } from './urls.js';

const stage = $('#stage');
const world = $('#world');
const INK_COLORS = ['auto', '#e03131', '#f76707', '#f59f00', '#2f9e44', '#0c8599', '#1971c2', '#7048e8', '#c2255c', '#868e96', '#ffffff'];

function applyTheme() {
  document.documentElement.dataset.theme = S.ui.theme;
  stage.classList.toggle('ink-below', !S.ui.inkAbove);
  setAutoColor(getComputedStyle(document.documentElement).getPropertyValue('--ink').trim() || '#1f2328');
  bus.emit('theme');
  renderTop();
}

function applyView() {
  const { x, y, k } = S.view;
  world.style.transform = `translate(${x}px,${y}px) scale(${k})`;
  let step = 28;
  while (step * k < 16) step *= 4;
  stage.style.backgroundSize = `${step * k}px ${step * k}px`;
  stage.style.backgroundPosition = `${x}px ${y}px`;
  $('#zoomval').textContent = Math.round(k * 100) + '%';
  bus.emit('view');
}
function zoomAt(sx, sy, factor) {
  const v = S.view;
  const k = Math.min(6, Math.max(0.04, v.k * factor));
  const f = k / v.k;
  v.x = sx - (sx - v.x) * f;
  v.y = sy - (sy - v.y) * f;
  v.k = k;
  applyView();
  viewChanged();
}
const stageCenter = () => { const r = stage.getBoundingClientRect(); return { x: r.width / 2, y: r.height / 2 }; };
function fitAll() {
  const b = contentBounds();
  const r = stage.getBoundingClientRect();
  if (!b) { S.view.k = 1; S.view.x = r.width / 2; S.view.y = r.height / 2; }
  else {
    const pad = 80;
    const k = Math.min(2, (r.width - pad * 2) / Math.max(1, b.x1 - b.x0), (r.height - pad * 2) / Math.max(1, b.y1 - b.y0));
    S.view.k = Math.max(0.04, k);
    S.view.x = r.width / 2 - ((b.x0 + b.x1) / 2) * S.view.k;
    S.view.y = r.height / 2 - ((b.y0 + b.y1) / 2) * S.view.k;
  }
  applyView();
  viewChanged();
}
function viewCenterWorld(dx = 0, dy = 0) {
  const c = stageCenter();
  const p = toWorld(c.x + dx, c.y + dy);
  return p;
}

function drag(e, h) {
  const p0 = { x: e.clientX, y: e.clientY };
  const id = e.pointerId;
  const mv = (ev) => {
    if (ev.pointerId !== id) return;
    if (!S.moved && Math.hypot(ev.clientX - p0.x, ev.clientY - p0.y) > 3) S.moved = true;
    h.move?.(ev);
  };
  const up = (ev) => {
    if (ev.pointerId !== id) return;
    window.removeEventListener('pointermove', mv);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('pointercancel', up);
    h.up?.(ev);
  };
  window.addEventListener('pointermove', mv);
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', up);
}

let spaceDown = false;

function pan(e) {
  const v0 = { ...S.view };
  const p0 = { x: e.clientX, y: e.clientY };
  stage.classList.add('panning');
  drag(e, {
    move(ev) { S.view.x = v0.x + ev.clientX - p0.x; S.view.y = v0.y + ev.clientY - p0.y; applyView(); },
    up() { stage.classList.remove('panning'); viewChanged(); },
  });
}

function beginMove(e) {
  const base = [...S.sel].filter((i) => S.items.get(i)?.kind === 'card');
  const ids = expandWithFrames(base);
  const starts = ids.map((id) => ({ id, x: S.items.get(id).x, y: S.items.get(id).y }));
  const rects = ids.map((id) => ({ ...rectOf(id), x: S.items.get(id).x, y: S.items.get(id).y }));
  ids.forEach(mark);
  const p0 = { x: e.clientX, y: e.clientY };
  drag(e, {
    move(ev) {
      const raw = { dx: (ev.clientX - p0.x) / S.view.k, dy: (ev.clientY - p0.y) / S.view.k };
      const { dx, dy } = S.moved ? snapDelta(ids, rects, raw.dx, raw.dy, ev.altKey) : raw;
      for (const s of starts) { const it = S.items.get(s.id); it.x = Math.round(s.x + dx); it.y = Math.round(s.y + dy); }
      touch(ids);
    },
    up() { clearGuides(); commit(); if (S.moved) dirty(); },
  });
}

function beginResize(e, id) {
  const it = S.items.get(id);
  const w0 = it.w, h0 = it.h, p0 = { x: e.clientX, y: e.clientY };
  const minW = it.type === 'audio' || it.type === 'video' ? 280 : 100;
  mark(id);
  drag(e, {
    move(ev) {
      it.w = Math.max(minW, Math.round(w0 + (ev.clientX - p0.x) / S.view.k));
      if (h0 != null) it.h = Math.max(60, Math.round(h0 + (ev.clientY - p0.y) / S.view.k));
      touch([id]);
    },
    up() { commit(); },
  });
}

function beginMarquee(e) {
  const additive = e.shiftKey;
  if (!additive) setSel([]);
  const base = new Set(S.sel);
  const box = $('#marquee');
  const r0 = stage.getBoundingClientRect();
  const p0 = { x: e.clientX, y: e.clientY };
  drag(e, {
    move(ev) {
      if (!S.moved) return;
      const x0 = Math.min(p0.x, ev.clientX), y0 = Math.min(p0.y, ev.clientY);
      const x1 = Math.max(p0.x, ev.clientX), y1 = Math.max(p0.y, ev.clientY);
      Object.assign(box.style, { display: 'block', left: x0 - r0.left + 'px', top: y0 - r0.top + 'px', width: x1 - x0 + 'px', height: y1 - y0 + 'px' });
      const a = toWorld(x0, y0), b = toWorld(x1, y1);
      const ids = new Set([...base, ...cardsInRect(a.x, a.y, b.x, b.y)]);
      if (ids.size !== S.sel.size || [...ids].some((i) => !S.sel.has(i))) setSel([...ids]);
    },
    up() { box.style.display = 'none'; },
  });
}

let downAt = { x: 0, y: 0 };
stage.addEventListener('pointerdown', (e) => {
  S.moved = false;
  downAt = { x: e.clientX, y: e.clientY };
  const t = e.target;
  const typing = t.closest('input,textarea,select');
  if (!typing) document.activeElement?.blur?.();
  if (e.button === 1 || (e.button === 0 && (S.tool === 'hand' || spaceDown))) { e.preventDefault(); return pan(e); }
  if (e.button !== 0) return;
  closeMenus();

  if (S.tool === 'pen') { e.preventDefault(); if (S.sel.size) setSel([]); return beginPen(e, (h) => drag(e, h)); }
  if (S.tool === 'eraser') { e.preventDefault(); if (S.sel.size) setSel([]); return beginErase(e, (h) => drag(e, h)); }
  if (S.tool === 'link') {
    const p = toWorld(e.clientX, e.clientY);
    const id = hitCard(p.x, p.y);
    if (id) { e.preventDefault(); return beginLink(e, id, (h) => drag(e, h)); }
  }

  const cardNode = t.closest('.card');
  const linkNode = t.closest('[data-link]');
  if (cardNode && t.closest('.rs')) { e.preventDefault(); return beginResize(e, cardNode.dataset.id); }
  if (cardNode && t.closest('.ld')) { e.preventDefault(); return beginLink(e, cardNode.dataset.id, (h) => drag(e, h)); }
  if (linkNode) {
    const id = linkNode.dataset.link;
    if (e.shiftKey) { const s = new Set(S.sel); s.has(id) ? s.delete(id) : s.add(id); setSel([...s]); } else setSel([id]);
    return;
  }
  if (cardNode) {
    const id = cardNode.dataset.id;
    const it = S.items.get(id);
    const wasSel = S.sel.has(id);
    if (e.shiftKey) { const s = new Set(S.sel); s.has(id) ? s.delete(id) : s.add(id); setSel([...s]); return; }
    if (!wasSel) setSel([id]);
    bringToFront(id);
    if ((it.type === 'pdf' || it.type === 'embed') && wasSel && !cardNode.classList.contains('live') && t.closest('.shield')) {
      cardNode.classList.add('live');
      return;
    }
    const interactive = t.closest('button,input,select,textarea,a,video,iframe,[data-nodrag]');
    const inEditBody = editing.has(id) && t.closest('.body');
    if (interactive || inEditBody) return;
    e.preventDefault();
    return beginMove(e);
  }
  e.preventDefault();
  beginMarquee(e);
});

stage.addEventListener('dblclick', (e) => {
  if (S.tool !== 'select') return;
  const card = e.target.closest('.card');
  if (card) {
    const id = card.dataset.id;
    if (S.items.get(id).type === 'frame') { if (e.target.closest('.fr-title')) editFrameTitle(id); return; }
    if (EDITABLE.has(S.items.get(id).type) && !e.target.closest('button,input,[data-nodrag]')) setEditing(id, true);
    return;
  }
  if (e.target.closest('[data-link]')) { $('#props input[data-k="label"]')?.focus(); return; }
  const p = toWorld(e.clientX, e.clientY);
  createCard('text', {}, p, { edit: true });
});

stage.addEventListener('click', (e) => {
  const b = e.target.closest('[data-act]');
  if (!b) return;
  const id = b.closest('.card')?.dataset.id;
  if (!id) return;
  const act = b.dataset.act;
  if (act === 'edit') setEditing(id, !editing.has(id));
  else if (act === 'dup') duplicate([id]);
  else if (act === 'del') deleteIds([id]);
  else if (act === 'open') { const u = safeHref(S.items.get(id).src || S.items.get(id).href); if (u) window.open(u, '_blank', 'noopener,noreferrer'); }
  else if (act === 'refresh') refreshCard(id);
  else if (act === 'cancelfetch') cancelFetch(id);
  else if (act === 'play') playEmbed(id);
  else if (act === 'go') { if (!S.moved && Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) < 5) goRef(S.items.get(id)); }
  else if (act === 'reflink') {
    const link = cardLink(id);
    (navigator.clipboard?.writeText(link) || Promise.reject()).then(() => toast('Card link copied — paste it onto the board', 2200), () => prompt('Card link:', link));
  } else if (act === 'copy') {
    navigator.clipboard?.writeText(S.items.get(id).text || '').then(() => toast('Code copied', 1200));
  }
});

stage.addEventListener('wheel', (e) => {
  const sc = e.target.closest('.card.selected .scroll');
  if (sc && !e.ctrlKey && sc.scrollHeight > sc.clientHeight + 1) return;
  e.preventDefault();
  let dx = e.deltaX, dy = e.deltaY;
  if (e.deltaMode === 1) { dx *= 16; dy *= 16; }
  if (!e.ctrlKey && (e.shiftKey || S.ui.wheel === 'pan')) {
    S.view.x -= e.shiftKey && !dx ? dy : dx;
    if (!e.shiftKey) S.view.y -= dy;
    applyView();
    viewChanged();
  } else {
    zoomAt(e.clientX, e.clientY, Math.exp(-dy * (e.ctrlKey ? 0.01 : 0.0016)));
  }
}, { passive: false });

stage.addEventListener('contextmenu', (e) => { if (S.tool !== 'select') e.preventDefault(); });
stage.addEventListener('auxclick', (e) => e.preventDefault());

const brush = $('#brush');
let lastPointer = null;
function updateBrush(e) {
  if (e) lastPointer = { x: e.clientX, y: e.clientY };
  const show = (S.tool === 'pen' || S.tool === 'eraser') && lastPointer && !spaceDown;
  brush.style.display = show ? 'block' : 'none';
  if (!show) return;
  const d = S.tool === 'pen' ? Math.max(3, S.pen.size * S.view.k) : S.eraser.size;
  const r = stage.getBoundingClientRect();
  Object.assign(brush.style, { width: d + 'px', height: d + 'px', left: lastPointer.x - r.left + 'px', top: lastPointer.y - r.top + 'px' });
  brush.classList.toggle('eraser', S.tool === 'eraser');
}
stage.addEventListener('pointermove', updateBrush);
stage.addEventListener('pointerleave', () => { lastPointer = null; updateBrush(); });

function deleteIds(ids) {
  const set = new Set(ids);
  for (const l of S.items.values()) if (l.kind === 'link' && (set.has(l.from) || set.has(l.to))) set.add(l.id);
  const all = [...set].filter((i) => S.items.has(i));
  if (!all.length) return;
  all.forEach(mark);
  for (const id of all) { S.items.delete(id); S.sel.delete(id); editing.delete(id); }
  commit();
  touch(all);
  bus.emit('select');
}
function duplicate(ids) {
  const map = new Map();
  const made = [];
  for (const id of ids) {
    const it = S.items.get(id);
    if (!it || it.kind !== 'card') continue;
    const n = { ...structuredClone(it), id: uid(), x: it.x + 28, y: it.y + 28, z: nextZ() };
    map.set(id, n.id);
    mark(n.id);
    S.items.set(n.id, n);
    made.push(n.id);
  }
  for (const l of [...S.items.values()]) {
    if (l.kind === 'link' && map.has(l.from) && map.has(l.to)) {
      const n = { ...structuredClone(l), id: uid(), from: map.get(l.from), to: map.get(l.to) };
      mark(n.id);
      S.items.set(n.id, n);
      made.push(n.id);
    }
  }
  commit();
  touch(made);
  setSel(made.filter((i) => S.items.get(i).kind === 'card'));
}

window.addEventListener('keydown', (e) => {
  const typing = e.target.closest?.('input,textarea,select,[contenteditable="true"]');
  if (e.code === 'Space' && !typing) {
    if (!spaceDown) { spaceDown = true; stage.classList.add('space'); updateBrush(); }
    e.preventDefault();
    return;
  }
  if (typing) return;
  const ctrl = e.ctrlKey || e.metaKey;
  if (ctrl && e.code === 'KeyZ') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
  if (ctrl && e.code === 'KeyY') { e.preventDefault(); redo(); return; }
  if (ctrl && e.code === 'KeyD') { e.preventDefault(); duplicate([...S.sel]); return; }
  if (ctrl && e.code === 'KeyA') { e.preventDefault(); setSel([...S.items.values()].filter((i) => i.kind === 'card').map((i) => i.id)); return; }
  if (ctrl && e.code === 'KeyK') { e.preventDefault(); toggleUrlbar(true); return; }
  if (ctrl) return;
  switch (e.code) {
    case 'Delete': case 'Backspace': deleteIds([...S.sel]); break;
    case 'Escape':
      if (editing.size) [...editing].forEach((id) => setEditing(id, false));
      else if (S.sel.size) setSel([]);
      else setTool('select');
      break;
    case 'KeyV': setTool('select'); break;
    case 'KeyH': setTool('hand'); break;
    case 'KeyP': case 'KeyB': setTool('pen'); break;
    case 'KeyE': setTool('eraser'); break;
    case 'KeyL': setTool('link'); break;
    case 'KeyF': fitAll(); break;
    case 'Digit0': { const c = stageCenter(); zoomAt(c.x, c.y, 1 / S.view.k); break; }
    case 'Equal': case 'NumpadAdd': { const c = stageCenter(); zoomAt(c.x, c.y, 1.25); break; }
    case 'Minus': case 'NumpadSubtract': { const c = stageCenter(); zoomAt(c.x, c.y, 0.8); break; }
    default: return;
  }
});
window.addEventListener('keyup', (e) => {
  if (e.code === 'Space') {
    if (!e.target.closest?.('input,textarea,select')) e.preventDefault(); spaceDown = false; stage.classList.remove('space'); updateBrush(); }
});
window.addEventListener('blur', () => { spaceDown = false; stage.classList.remove('space'); });

function pasteAt() {
  if (lastPointer) return toWorld(lastPointer.x, lastPointer.y);
  return viewCenterWorld(-120, -80);
}
async function addAndSelect(files, at) {
  const ids = await addFiles(files, at);
  if (ids.length) setSel(ids);
}
// Clipboard: custom MIME + text, mirrored in localStorage so cards move between projects/tabs
const CLIP_KEY = 'board.clip';
const KEEP = ['type', 'x', 'y', 'w', 'h', 'color', 'text', 'fs', 'lang', 'url', 'name', 'size', 'ar', 'start', 'end', 'peaks', 'transcript', 'href', 'src', 'title', 'desc', 'site', 'thumb', 'favicon', 'fetched', 'embed', 'provider', 'author', 'pid', 'cid', 'label', 'pname', 'error', 'tags', 'accent', 'archive', 'ocr'];
const CARD_TYPES = new Set(['note', 'text', 'md', 'code', 'image', 'pdf', 'audio', 'video', 'file', 'link', 'embed', 'ref', 'frame']);
const ASSET_URL = /^\/assets\/[0-9a-f]{24}(\.[a-z0-9]{1,8})?$/;

function buildClip() {
  const cards = [...S.sel].map((id) => S.items.get(id)).filter((i) => i?.kind === 'card');
  if (!cards.length) return null;
  const ids = new Set(cards.map((c) => c.id));
  const links = [...S.items.values()].filter((l) => l.kind === 'link' && ids.has(l.from) && ids.has(l.to));
  const data = { v: 1, cards: structuredClone(cards), links: structuredClone(links) };
  for (const c of data.cards) delete c.tjob;
  const single = cards.length === 1 && ['note', 'text', 'md', 'code'].includes(cards[0].type) ? cards[0].text : null;
  const plain = single ?? cards.map((c) => (c.name ? `${c.type}: ${c.name}` : c.type)).join(', ');
  return { data, plain };
}
function onCopy(e, cut) {
  if (e.target.closest?.('input,textarea,select') || !S.sel.size) return;
  const clip = buildClip();
  if (!clip) return;
  e.preventDefault();
  e.clipboardData.setData('text/plain', clip.plain);
  e.clipboardData.setData('application/x-board+json', JSON.stringify(clip.data));
  try { localStorage.setItem(CLIP_KEY, JSON.stringify(clip)); } catch { }
  if (cut) deleteIds(clip.data.cards.map((c) => c.id));
  else toast(clip.data.cards.length > 1 ? `Cards copied: ${clip.data.cards.length}` : 'Copied', 1000);
}
document.addEventListener('copy', (e) => onCopy(e, false));
document.addEventListener('cut', (e) => onCopy(e, true));

let pasteN = 0, lastPasteAt = null;
function pasteBoard(data, at) {
  const cardOk = (c) => c && CARD_TYPES.has(c.type) && (!c.url || ASSET_URL.test(c.url)) &&
    (!c.thumb || assetOk(c.thumb)) && (!c.archive || assetOk(c.archive)) && (!c.favicon || assetOk(c.favicon)) &&
    (!c.embed || embedOk(c.embed)) && (!c.href || safeHref(c.href)) && (!c.src || safeHref(c.src)) &&
    (c.type !== 'ref' || (/^[\w-]+$/.test(c.pid || '') && /^[\w-]+$/.test(c.cid || '')));
  const cards = (data.cards || []).filter(cardOk);
  if (!cards.length) return false;
  if (lastPasteAt && Math.hypot(lastPasteAt.x - at.x, lastPasteAt.y - at.y) < 6) pasteN++; else pasteN = 0;
  lastPasteAt = at;
  const minX = Math.min(...cards.map((c) => +c.x || 0)), minY = Math.min(...cards.map((c) => +c.y || 0));
  const map = new Map();
  const made = [];
  cards.sort((a, b) => (a.z || 0) - (b.z || 0));
  for (const c of cards) {
    const n = { kind: 'card', id: uid(), z: nextZ() };
    for (const k of KEEP) if (c[k] !== undefined) n[k] = structuredClone(c[k]);
    n.x = Math.round(at.x + (n.x - minX) + pasteN * 28);
    n.y = Math.round(at.y + (n.y - minY) + pasteN * 28);
    delete n.loading;
    n.w = Math.max(60, +n.w || 300);
    if (n.h != null) n.h = Math.max(40, +n.h || 200);
    map.set(c.id, n.id);
    mark(n.id);
    S.items.set(n.id, n);
    made.push(n.id);
  }
  for (const l of data.links || []) {
    if (!map.has(l.from) || !map.has(l.to)) continue;
    const n = { kind: 'link', id: uid(), z: nextZ(), from: map.get(l.from), to: map.get(l.to), color: String(l.color || 'auto'), width: +l.width || 2, arrow: l.arrow !== false, dashed: !!l.dashed, label: String(l.label || '') };
    mark(n.id);
    S.items.set(n.id, n);
    made.push(n.id);
  }
  commit();
  touch(made);
  setSel(made.filter((i) => S.items.get(i).kind === 'card'));
  return true;
}

window.addEventListener('paste', (e) => {
  if (e.target.closest?.('input,textarea,select')) return;
  const cd = e.clipboardData;
  if (!cd) return;
  let data = null;
  try { const raw = cd.getData('application/x-board+json'); if (raw) data = JSON.parse(raw); } catch { }
  if (!data) {
    try {
      const rec = JSON.parse(localStorage.getItem(CLIP_KEY) || 'null');
      const t = cd.getData('text/plain');
      if (rec && t && rec.plain === t) data = rec.data;
    } catch { }
  }
  if (data && pasteBoard(data, pasteAt())) { e.preventDefault(); return; }
  const files = [...cd.files];
  if (files.length) { e.preventDefault(); addAndSelect(files, pasteAt()); return; }
  const text = cd.getData('text/plain');
  const toks = text.trim().split(/\s+/);
  if (toks.length <= 20 && toks.every(isUrl)) { e.preventDefault(); addUrls(toks, pasteAt()); return; }
  if (text.trim()) {
    e.preventDefault();
    const multi = text.trim().includes('\n');
    createCard(multi ? 'note' : 'text', { text: multi ? text : text.trim() }, pasteAt());
  }
});
stage.addEventListener('dragover', (e) => { const ty = [...(e.dataTransfer?.types || [])]; if (ty.includes('Files') || ty.includes('text/uri-list')) { e.preventDefault(); stage.classList.add('drop'); } });
stage.addEventListener('dragleave', () => stage.classList.remove('drop'));
stage.addEventListener('drop', (e) => {
  stage.classList.remove('drop');
  const files = [...(e.dataTransfer?.files || [])];
  if (!files.length) {
    const urls = (e.dataTransfer?.getData('text/uri-list') || '').split(/\r?\n/).filter((l) => l && !l.startsWith('#') && isUrl(l));
    if (urls.length) { e.preventDefault(); addUrls(urls.slice(0, 20), toWorld(e.clientX, e.clientY)); }
    return;
  }
  e.preventDefault();
  addAndSelect(files, toWorld(e.clientX, e.clientY));
});
const picker = $('#filepick');
picker.addEventListener('change', () => {
  const files = [...picker.files];
  picker.value = '';
  if (files.length) addAndSelect(files, viewCenterWorld(-120, -80));
});

const urlbar = $('#urlbar');
urlbar.innerHTML = `<input type="url" placeholder="Paste a link: page, YouTube, file, card address…" spellcheck="false"><button class="go">Add</button><button class="x" title="Close (Esc)">✕</button>`;
const urlin = urlbar.querySelector('input');
function toggleUrlbar(on = !urlbar.classList.contains('open')) {
  urlbar.classList.toggle('open', on);
  if (on) { urlin.value = ''; urlin.focus(); }
  renderTools();
}
function submitUrl() {
  const toks = urlin.value.trim().split(/\s+/).filter(Boolean).map((u) => (/^https?:\/\//i.test(u) ? u : 'https://' + u));
  if (!toks.length || !toks.every(isUrl)) { toast('Enter a link like https://…', 2000); return; }
  addUrls(toks.slice(0, 20), freeSpot('embed'));
  toggleUrlbar(false);
}
urlbar.addEventListener('click', (e) => { if (e.target.closest('.go')) submitUrl(); else if (e.target.closest('.x')) toggleUrlbar(false); });
urlin.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') submitUrl(); else if (e.key === 'Escape') toggleUrlbar(false); });

bus.on('ocrnote', ({ id, text }) => {
  if (!text.trim()) { toast('No text', 1500); return; }
  const r = rectOf(id);
  createCard('note', { text, w: Math.max(260, Math.min(420, r.w)), h: 240 }, { x: r.x + r.w + 40, y: r.y });
});

bus.on('quote', ({ id, name, segs }) => {
  const src = S.items.get(id);
  if (!src || !segs.length) return;
  const tc = (t) => { t = Math.floor(t); const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60; return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(s).padStart(2, '0'); };
  const base = `${location.origin}/?p=${S.project.id}#card=${id}`;
  const lines = segs.map((s) => `- [${tc(s[0])}](${base}&t=${Math.floor(s[0])}) ${s[2]}`);
  const r = rectOf(id);
  const text = `### Quotes: ${name || 'recording'}\n\n${lines.join('\n')}\n`;
  createCard('md', { text, w: 380, h: Math.min(520, 90 + segs.length * 46) }, { x: r.x + r.w + 40, y: r.y });
  toast('Quotes note created — timecodes link to the spot in the recording', 2600);
});

bus.on('applyview', applyView);
bus.on('fitall', fitAll);
window.addEventListener('hashchange', () => {
  const h = parseHash(location.hash);
  if (h) { flyTo(h.cid, { t: h.t }); history.replaceState(null, '', location.pathname + location.search); }
});
document.addEventListener('click', (e) => {
  const a = e.target.closest('a[href]');
  if (!a || !a.closest('.card')) return;
  const ref = parseBoardRef(a.href);
  if (ref) { e.preventDefault(); goRef(ref); }
});

const TOOLS = [
  ['select', 'Select / move (V)'], ['hand', 'Hand — pan the canvas (H, or Space / wheel)'],
  ['pen', 'Brush (P)'], ['eraser', 'Eraser (E)'], ['link', 'Connection between cards (L)'],
];
const ADD = [
  ['note', 'Note'], ['text', 'Text'], ['md', 'Markdown'], ['code', 'Code'], ['frame', 'Frame (group of cards)'],
];
function freeSpot(type) {
  const { w, h } = defaultSize(type);
  const c = viewCenterWorld();
  const rects = [...S.items.values()].filter((i) => i.kind === 'card').map((i) => rectOf(i.id));
  const gap = 24;
  for (let i = 0; i < 60; i++) {
    const col = i % 4, row = Math.floor(i / 4);
    const x = c.x - w / 2 + (col % 2 ? 1 : -1) * Math.ceil(col / 2) * (w + gap);
    const y = c.y - h / 2 + row * (h + gap);
    if (!rects.some((r) => x < r.x + r.w + 8 && x + w + 8 > r.x && y < r.y + r.h + 8 && y + h + 8 > r.y)) return { x, y };
  }
  return { x: c.x - w / 2, y: c.y - h / 2 };
}

function renderTools() {
  $('#tools').innerHTML =
    TOOLS.map(([t, title]) => `<button class="tb ${S.tool === t ? 'on' : ''}" data-tool="${t}" title="${title}">${I[t]}</button>`).join('') +
    '<i class="sep"></i>' +
    ADD.map(([t, title]) => `<button class="tb" data-add="${t}" title="Add: ${title}">${I[t]}</button>`).join('') +
    `<button class="tb" data-add="file" title="Files: images, PDF, audio, video, .md, .txt, code (you can also drag them in or paste with Ctrl+V)">${I.upload}</button>` +
    `<button class="tb ${urlbar.classList.contains('open') ? 'on' : ''}" data-add="url" title="Link: page, video (YouTube…), file by URL, card link (Ctrl+K; pasting a URL with Ctrl+V works too)">${I.globe}</button>` +
    '<i class="sep"></i>' +
    `<button class="tb" data-do="undo" title="Undo (Ctrl+Z)" ${canUndo() ? '' : 'disabled'}>${I.undo}</button>` +
    `<button class="tb" data-do="redo" title="Redo (Ctrl+Shift+Z)" ${canRedo() ? '' : 'disabled'}>${I.redo}</button>`;
}
$('#tools').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b || b.disabled) return;
  if (b.dataset.tool) setTool(b.dataset.tool);
  else if (b.dataset.add === 'file') picker.click();
  else if (b.dataset.add === 'url') toggleUrlbar();
  else if (b.dataset.add) {
    const id = createCard(b.dataset.add, {}, freeSpot(b.dataset.add), { edit: b.dataset.add !== 'frame' });
    if (b.dataset.add === 'frame') setTimeout(() => editFrameTitle(id), 50);
    setTool('select');
  } else if (b.dataset.do === 'undo') undo();
  else if (b.dataset.do === 'redo') redo();
});

function setTool(t) {
  S.tool = t;
  if (t === 'pen' || t === 'eraser') setSel([]);
  stage.className = stage.className.replace(/\btool-\w+/g, '') + ' tool-' + t;
  renderTools();
  renderProps();
  updateBrush();
}

function renderTop() {
  $('#topright').innerHTML = `
    <button class="tb" data-do="search" title="Search the board (Ctrl+F)">${I.search}</button>
    <button class="tb ${S.ui.minimap ? 'on' : ''}" data-do="minimap" title="Minimap">${I.map}</button>
    <button class="tb ${S.ui.grid ? 'on' : ''}" data-do="grid" title="Snap to grid ${S.ui.grid ? '(on)' : '(off)'}. Snapping to neighboring cards is always on; hold Alt while dragging to disable snapping">${I.grid}</button>
    <button class="tb" data-do="export" title="Export: Markdown, print / PDF">${I.export}</button>
    <i class="sep v"></i>
    <button class="tb ${S.ui.inkAbove ? '' : 'on'}" data-do="ink" title="Drawing layer: ${S.ui.inkAbove ? 'above cards' : 'below cards'} (click to toggle)">${I.layers}</button>
    <button class="tb ${S.ui.wheel === 'pan' ? 'on' : ''}" data-do="wheel" title="Mouse wheel: ${S.ui.wheel === 'pan' ? 'scroll (Ctrl+wheel — zoom)' : 'zoom (Shift+wheel — sideways)'}">${I.wheel}</button>
    <button class="tb" data-do="theme" title="Theme">${S.ui.theme === 'dark' ? I.sun : I.moon}</button>
    <button class="tb" data-do="fit" title="Fit all (F)">${I.fit}</button>`;
}
$('#topright').addEventListener('click', (e) => {
  const b = e.target.closest('[data-do]');
  if (!b) return;
  const a = b.dataset.do;
  if (a === 'ink') S.ui.inkAbove = !S.ui.inkAbove;
  else if (a === 'wheel') S.ui.wheel = S.ui.wheel === 'pan' ? 'zoom' : 'pan';
  else if (a === 'theme') S.ui.theme = S.ui.theme === 'dark' ? 'light' : 'dark';
  else if (a === 'fit') return fitAll();
  else if (a === 'search') { bus.emit('opensearch'); return; }
  else if (a === 'export') { bus.emit('openexport', b); return; }
  else if (a === 'minimap') S.ui.minimap = !S.ui.minimap;
  else if (a === 'grid') S.ui.grid = !S.ui.grid;
  savePrefs();
  applyTheme();
});
$('#zoombar').innerHTML = `<button class="tb" data-z="0.8" title="Zoom out (-)">${I.minus}</button><button id="zoomval" title="Reset zoom (0)">100%</button><button class="tb" data-z="1.25" title="Zoom in (+)">${I.plus}</button>`;
$('#zoombar').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  const c = stageCenter();
  zoomAt(c.x, c.y, b.dataset.z ? +b.dataset.z : 1 / S.view.k);
});
bus.on('history', renderTools);
bus.on('save', (s) => {
  const el = $('#save');
  el.dataset.s = s;
  el.textContent = { dirty: 'Saving…', saved: 'Saved', error: 'Save failed!' }[s];
});

const props = $('#props');
const swatches = (colors, cur, withCustom = true) =>
  colors.map((c) => `<button class="sw ${c === cur ? 'on' : ''}" data-k="color" data-v="${c}" style="--sw:${c === 'auto' ? 'var(--ink)' : c}" title="${c === 'auto' ? 'Auto (follows theme)' : c}"></button>`).join('') +
  (withCustom ? `<label class="sw custom" title="Custom color"><input type="color" data-k="color" value="${/^#[0-9a-f]{6}$/i.test(cur) ? cur : '#4f6df5'}"></label>` : '');
const range = (label, key, min, max, step, val, unit = '') =>
  `<label class="rg"><span>${label}</span><input type="range" data-k="${key}" min="${min}" max="${max}" step="${step}" value="${val}"><output>${key === 'alpha' ? Math.round(val * 100) : val}${unit}</output></label>`;
const toggle = (key, label, on, icon = '') => `<button class="chip ${on ? 'on' : ''}" data-t="${key}" title="${label}">${icon}${label}</button>`;

function propsCtx() {
  if (S.tool === 'pen') return { type: 'pen' };
  if (S.tool === 'eraser') return { type: 'eraser' };
  const items = [...S.sel].map((i) => S.items.get(i)).filter(Boolean);
  if (items.length) {
    if (items.every((i) => i.kind === 'link')) return { type: 'links', items };
    if (items.every((i) => i.kind === 'card')) return { type: 'cards', items };
    return { type: 'mixed', items };
  }
  if (S.tool === 'link') return { type: 'linkdef' };
  return null;
}

function renderProps() {
  const c = propsCtx();
  if (!c) { props.style.display = 'none'; props.innerHTML = ''; return; }
  props.style.display = 'flex';
  let h = '';
  const del = `<button class="chip danger" data-do="del" title="Delete (Del)">${I.trash}</button>`;
  if (c.type === 'pen') {
    h = `<div class="grp">${swatches(INK_COLORS, S.pen.color)}</div>${range('Size', 'size', 1, 60, 1, S.pen.size)}${range('Opacity', 'alpha', 0.1, 1, 0.05, S.pen.alpha, '%')}`;
  } else if (c.type === 'eraser') {
    h = `${range('Size', 'size', 6, 140, 1, S.eraser.size)}${toggle('whole', 'Whole stroke', S.eraser.whole)}`;
  } else if (c.type === 'links' || c.type === 'linkdef') {
    const l = c.type === 'links' ? c.items[0] : S.link;
    h = `<div class="grp">${swatches(INK_COLORS, l.color)}</div>${range('Width', 'width', 1, 14, 1, l.width)}${toggle('arrow', 'Arrow', l.arrow, I.arrow)}${toggle('dashed', 'Dashed', l.dashed, I.dashed)}`;
    if (c.type === 'links' && c.items.length === 1) h += `<input class="txt" data-k="label" placeholder="Connection label" value="${(l.label || '').replace(/"/g, '&quot;')}">`;
    if (c.type === 'links') h += del;
    else h = '<span class="hint">Drag from card to card</span>' + h;
  } else if (c.type === 'cards') {
    const types = new Set(c.items.map((i) => i.type));
    if (types.size === 1 && types.has('note')) h += `<div class="grp">${swatches(NOTE_COLORS, c.items[0].color)}</div>`;
    if (types.size === 1 && types.has('text')) h += `<div class="grp">${swatches(INK_COLORS, c.items[0].color)}</div>${range('Font', 'fs', 12, 140, 1, c.items[0].fs || 28)}`;
    if (types.size === 1 && types.has('frame')) h += `<div class="grp">${swatches(FRAME_COLORS, c.items[0].color, false)}</div>`;
    if (c.items.length >= 2) {
      h += `<div class="grp al">${[['left', 'alL', 'Align left'], ['cx', 'alCX', 'Center (vertical axis)'], ['right', 'alR', 'Align right'], ['top', 'alT', 'Align top'], ['cy', 'alCY', 'Center (horizontal axis)'], ['bottom', 'alB', 'Align bottom']].map(([k, ic, t]) => `<button class="chip" data-do="al-${k}" title="${t}">${I[ic]}</button>`).join('')}`;
      if (c.items.length >= 3) h += `<button class="chip" data-do="dist-x" title="Distribute horizontally">${I.dX}</button><button class="chip" data-do="dist-y" title="Distribute vertically">${I.dY}</button>`;
      h += '</div>';
    }
    if (!types.has('frame')) h += `<button class="chip" data-do="wrap" title="Wrap selected cards in a frame">${I.frame}</button>`;
    h += `<div class="grp acc" title="Card color label">${ACCENTS.map((a) => `<button class="sw sm ${(c.items[0].accent || '') === a ? 'on' : ''} ${a ? '' : 'none'}" data-k="accent" data-v="${a}" style="--sw:${a || 'transparent'}"></button>`).join('')}</div>`;
    if (!types.has('frame')) h += `<input class="txt tags-in" data-k="tags" placeholder="#tags, comma-separated" value="${((c.items[0].tags || []).join(', ')).replace(/"/g, '&quot;')}">`;
    h += `<button class="chip" data-do="front" title="Bring to front">${I.front}</button><button class="chip" data-do="back" title="Send to back">${I.back}</button><button class="chip" data-do="dup" title="Duplicate (Ctrl+D)">${I.copy}</button>${del}`;
  } else {
    h = `<button class="chip" data-do="dup">${I.copy}</button>${del}`;
  }
  props.innerHTML = h;
}

function applyProp(key, val, live) {
  const c = propsCtx();
  if (!c) return;
  if (c.type === 'pen') { S.pen[key] = val; savePrefs(); updateBrush(); return; }
  if (c.type === 'eraser') { S.eraser[key] = val; savePrefs(); updateBrush(); return; }
  if (c.type === 'linkdef') { S.link[key] = val; savePrefs(); return; }
  if (key === 'tags') val = [...new Set(String(val).split(/[,;\s]+/).map((t) => t.replace(/^#+/, '').trim().toLowerCase().slice(0, 30)).filter(Boolean))].slice(0, 12);
  const ids = c.items.map((i) => i.id);
  ids.forEach(mark);
  for (const it of c.items) { if ((key === 'accent') && !val) delete it[key]; else it[key] = val; }
  if (c.type === 'links' && key in S.link) { S.link[key] = val; savePrefs(); }
  touch(ids);
  dirty();
  if (!live) commit();
}

props.addEventListener('click', (e) => {
  const sw = e.target.closest('button[data-v]');
  if (sw) { applyProp(sw.dataset.k, sw.dataset.v, false); renderProps(); return; }
  const t = e.target.closest('[data-t]');
  if (t) {
    const c = propsCtx();
    const cur = c.type === 'eraser' ? S.eraser[t.dataset.t] : c.type === 'linkdef' ? S.link[t.dataset.t] : c.items?.[0]?.[t.dataset.t];
    applyProp(t.dataset.t, !cur, false);
    renderProps();
    return;
  }
  const d = e.target.closest('[data-do]');
  if (!d) return;
  const ids = [...S.sel];
  if (d.dataset.do === 'del') deleteIds(ids);
  else if (d.dataset.do === 'dup') duplicate(ids);
  else if (d.dataset.do === 'front') { ids.forEach(bringToFront); }
  else if (d.dataset.do?.startsWith('al-')) align(d.dataset.do.slice(3));
  else if (d.dataset.do === 'dist-x') distribute('x');
  else if (d.dataset.do === 'dist-y') distribute('y');
  else if (d.dataset.do === 'wrap') wrapInFrame(ids);
  else if (d.dataset.do === 'back') {
    const cards = [...S.items.values()].filter((i) => i.kind === 'card');
    let z = Math.min(...cards.map((i) => i.z)) - 1;
    for (const id of ids) { const it = S.items.get(id); if (it?.kind === 'card') { it.z = z--; } }
    touch(ids); dirty();
  }
});
props.addEventListener('input', (e) => {
  const el = e.target;
  const key = el.dataset.k;
  if (!key) return;
  let v = el.value;
  if (el.type === 'range') {
    v = +v;
    el.nextElementSibling.textContent = key === 'alpha' ? Math.round(v * 100) : v;
  }
  applyProp(key, v, true);
  if (el.type === 'color') {
    props.querySelectorAll('.sw.on').forEach((s) => s.classList.remove('on'));
  }
});
props.addEventListener('change', () => { commit(); renderProps(); });
bus.on('select', renderProps);

function closeMenus() { }
document.addEventListener('click', (e) => { const b = e.target.closest('button'); if (b && !b.closest('.media')) b.blur(); });

async function init() {
  loadPrefs();
  try { await initProject(); await load(); initProjectsUI(); } catch { toast('Could not load the board — is the server running?', 6000); }
  const fresh = S.view.x === 0 && S.view.y === 0 && S.view.k === 1 && S.items.size === 0;
  syncAll();
  renderLinks();
  applyTheme();
  const r = stage.getBoundingClientRect();
  if (fresh) { S.view.x = r.width / 2; S.view.y = r.height / 2; }
  applyView();
  renderTop();
  setTool('select');
  requestDraw();
  window.addEventListener('beforeunload', (e) => { if (hasUnsaved()) { e.preventDefault(); e.returnValue = ''; } });
  window.__board = { S, fitAll, zoomAt, applyView, setTool, deleteIds, duplicate };
  document.body.classList.add('ready');
  if (S.pendingCard) { const h = S.pendingCard; S.pendingCard = null; setTimeout(() => flyTo(h.cid, { t: h.t }), 150); }
}
init();
