import { S, bus, uid, nextZ, mark, commit, touch, dirty, setSel, $ } from './store.js';
import { I } from './icons.js';
import { createMedia } from './media.js';
import { createOcr } from './ocr.js';
import { resolveColor } from './ink.js';

const layer = $('#cards');
const framesLayer = $('#frames');
const els = new Map();
export const editing = new Set();

export const EDITABLE = new Set(['note', 'text', 'md', 'code', 'audio', 'video']);
const FIT = new Set(['text', 'image', 'audio', 'video', 'file', 'link', 'ref', 'embed']);
const isFit = (it) => FIT.has(it.type) && !(it.type === 'embed' && it.h);
export const NOTE_COLORS = ['#fff2a8', '#ffd8a8', '#ffc9c9', '#fcc2d7', '#b2f2bb', '#a5d8ff', '#d0bfff', '#e9ecef'];
const NAMES = {
  note: 'Note', text: 'Text', md: 'Markdown', code: 'Code', image: 'Image',
  pdf: 'PDF', audio: 'Audio', video: 'Video', file: 'File', link: 'Page', embed: 'Player', ref: 'Card link', frame: 'Frame',
};
export const FRAME_COLORS = ['#4f6df5', '#e8590c', '#2f9e44', '#c2255c', '#7048e8', '#0c8599', '#f59f00', '#868e96'];
export const ACCENTS = ['', '#e03131', '#f76707', '#f59f00', '#2f9e44', '#0c8599', '#1971c2', '#7048e8', '#c2255c'];
const DEFAULTS = {
  note: { w: 230, h: 190, color: NOTE_COLORS[0], text: '' },
  text: { w: 300, color: 'auto', fs: 28, text: '' },
  md: { w: 400, h: 320, text: '' },
  code: { w: 460, h: 260, lang: 'auto', text: '' },
  image: { w: 420 },
  pdf: { w: 460, h: 600 },
  audio: { w: 400 },
  video: { w: 520 },
  file: { w: 280 },
  link: { w: 340 },
  embed: { w: 480 },
  ref: { w: 250 },
  frame: { w: 520, h: 340, title: '', color: FRAME_COLORS[0] },
};

export const defaultSize = (type) => ({ w: DEFAULTS[type].w, h: DEFAULTS[type].h || 140 });

// Board may come from an untrusted .zip: validate every URL and value
const ASSET_RE = /^\/assets\/[0-9a-f]{24}(\.[a-z0-9]{1,8})?$/;
export const assetOk = (u) => (typeof u === 'string' && ASSET_RE.test(u) ? u : '');
export const safeHref = (u) => (typeof u === 'string' && /^https?:\/\/[^\s]+$/i.test(u) ? u : '');
const EMBED_HOSTS = new Set(['www.youtube-nocookie.com', 'player.vimeo.com', 'rutube.ru', 'www.dailymotion.com', 'player.twitch.tv', 'clips.twitch.tv', 'open.spotify.com', 'w.soundcloud.com', 'www.loom.com']);
export function embedOk(u) {
  try { const x = new URL(u); return x.protocol === 'https:' && EMBED_HOSTS.has(x.hostname); } catch { return false; }
}
const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };
const dateOf = (t) => new Date(t * 1000).toLocaleDateString('en-US', { day: 'numeric', month: 'short', year: 'numeric' });

