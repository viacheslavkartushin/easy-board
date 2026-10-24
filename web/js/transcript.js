import { S, bus, api, dirty, touch, savePrefs, toast } from './store.js';
import { apiConfirm } from './confirm.js';
import { I } from './icons.js';

const MODELS = [
  ['tiny', 'tiny — very fast, rough (~75 MB)'],
  ['base', 'base — fast (~145 MB)'],
  ['small', 'small — balance of speed and quality (~480 MB)'],
  ['medium', 'medium — more accurate, slower (~1.5 GB)'],
  ['turbo', 'turbo — almost like large, faster (~1.6 GB)'],
  ['large-v3', 'large-v3 — best quality, slow without a GPU (~3 GB)'],
];
const LANGS = [['', 'auto'], ['ru', 'ru'], ['en', 'en'], ['uk', 'uk'], ['de', 'de'], ['fr', 'fr'], ['es', 'es'], ['it', 'it'], ['pt', 'pt'], ['pl', 'pl'], ['tr', 'tr'], ['zh', 'zh'], ['ja', 'ja'], ['ko', 'ko'], ['ar', 'ar']];
const STATUS = {
  queued: 'Queued…',
  loading: 'Loading the model (it is downloaded on the first run)…',
  running: 'Transcribing',
};

const ui = new Map();
const st = (id) => { if (!ui.has(id)) ui.set(id, { open: false, partial: [], status: '', progress: 0, error: '', poll: 0, since: 0, job: null, queue: 0, pick: new Set() }); return ui.get(id); };

let info = null;
const getInfo = () => (info ||= fetch('/api/transcribe/info').then((r) => r.json()).catch(() => ({ available: false })));

const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
export function tc(t) {
  t = Math.max(0, Math.floor(t));
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
  return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(s).padStart(2, '0');
}

