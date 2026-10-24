import { S, bus, api, dirty, touch, toast } from './store.js';
import { I } from './icons.js';

const ui = new Map();
const st = (id) => { if (!ui.has(id)) ui.set(id, { open: false, status: '', text: '', error: '', poll: 0, job: null, queue: 0 }); return ui.get(id); };
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const firstLine = (t) => (String(t).split('\n').map((l) => l.trim()).find(Boolean) || '').slice(0, 160);

export function createOcr(item0) {
  let it = item0;
  const root = document.createElement('div');
  root.className = 'tr oc';
  root.dataset.nodrag = '1';
  root.innerHTML = '<div class="tr-head"></div><div class="tr-list scroll"></div>';
  const head = root.children[0], list = root.children[1];
  let sig = '';

  async function start() {
    const u = st(it.id);
    u.error = ''; u.text = ''; u.status = 'queued';
    render(it, true);
    try {
      const j = await api('/api/ocr', { asset: it.url });
      u.job = j.id; it.ojob = j.id; dirty();
      poll();
    } catch (e) { u.status = ''; u.error = e.message; render(it, true); }
  }
  function poll() {
    const u = st(it.id);
    clearTimeout(u.poll);
    u.poll = setTimeout(async () => {
      const jid = it.ojob || u.job;
      if (!jid) return;
      try {
        const r = await fetch(`/api/ocr/${jid}`);
        if (r.status === 404) throw new Error('The job was lost (the server was restarted). Start it again.');
        const d = await r.json();
        u.job = jid; u.status = d.status; u.text = d.text; u.queue = d.queue;
        if (d.status === 'done') {
          it.ocr = { model: d.model, text: d.text, at: Math.floor(Date.now() / 1000) };
          done(u); dirty(); touch([it.id]);
          bus.emit('models-changed');
        } else if (d.status === 'error') { u.error = d.error; done(u); bus.emit('models-changed'); }
        else if (d.status === 'cancelled') done(u);
        else poll();
        if (d.status === 'running') u.open = true;
      } catch (e) { u.error = e.message; done(u); }
      render(it, true);
    }, 600);
  }
  function done(u) { u.status = ''; u.job = null; if (it.ojob) { delete it.ojob; dirty(); } }

  function render(item, force = false) {
    it = item;
    const u = st(it.id);
    if (it.ojob && !u.job && !u.poll && !it.ocr) { u.job = it.ojob; u.status = 'queued'; poll(); }
    const text = it.ocr ? it.ocr.text : u.text;
    const key = [text.length, u.status, u.error, u.open, u.queue, it.ocr ? it.ocr.at : 0].join('|');
    if (key === sig && !force) return;
    sig = key;
    const has = !!text;
    const toggle = has ? `<button class="tr-tg" data-a="toggle" title="${u.open ? 'Collapse' : 'Expand'}">${u.open ? '▾' : '▸'}</button>` : '';
    if (u.status) {
      const label = u.status === 'queued' ? (u.queue > 1 ? `Queued (${u.queue})…` : 'Queued…') : u.status === 'loading' ? 'Loading the model into memory…' : 'Recognizing…';
      head.innerHTML = `${toggle}<span class="tr-state"><i class="spin"></i>${label}</span><span class="grow"></span><button class="chip-s" data-a="cancel">Cancel</button>`;
    } else if (it.ocr) {
      head.innerHTML = `${toggle}<span class="tr-first" title="${esc(it.ocr.model || '')}">${esc(firstLine(it.ocr.text)) || '<i style="opacity:.5">no text found</i>'}</span><span class="tr-acts"><button data-a="note" title="Text to a new note">❝</button><button data-a="copy" title="Copy text">${I.copy}</button><button data-a="redo" title="Recognize again">↻</button><button data-a="del" title="Delete the recognized text">${I.trash}</button></span>`;
    } else {
      head.innerHTML = `${u.error ? `<span class="tr-err" title="${esc(u.error)}">⚠ ${esc(u.error)}</span><span class="grow"></span>` : ''}<button class="chip-s go" data-a="start" title="Recognize the text in the image with the model from the Models panel (local)">${I.text}<span>Recognize text</span></button>`;
    }
    list.innerHTML = has ? `<pre class="oc-text" data-nodrag>${esc(text)}</pre>` : '';
    root.classList.toggle('open', u.open && has);
    root.classList.toggle('busy', !!u.status);
  }

  root.addEventListener('click', (e) => {
    const first = e.target.closest('.tr-first');
    const b = e.target.closest('[data-a]');
    const a = b ? b.dataset.a : first ? 'toggle' : '';
    const u = st(it.id);
    if (a === 'toggle') { u.open = !u.open; render(it, true); }
    else if (a === 'start') start();
    else if (a === 'cancel') { if (u.job) api(`/api/ocr/${u.job}/cancel`, {}).catch(() => {}); }
    else if (a === 'redo') { delete it.ocr; start(); }
    else if (a === 'del') { delete it.ocr; u.text = ''; u.open = false; dirty(); touch([it.id]); render(it, true); }
    else if (a === 'copy') navigator.clipboard?.writeText(it.ocr?.text || '').then(() => toast('Text copied', 1300));
    else if (a === 'note') bus.emit('ocrnote', { id: it.id, text: it.ocr?.text || '' });
  });
  return { root, render, destroy() { const u = st(it.id); clearTimeout(u.poll); u.poll = 0; } };
}