export function labelOf(it) {
  if (!it) return '';
  const first = (t) => ((t || '').split('\n').map((l) => l.replace(/^[#>\-*\s]+/, '').trim()).find(Boolean) || '').slice(0, 70);
  switch (it.type) {
    case 'note': case 'text': case 'md': case 'code': return first(it.text) || NAMES[it.type];
    case 'link': return it.title || hostOf(it.href) || NAMES.link;
    case 'embed': return it.title || it.provider || NAMES.embed;
    case 'ref': return it.label || NAMES.ref;
    case 'frame': return it.title || NAMES.frame;
    default: return it.name || NAMES[it.type] || it.type;
  }
}

const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

if (window.DOMPurify) {
  DOMPurify.addHook('afterSanitizeAttributes', (n) => {
    if (n.tagName === 'A') { n.setAttribute('target', '_blank'); n.setAttribute('rel', 'noopener noreferrer'); }
  });
}

export function rectOf(id) {
  const it = S.items.get(id);
  if (!it) return null;
  const e = els.get(id);
  return {
    x: it.x, y: it.y,
    w: (e && e.el.offsetWidth) || it.w || 200,
    h: (e && e.el.offsetHeight) || it.h || 120,
  };
}
export function hitCard(wx, wy) {
  let best = null, bz = -Infinity;
  for (const it of S.items.values()) {
    if (it.kind !== 'card' || it.type === 'frame') continue;
    const r = rectOf(it.id);
    if (wx >= r.x && wx <= r.x + r.w && wy >= r.y && wy <= r.y + r.h && it.z > bz) { best = it.id; bz = it.z; }
  }
  return best;
}
export function cardsInRect(x0, y0, x1, y1) {
  const out = [];
  for (const it of S.items.values()) {
    if (it.kind !== 'card') continue;
    const r = rectOf(it.id);
    if (r.x < x1 && r.x + r.w > x0 && r.y < y1 && r.y + r.h > y0) out.push(it.id);
  }
  return out;
}
export function contentBounds() {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const it of S.items.values()) {
    if (it.kind === 'card') {
      const r = rectOf(it.id);
      x0 = Math.min(x0, r.x); y0 = Math.min(y0, r.y); x1 = Math.max(x1, r.x + r.w); y1 = Math.max(y1, r.y + r.h);
    } else if (it.kind === 'stroke') {
      for (let i = 0; i < it.pts.length; i += 2) {
        x0 = Math.min(x0, it.pts[i]); x1 = Math.max(x1, it.pts[i]);
        y0 = Math.min(y0, it.pts[i + 1]); y1 = Math.max(y1, it.pts[i + 1]);
      }
    }
  }
  return x0 === Infinity ? null : { x0, y0, x1, y1 };
}

export function createCard(type, props = {}, at = { x: 0, y: 0 }, opts = {}) {
  const id = uid();
  const it = { kind: 'card', id, type, z: nextZ(), x: Math.round(at.x), y: Math.round(at.y), ...structuredClone(DEFAULTS[type]), ...props };
  mark(id);
  S.items.set(id, it);
  commit();
  touch([id]);
  setSel([id]);
  if (opts.edit) setEditing(id, true);
  return id;
}

export function bringToFront(id) {
  const it = S.items.get(id);
  if (!it || it.z === S.z) return;
  it.z = nextZ();
  const e = els.get(id);
  if (e) e.el.style.zIndex = it.z;
  dirty();
}

export function setEditing(id, on) {
  const it = S.items.get(id);
  if (on) {
    if (!it || !EDITABLE.has(it.type) || editing.has(id)) return;
    for (const o of [...editing]) setEditing(o, false);
    editing.add(id);
    mark(id);
    sync([id]);
    const ent = els.get(id);
    const ta = ent && ent.el.querySelector('textarea');
    if (ta) { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }
  } else {
    if (!editing.delete(id)) return;
    if (it && it.type === 'text' && !it.text.trim()) {
      mark(id);
      S.items.delete(id);
      for (const l of [...S.items.values()]) if (l.kind === 'link' && (l.from === id || l.to === id)) { mark(l.id); S.items.delete(l.id); }
      S.sel.delete(id);
      commit();
      touch([id]);
      bus.emit('select');
      return;
    }
    commit();
    sync([id]);
  }
  bus.emit('editing');
}

bus.on('select', () => {
  for (const id of [...editing]) if (!S.sel.has(id)) setEditing(id, false);
  for (const [id, e] of els) {
    e.el.classList.toggle('selected', S.sel.has(id));
    if (!S.sel.has(id)) e.el.classList.remove('live');
  }
});
bus.on('linktarget', (id) => {
  for (const [cid, e] of els) e.el.classList.toggle('linktarget', cid === id);
});

function textual(item, body) {
  const view = document.createElement('div');
  view.className = 'view scroll';
  const ta = document.createElement('textarea');
  ta.className = 'ta';
  ta.spellcheck = false;
  body.append(view, ta);
  if (item.type === 'code') {
    const cp = document.createElement('button');
    cp.className = 'copy'; cp.dataset.act = 'copy'; cp.title = 'Copy code'; cp.innerHTML = I.copy;
    const tag = document.createElement('span');
    tag.className = 'langtag';
    body.append(cp, tag);
  }
  const fit = FIT.has(item.type);
  const grow = () => { if (fit) { ta.style.height = 'auto'; ta.style.height = ta.scrollHeight + 2 + 'px'; } };
  ta.addEventListener('input', () => {
    const it = S.items.get(item.id);
    if (!it) return;
    it.text = ta.value;
    grow();
    dirty();
    bus.emit('cardsize', item.id);
  });
  ta.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Escape') { setEditing(item.id, false); return; }
    if (e.key === 'Tab') {
      e.preventDefault();
      const ins = item.type === 'code' ? '  ' : '\t';
      document.execCommand('insertText', false, ins);
    }
  });
  ta.addEventListener('wheel', (e) => { if (ta.scrollHeight > ta.clientHeight && !e.ctrlKey) e.stopPropagation(); });
  let last = null;
  return {
    render(it, ed) {
      if (!ed) {
        const key = it.type + '\0' + (it.lang || '') + '\0' + it.text;
        if (key !== last) {
          last = key;
          view.classList.toggle('empty', !it.text);
          if (it.type === 'md') {
            view.innerHTML = it.text ? DOMPurify.sanitize(marked.parse(it.text, { gfm: true, breaks: true })) : '';
          } else if (it.type === 'code') {
            let html, lang = it.lang;
            try {
              if (lang && lang !== 'auto' && hljs.getLanguage(lang)) html = hljs.highlight(it.text, { language: lang, ignoreIllegals: true }).value;
              else { const r = hljs.highlightAuto(it.text); html = r.value; lang = r.language; }
            } catch { html = esc(it.text); }
            view.innerHTML = `<pre><code class="hljs">${html}</code></pre>`;
            const tag = body.querySelector('.langtag');
            const auto = it.lang === 'auto' || !it.lang;
            if (tag) tag.textContent = it.text ? (lang || '') + (auto ? ' · auto' : '') : '';
            const opt = body.closest('.card')?.querySelector('select.lang option[value="auto"]');
            if (opt) opt.textContent = auto && it.text && lang ? 'auto · ' + lang : 'auto';
          } else {
            view.textContent = it.text;
          }
        }
      } else {
        if (ta.value !== it.text) ta.value = it.text;
        grow();
      }
      view.style.display = ed ? 'none' : '';
      ta.style.display = ed ? '' : 'none';
      if (it.type === 'text') { ta.style.fontSize = view.style.fontSize = (it.fs || 28) + 'px'; ta.style.color = view.style.color = resolveColor(it.color); }
    },
  };
}

function simple(item, body) {
  if (item.type === 'image') {
    body.innerHTML = '<img draggable="false" alt="">';
    const img = body.firstChild;
    const oc = createOcr(item);
    body.appendChild(oc.root);
    return { render(it) { const u = assetOk(it.url); if (img.getAttribute('src') !== u) img.src = u; img.alt = it.name || ''; oc.render(it); }, destroy: oc.destroy };
  }
  if (item.type === 'pdf') {
    body.innerHTML = '<iframe title="PDF"></iframe><div class="shield"><span>Click again to scroll the PDF</span></div>';
    const f = body.firstChild;
    return { render(it) { const src = assetOk(it.url) + '#navpanes=0'; if (f.getAttribute('src') !== src) f.src = src; } };
  }
  body.innerHTML = `<div class="filebox"><span class="fi">${I.file}</span><div><div class="fn"></div><div class="fs"></div></div><a class="dl" download title="Download">${I.upload}</a></div>`;
  return {
    render(it) {
      body.querySelector('.fn').textContent = it.name || 'file';
      body.querySelector('.fs').textContent = it.size ? (it.size / 1048576).toFixed(it.size > 1048576 ? 1 : 2) + ' MB' : '';
      const a = body.querySelector('.dl');
      a.href = assetOk(it.url); a.download = it.name || '';
    },
  };
}

const playing = new Set();

function linkBody(item, body) {
  let last = '';
  return {
    render(it) {
      const loading = !!(it.loading && S.fetching?.has(it.id));
      const sig = JSON.stringify([loading, it.loading, Math.round((it.progress || 0) * 100), it.error, it.title, it.desc, it.thumb, it.favicon, it.site, it.fetched, it.href, it.archive]);
      if (sig === last) return;
      last = sig;
      const href = safeHref(it.href);
      const host = hostOf(it.href);
      if (loading) {
        const pct = it.progress ? ` ${Math.round(it.progress * 100)}%` : '';
        body.innerHTML = `<div class="lk-load"><i class="spin"></i><div class="lk-lt"><div>Loading…${pct}</div><div class="lk-u">${esc(it.href || '')}</div></div><button class="chip-s" data-act="cancelfetch">Cancel</button></div>`;
        return;
      }
      const thumb = assetOk(it.thumb), fav = assetOk(it.favicon);
      body.innerHTML = `${thumb ? `<div class="lk-thumb" style="background-image:url('${thumb}')"></div>` : ''}
        <div class="lk-main">
          <div class="lk-site">${fav ? `<img src="${fav}" alt="">` : I.globe}<span>${esc(it.site || host)}</span></div>
          ${href ? `<a class="lk-title" href="${esc(href)}" target="_blank" rel="noopener noreferrer">${esc(it.title || host || href)}</a>` : `<span class="lk-title">${esc(it.title || '')}</span>`}
          ${it.desc ? `<div class="lk-desc">${esc(it.desc)}</div>` : ''}
          ${(it.error || it.loading) ? `<div class="lk-err">⚠ ${esc(it.error || 'download interrupted')}. Only the link was saved — you can get a snapshot with the ↻ button above the card.</div>` : ''}
          <div class="lk-foot" title="The copy is saved to disk and never refreshes by itself">${it.fetched ? 'snapshot from ' + dateOf(it.fetched) : 'no snapshot'}${assetOk(it.archive) ? ` · <a class="lk-arch" href="${assetOk(it.archive)}" target="_blank" rel="noopener" title="Saved copy of the page (no scripts, works offline)">open copy</a>` : ''}</div>
        </div>`;
    },
  };
}

function embedSrc(it, auto) {
  if (!embedOk(it.embed)) return '';
  const u = new URL(it.embed);
  if (/twitch\.tv$/.test(u.hostname)) u.searchParams.set('parent', location.hostname);
  if (auto && /youtube|vimeo|dailymotion/.test(u.hostname)) u.searchParams.set('autoplay', '1');
  return u.href;
}

function embedBody(item, body) {
  let last = '';
  return {
    render(it) {
      const on = playing.has(it.id);
      const sig = JSON.stringify([on, it.title, it.author, it.thumb, it.embed, it.provider, it.ar, it.h]);
      if (sig === last) return;
      last = sig;
      const thumb = assetOk(it.thumb);
      const style = it.h ? 'height:' + it.h + 'px' : 'aspect-ratio:' + (it.ar || 16 / 9);
      const src = embedSrc(it, true);
      const stage = on && src
        ? `<iframe src="${esc(src)}" title="${esc(it.title || 'Player')}" allow="autoplay; fullscreen; picture-in-picture; encrypted-media" allowfullscreen referrerpolicy="strict-origin-when-cross-origin"></iframe><div class="shield"><span>Click again to control the player</span></div>`
        : `<div class="em-poster" ${thumb ? `style="background-image:url('${thumb}')"` : ''}>${src ? `<button class="em-play" data-act="play" title="Start the player (needs internet)">${I.play}</button>` : ''}<span class="em-badge">${esc(it.provider || '')}</span></div>`;
      body.innerHTML = `<div class="em-stage" style="${style}">${stage}</div>
        ${it.title || it.author ? `<div class="em-meta"><div class="em-title">${esc(it.title || '')}</div>${it.author ? `<div class="em-author">${esc(it.author)}</div>` : ''}</div>` : ''}`;
    },
  };
}

function refBody(item, body) {
  let last = '';
  return {
    render(it) {
      const here = it.pid === S.project.id;
      const tgt = here ? S.items.get(it.cid) : null;
      const label = tgt ? labelOf(tgt) : it.label || 'Card';
      const sub = !here ? 'Project: ' + (it.pname || it.pid) : tgt ? NAMES[tgt.type] || tgt.type : 'card not found';
      const sig = label + '|' + sub + '|' + here;
      if (sig === last) return;
      last = sig;
      body.innerHTML = `<div class="rf ${here && !tgt ? 'dead' : ''}" data-act="go" title="Go to card"><span class="rf-ic">${I.hash}</span><div class="rf-t"><div class="rf-label">${esc(label)}</div><div class="rf-sub">${esc(sub)}</div></div><span class="rf-go">${I.arrow}</span></div>`;
    },
  };
}

function frameBody(item, body) {
  body.innerHTML = '<div class="fr-title" title="Double-click to rename; drag the title to move the frame together with the cards inside"></div>';
  const t = body.firstChild;
  return {
    render(it) {
      body.parentNode.style.setProperty('--fc', FRAME_COLORS.includes(it.color) ? it.color : /^#[0-9a-f]{6}$/i.test(it.color || '') ? it.color : FRAME_COLORS[0]);
      if (!t.querySelector('input')) t.textContent = it.title || 'Frame';
      t.classList.toggle('empty', !it.title);
    },
  };
}

export function editFrameTitle(id) {
  const ent = els.get(id), it = S.items.get(id);
  if (!ent || !it) return;
  const t = ent.el.querySelector('.fr-title');
  if (t.querySelector('input')) return;
  const inp = document.createElement('input');
  inp.value = it.title || '';
  inp.maxLength = 120;
  inp.placeholder = 'Frame title';
  t.textContent = '';
  t.appendChild(inp);
  inp.focus();
  inp.select();
  let done = false;
  const fin = (ok) => {
    if (done) return;
    done = true;
    if (ok && inp.value.trim() !== (it.title || '')) { mark(id); it.title = inp.value.trim(); commit(); dirty(); }
    inp.remove();
    touch([id]);
  };
  inp.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') fin(true); else if (e.key === 'Escape') fin(false); });
  inp.addEventListener('blur', () => fin(true));
}

export function playEmbed(id) {
  playing.add(id);
  sync([id]);
  cardEl(id)?.classList.add('live');
}

function langSelect() {
  const langs = window.hljs ? hljs.listLanguages().sort() : [];
  return `<select class="lang" data-nodrag title="Highlight language: 'auto' is detected from the text">
    <option value="auto">auto</option>${langs.map((l) => `<option value="${l}">${l}</option>`).join('')}</select>`;
}

function build(item) {
  const el = document.createElement('div');
  el.className = `card t-${item.type}`;
  el.dataset.id = item.id;
  const ed = EDITABLE.has(item.type);
  el.innerHTML = `
    <div class="bar"><span class="grip">${I[item.type === 'link' ? 'globe' : item.type] || I.file}<b>${NAMES[item.type] || item.type}</b></span>
      <span class="acts">
        ${item.type === 'code' ? langSelect() : ''}
        <button data-act="open" class="b-open" title="Open the original in the browser">${I.ext}</button>
        <button data-act="refresh" class="b-refresh" title="Download again / refresh the snapshot (replaces the saved copy; Ctrl+Z restores it)">${I.refresh}</button>
        <button data-act="reflink" title="Copy a link to this card">${I.hash}</button>
        ${ed ? `<button data-act="edit" title="Edit (double-click; Esc to exit)">${I.pen}</button>` : ''}
        <button data-act="dup" title="Duplicate (Ctrl+D)">${I.copy}</button>
        <button data-act="del" title="Delete (Del)">${I.trash}</button>
      </span></div>
    <div class="body"></div><i class="rs" title="Resize"></i><i class="ld" title="Drag to another card to create a link"></i>`;
  const body = el.querySelector('.body');
  let r;
  if (['note', 'text', 'md', 'code'].includes(item.type)) r = textual(item, body);
  else if (item.type === 'audio' || item.type === 'video') {
    const m = createMedia(item.type, item);
    body.appendChild(m.root);
    r = { render: (it, e) => m.render(it, e), destroy: m.destroy };
  } else if (item.type === 'link') r = linkBody(item, body);
  else if (item.type === 'embed') r = embedBody(item, body);
  else if (item.type === 'ref') r = refBody(item, body);
  else if (item.type === 'frame') r = frameBody(item, body);
  else r = simple(item, body);
  el.insertAdjacentHTML('beforeend', '<div class="tags"></div>');
  (item.type === 'frame' ? framesLayer : layer).appendChild(el);
  ro.observe(el);
  const ent = { el, r, type: item.type };
  els.set(item.id, ent);
  return ent;
}

const ro = new ResizeObserver((entries) => {
  for (const e of entries) bus.emit('cardsize', e.target.dataset.id);
});

function update(ent, it) {
  const { el } = ent;
  el.style.left = it.x + 'px';
  el.style.top = it.y + 'px';
  el.style.width = it.w + 'px';
  el.style.height = isFit(it) ? '' : it.h + 'px';
  el.classList.toggle('fixh', it.type === 'embed' && !!it.h);
  const src = safeHref(it.src || it.href);
  el.querySelector('.b-open').style.display = src ? '' : 'none';
  el.querySelector('.b-refresh').style.display = src && it.type !== 'ref' ? '' : 'none';
  el.style.zIndex = it.z;
  if (it.accent && /^#[0-9a-f]{6}$/i.test(it.accent)) { el.style.setProperty('--ac', it.accent); el.classList.add('has-ac'); } else el.classList.remove('has-ac');
  const tags = Array.isArray(it.tags) ? it.tags : [];
  const tg = el.querySelector(':scope > .tags');
  const tsig = tags.join('\n');
  if (tg.dataset.sig !== tsig) { tg.dataset.sig = tsig; tg.innerHTML = tags.map((t) => `<span class="tg" data-tag="${esc(t)}">#${esc(t)}</span>`).join(''); }
  el.classList.toggle('dim', isDim(it));
  if (it.type === 'note') el.style.setProperty('--c', it.color || NOTE_COLORS[0]);
  const sel = el.querySelector('select.lang');
  if (sel && sel.value !== (it.lang || 'auto')) sel.value = it.lang || 'auto';
  const ed = editing.has(it.id);
  el.classList.toggle('editing', ed);
  el.classList.toggle('selected', S.sel.has(it.id));
  ent.r.render(it, ed);
}

export function isDim(it) {
  const f = S.filter;
  if (!f || !f.tags || !f.tags.length) return false;
  if (it.type === 'frame') return false;
  const own = Array.isArray(it.tags) ? it.tags : [];
  return !f.tags.every((t) => own.includes(t));
}

export function sync(ids) {
  for (const id of ids) {
    const it = S.items.get(id);
    const ent = els.get(id);
    if (!it || it.kind !== 'card') {
      if (ent) {
        ro.unobserve(ent.el);
        ent.r.destroy?.();
        ent.el.remove();
        els.delete(id);
        editing.delete(id);
      }
      continue;
    }
    if (ent && ent.type !== it.type) {
      ro.unobserve(ent.el);
      ent.r.destroy?.();
      ent.el.remove();
      els.delete(id);
      update(build(it), it);
    } else update(ent || build(it), it);
  }
  const set = new Set(ids);
  for (const [rid, e] of els) {
    if (e.type !== 'ref' || set.has(rid)) continue;
    const r = S.items.get(rid);
    if (r && set.has(r.cid)) e.r.render(r, false);
  }
}
export function syncAll() { sync([...S.items.keys()]); }
bus.on('items', sync);
bus.on('theme', syncAll);
bus.on('filter', syncAll);
export const cardEl = (id) => els.get(id)?.el;

layer.addEventListener('change', (e) => {
  const sel = e.target.closest('select.lang');
  if (!sel) return;
  const id = sel.closest('.card').dataset.id;
  const it = S.items.get(id);
  mark(id);
  it.lang = sel.value;
  commit();
  touch([id]);
});

bus.on('fetchstate', ({ id, pct }) => {
  const el = cardEl(id);
  if (!el) return;
  el.classList.toggle('fetching', pct != null);
  if (pct != null) el.style.setProperty('--p', Math.round(pct * 100) + '%');
});