export function createTranscript(item0, player) {
  let it = item0;
  const root = document.createElement('div');
  root.className = 'tr';
  root.dataset.nodrag = '1';
  root.innerHTML = '<div class="tr-head"></div><div class="tr-list scroll"></div><div class="tr-pick"></div>';
  const head = root.children[0], list = root.children[1], pickBar = root.children[2];
  let sig = '', listSig = '', segs = [], active = -1;

  const segments = () => (it.transcript ? it.transcript.segments : st(it.id).partial);

  async function start() {
    const u = st(it.id);
    u.error = '';
    u.partial = [];
    u.since = 0;
    u.status = 'queued';
    render(it, true);
    try {
      const j = await apiConfirm('/api/transcribe', { asset: it.url, model: S.whisper.model, language: S.whisper.lang || null });
      u.job = j.id;
      it.tjob = j.id;
      dirty();
      poll();
    } catch (e) {
      u.status = '';
      u.error = e.cancelled ? '' : e.message;
      render(it, true);
    }
  }

  function poll() {
    const u = st(it.id);
    clearTimeout(u.poll);
    u.poll = setTimeout(async () => {
      const jid = it.tjob || u.job;
      if (!jid) return;
      try {
        const r = await fetch(`/api/transcribe/${jid}?since=${u.since}`);
        if (r.status === 404) throw new Error('The job was lost (the server was restarted). Start it again.');
        const d = await r.json();
        u.job = jid;
        if (d.segments.length) { u.partial.push(...d.segments); u.since = d.total; }
        u.status = d.status; u.progress = d.progress; u.queue = d.queue; u.device = d.device;
        if (d.status === 'done') {
          it.transcript = { model: S.whisper.model, language: d.language, device: d.device, segments: u.partial.slice() };
          finish(u);
          dirty();
          touch([it.id]);
        } else if (d.status === 'error') { u.error = d.error; finish(u); }
        else if (d.status === 'cancelled') finish(u);
        else poll();
      } catch (e) {
        u.error = e.message;
        finish(u);
      }
      render(it, true);
    }, 900);
  }
  function finish(u) {
    u.status = '';
    u.job = null;
    if (it.tjob) { delete it.tjob; dirty(); }
  }

  async function cancel() {
    const u = st(it.id);
    if (u.job) await api(`/api/transcribe/${u.job}/cancel`, {}).catch(() => {});
  }

  function render(item, force = false) {
    it = item;
    const u = st(it.id);
    if (it.tjob && !u.job && !u.poll && !it.transcript) { u.job = it.tjob; u.status = 'queued'; poll(); }
    const s = segments();
    const key = [it.transcript ? 'T' + it.transcript.segments.length : 'P' + u.partial.length, u.status, Math.round(u.progress * 100), u.error, u.open, u.queue, S.whisper.model, S.whisper.lang].join('|');
    if (key === sig && !force) return;
    sig = key;
    segs = s;
    renderHead(u, s);
    renderList(u, s);
    root.classList.toggle('open', u.open && s.length > 0);
    root.classList.toggle('busy', !!u.status);
  }

  function renderHead(u, s) {
    const first = s[0];
    const line = first ? `<span class="tr-first"><b>${tc(first[0])}</b>${esc(first[2])}</span>` : '';
    const toggle = s.length ? `<button class="tr-tg" data-a="toggle" title="${u.open ? 'Collapse' : 'Expand'}">${u.open ? '▾' : '▸'}</button>` : '';
    if (u.status) {
      const label = u.status === 'running' ? `Transcribing ${Math.round(u.progress * 100)}%` : u.status === 'queued' && u.queue > 1 ? `Queued (${u.queue})…` : STATUS[u.status];
      head.innerHTML = `${toggle}<span class="tr-state"><i class="spin"></i>${label}</span>${line && !u.open ? `<span class="tr-last">${esc(s[s.length - 1][2])}</span>` : ''}<span class="grow"></span><button class="chip-s" data-a="cancel">Cancel</button><div class="tr-bar"><i style="width:${Math.round(u.progress * 100)}%"></i></div>`;
    } else if (it.transcript) {
      head.innerHTML = `${toggle}${line}<span class="tr-acts"><button data-a="quote" title="Quote into a note: the selected phrases (Ctrl/Shift+click a phrase) or the whole transcript">❝</button><button data-a="copy" title="Copy with timecodes">${I.copy}</button><button data-a="redo" title="Transcribe again">↻</button><button data-a="del" title="Delete the transcript">${I.trash}</button></span>`;
    } else {
      head.innerHTML = `${u.error ? `<span class="tr-err" title="${esc(u.error)}">⚠ ${esc(u.error)}</span><span class="grow"></span>` : ''}<button class="chip-s go" data-a="start" title="Recognize speech (faster-whisper), locally">${I.text}<span>Transcribe</span></button>
        <select data-a="model" title="Model">${MODELS.map(([v, t]) => `<option value="${v}" title="${t}" ${v === S.whisper.model ? 'selected' : ''}>${v}</option>`).join('')}</select>
        <select data-a="lang" title="Speech language">${LANGS.map(([v, t]) => `<option value="${v}" ${v === S.whisper.lang ? 'selected' : ''}>${t}</option>`).join('')}</select>`;
      getInfo().then((i) => { if (!i.available) { const b = head.querySelector('[data-a=start]'); if (b) { b.disabled = true; b.title = 'faster-whisper is not installed: run uv sync'; } } });
    }
  }

  function renderList(u, s) {
    const ls = s.length + '|' + (it.transcript ? 1 : 0);
    if (ls === listSig) return;
    const same = listSig && ls.split('|')[1] === listSig.split('|')[1] && s.length >= list.children.length;
    if (!same) list.innerHTML = '';
    for (let i = list.children.length; i < s.length; i++) {
      const row = document.createElement('div');
      row.className = 'seg';
      row.dataset.i = i;
      row.innerHTML = `<i class="pk" title="Pick the phrase for a quote (Ctrl/Shift+click)"></i><button class="tcb" title="Go to ${tc(s[i][0])}">${tc(s[i][0])}</button><span class="tx">${esc(s[i][2])}</span>`;
      list.appendChild(row);
    }
    listSig = ls;
    active = -1;
  }

  function renderPick(u) {
    list.querySelectorAll('.seg').forEach((r) => r.classList.toggle('pick', u.pick.has(+r.dataset.i)));
    pickBar.innerHTML = u.pick.size
      ? `<span>Phrases selected: ${u.pick.size}</span><button class="chip-s go" data-a="quote">❝ To a note</button><button class="chip-s" data-a="pickall">All</button><button class="chip-s" data-a="pickclear">Clear</button>`
      : '';
    root.classList.toggle('picking', u.pick.size > 0);
  }
  function quote(u) {
    const idx = u.pick.size ? [...u.pick].sort((a, b) => a - b) : segs.map((_, i) => i);
    bus.emit('quote', { id: it.id, name: it.name || '', segs: idx.map((i) => segs[i]) });
    u.pick.clear();
    renderPick(u);
  }

  root.addEventListener('click', (e) => {
    const row = e.target.closest('.seg');
    if (row) {
      const u = st(it.id), i = +row.dataset.i;
      if (e.target.closest('.pk') || e.ctrlKey || e.metaKey || e.shiftKey) {
        if (e.shiftKey && u.last != null) { const [a, b] = [Math.min(u.last, i), Math.max(u.last, i)]; for (let k = a; k <= b; k++) u.pick.add(k); }
        else u.pick.has(i) ? u.pick.delete(i) : u.pick.add(i);
        u.last = i;
        renderPick(u);
        return;
      }
      player.seekPlay(segs[i][0]);
      return;
    }
    const first = e.target.closest('.tr-first, .tr-last');
    const b = e.target.closest('[data-a]');
    const a = b ? b.dataset.a : first ? 'toggle' : '';
    const u = st(it.id);
    if (a === 'toggle') { u.open = !u.open; render(it, true); }
    else if (a === 'start') start();
    else if (a === 'cancel') cancel();
    else if (a === 'redo') { delete it.transcript; start(); }
    else if (a === 'del') { delete it.transcript; u.partial = []; u.open = false; dirty(); touch([it.id]); render(it, true); }
    else if (a === 'quote') quote(u);
    else if (a === 'pickclear') { u.pick.clear(); renderPick(u); }
    else if (a === 'pickall') { segs.forEach((_, i) => u.pick.add(i)); renderPick(u); }
    else if (a === 'copy') {
      const text = segs.map((s) => `[${tc(s[0])}] ${s[2]}`).join('\n');
      navigator.clipboard?.writeText(text).then(() => toast('Transcript copied', 1400));
    }
  });
  root.addEventListener('change', (e) => {
    const a = e.target.dataset.a;
    if (a === 'model') S.whisper.model = e.target.value;
    else if (a === 'lang') S.whisper.lang = e.target.value;
    else return;
    savePrefs();
  });

  return {
    root,
    render,
    onTime(t) {
      if (!segs.length || !root.classList.contains('open')) return;
      let lo = 0, hi = segs.length - 1, idx = -1;
      while (lo <= hi) { const mid = (lo + hi) >> 1; if (segs[mid][0] <= t + 0.05) { idx = mid; lo = mid + 1; } else hi = mid - 1; }
      if (idx >= 0 && t > segs[idx][1] + 1.5) idx = -1;
      if (idx === active) return;
      list.children[active]?.classList.remove('on');
      active = idx;
      const row = list.children[idx];
      if (!row) return;
      row.classList.add('on');
      const top = row.offsetTop, bottom = top + row.offsetHeight;
      if (top < list.scrollTop || bottom > list.scrollTop + list.clientHeight) list.scrollTop = top - list.clientHeight / 3;
    },
    destroy() { const u = st(it.id); clearTimeout(u.poll); u.poll = 0; },
  };
}
