import { S, bus, $ } from './store.js';
import { I } from './icons.js';
import { labelOf } from './cards.js';
import { flyTo } from './nav.js';
import { tc } from './transcript.js';

const bar = document.createElement('div');
bar.id = 'searchbar';
bar.className = 'panel';
bar.innerHTML = `<div class="sb-top"><span class="sb-ic">${I.search}</span><input type="text" placeholder="Search text, titles, transcripts, #tags…" spellcheck="false"><button class="x" title="Close (Esc)">✕</button></div>
  <div class="sb-tags"></div><div class="sb-list scroll"></div><div class="sb-foot"></div>`;
document.body.appendChild(bar);
const inp = bar.querySelector('input'), tagsEl = bar.querySelector('.sb-tags'), list = bar.querySelector('.sb-list'), foot = bar.querySelector('.sb-foot');

const badge = document.createElement('div');
badge.id = 'filterbadge';
document.body.appendChild(badge);

let hits = [], cur = 0;
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const low = (s) => String(s || '').toLowerCase();
const TYPE_ICON = (t) => I[t === 'link' ? 'globe' : t] || I.file;

function allTags() {
  const m = new Map();
  for (const it of S.items.values()) if (it.kind === 'card') for (const t of it.tags || []) m.set(t, (m.get(t) || 0) + 1);
  return [...m].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

function snippet(text, q) {
  const i = low(text).indexOf(q);
  if (i < 0) return esc(String(text).slice(0, 110));
  const a = Math.max(0, i - 40), b = Math.min(text.length, i + q.length + 70);
  return (a ? '…' : '') + esc(text.slice(a, i)) + '<mark>' + esc(text.slice(i, i + q.length)) + '</mark>' + esc(text.slice(i + q.length, b)) + (b < text.length ? '…' : '');
}

export function runSearch(raw) {
  const toks = raw.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const tagToks = toks.filter((t) => t.startsWith('#') && t.length > 1).map((t) => t.slice(1));
  const words = toks.filter((t) => !(t.startsWith('#') && t.length > 1));
  const out = [];
  if (!toks.length) return out;
  for (const it of S.items.values()) {
    if (it.kind !== 'card') continue;
    const tags = it.tags || [];
    if (!tagToks.every((t) => tags.some((x) => x.includes(t)))) continue;
    const label = labelOf(it);
    const body = [it.text, it.ocr?.text, it.name, it.title, it.desc, it.site, it.author, it.provider, it.href, it.src, it.label, ...tags].filter(Boolean).join('\n');
    const hay = low(label + '\n' + body);
    const segs = it.transcript?.segments || [];
    const segHit = (s) => words.every((w) => low(s[2]).includes(w));
    const cardOk = words.every((w) => hay.includes(w) || segs.some((s) => low(s[2]).includes(w)));
    if (!cardOk) continue;
    const inMain = words.every((w) => hay.includes(w));
    if (inMain || !words.length) {
      const w0 = words[0] || '';
      const src = w0 && low(body).includes(w0) ? body : label;
      out.push({ id: it.id, type: it.type, label, snip: w0 ? snippet(src, w0) : '', tags, score: low(label).includes(w0) ? 2 : 1 });
    }
    if (words.length) {
      let n = 0;
      for (const s of segs) {
        if (n >= 3) break;
        if (!segHit(s)) continue;
        n++;
        out.push({ id: it.id, type: it.type, label, snip: snippet(s[2], words[0]), tags: [], t: s[0], score: 0.5 });
      }
    }
  }
  return out.sort((a, b) => b.score - a.score).slice(0, 80);
}

function render() {
  const q = inp.value;
  hits = runSearch(q);
  cur = Math.min(cur, Math.max(0, hits.length - 1));
  const f = S.filter?.tags || [];
  tagsEl.innerHTML = allTags().slice(0, 30).map(([t, n]) => `<button class="sb-tag ${f.includes(t) ? 'on' : ''}" data-tag="${esc(t)}" title="Show only cards with this tag">#${esc(t)} <i>${n}</i></button>`).join('') || '<span class="sb-hint">No tags yet: select a card and type tags in the bar at the top</span>';
  list.innerHTML = hits.map((h, i) => `<div class="sb-row ${i === cur ? 'cur' : ''}" data-i="${i}">
      <span class="sb-ti">${TYPE_ICON(h.type)}</span>
      <div class="sb-tx"><div class="sb-l">${esc(h.label)}${h.t != null ? ` <span class="sb-time">▶ ${tc(h.t)}</span>` : ''}</div>${h.snip ? `<div class="sb-s">${h.snip}</div>` : ''}</div>
      ${h.tags.slice(0, 3).map((t) => `<span class="tg-s">#${esc(t)}</span>`).join('')}</div>`).join('');
  foot.textContent = q.trim() ? (hits.length ? `Found: ${hits.length}${hits.length >= 80 ? '+' : ''} · ↑↓ select · Enter — go to` : 'Nothing found') : 'Start typing: searches text, page titles, file names and transcripts';
  list.style.display = hits.length ? '' : 'none';
}

function go(i) {
  const h = hits[i];
  if (!h) return;
  flyTo(h.id, { t: h.t ?? null });
  close();
}
export function openSearch() {
  bar.classList.add('open');
  inp.focus();
  inp.select();
  render();
}
function close() { bar.classList.remove('open'); inp.blur(); }

inp.addEventListener('input', () => { cur = 0; render(); });
inp.addEventListener('keydown', (e) => {
  e.stopPropagation();
  if (e.key === 'Escape') close();
  else if (e.key === 'Enter') go(cur);
  else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    if (!hits.length) return;
    cur = (cur + (e.key === 'ArrowDown' ? 1 : hits.length - 1)) % hits.length;
    render();
    list.querySelector('.cur')?.scrollIntoView({ block: 'nearest' });
  }
});
bar.addEventListener('click', (e) => {
  if (e.target.closest('.x')) return close();
  const t = e.target.closest('.sb-tag');
  if (t) { toggleTag(t.dataset.tag); render(); return; }
  const row = e.target.closest('.sb-row');
  if (row) go(+row.dataset.i);
});
window.addEventListener('pointerdown', (e) => { if (bar.classList.contains('open') && !bar.contains(e.target) && !e.target.closest('[data-do=search]')) close(); });
bus.on('opensearch', openSearch);
window.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.code === 'KeyF' && !e.shiftKey) { e.preventDefault(); openSearch(); }
}, true);

export function toggleTag(t) {
  const cur = new Set(S.filter?.tags || []);
  cur.has(t) ? cur.delete(t) : cur.add(t);
  S.filter = cur.size ? { tags: [...cur] } : null;
  bus.emit('filter');
  renderBadge();
}
function renderBadge() {
  const f = S.filter?.tags || [];
  badge.style.display = f.length ? '' : 'none';
  badge.innerHTML = f.length ? `Filter: ${f.map((t) => '#' + esc(t)).join(' ')} <button title="Clear filter">✕</button>` : '';
}
badge.addEventListener('click', (e) => { if (e.target.closest('button')) { S.filter = null; bus.emit('filter'); renderBadge(); if (bar.classList.contains('open')) render(); } });
document.addEventListener('click', (e) => {
  const tg = e.target.closest('.card > .tags .tg');
  if (tg) { toggleTag(tg.dataset.tag); if (bar.classList.contains('open')) render(); }
});
renderBadge();
