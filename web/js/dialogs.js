import { S, $, api, flush, toast } from './store.js';

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const mb = (n) => (n >= 1073741824 ? (n / 1073741824).toFixed(2) + ' GB' : n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : (n > 0 ? Math.max(1, Math.round(n / 1024)) : 0) + ' KB');
const when = (t) => new Date(t * 1000).toLocaleString('en-US', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit', second: '2-digit' });
const ago = (t) => {
  const s = Math.max(0, Date.now() / 1000 - t);
  if (s < 90) return 'just now';
  if (s < 3600) return Math.round(s / 60) + ' min ago';
  if (s < 86400) return Math.round(s / 3600) + ' h ago';
  return Math.round(s / 86400) + ' d ago';
};

let root = null;
function modal(title, body) {
  close();
  root = document.createElement('div');
  root.id = 'modal';
  root.innerHTML = `<div class="dlg"><div class="dh"><b>${esc(title)}</b><button class="x" title="Close (Esc)">✕</button></div><div class="db">${body}</div></div>`;
  document.body.appendChild(root);
  root.addEventListener('pointerdown', (e) => { if (e.target === root) close(); });
  root.querySelector('.x').addEventListener('click', close);
  return root.querySelector('.db');
}
export function close() { root?.remove(); root = null; }
window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && root) { close(); e.stopPropagation(); } }, true);

export async function openHistory() {
  const db = modal('Version history', '<div class="dm">Loading…</div>');
  const pid = S.project.id;
  let confirming = null;
  async function render() {
    let list;
    try { list = await (await fetch(`/api/projects/${pid}/history`)).json(); } catch { db.innerHTML = '<div class="dm">Could not load history</div>'; return; }
    db.innerHTML = `<div class="dm">Auto-snapshots are taken at most once every 10 minutes when something changed. Older ones are thinned out over time: the last 6 hours are all kept, the last week one per hour, after that one per day. Manual versions are kept until you delete them. The current state is also saved before a restore.</div>
      <div class="dact"><button class="chip-s go" data-a="snap">＋ Save a version now</button></div>
      <div class="dlist">${list.map((h) => `<div class="drow ${confirming === h.t ? 'conf' : ''}" data-t="${h.t}">
        <div class="dmain"><b>${when(h.t)}</b> <span class="dsub">${ago(h.t)}</span>${h.manual ? '<span class="badge">manual</span>' : ''}<div class="dsub">${h.cards ?? '?'} cards · ${mb(h.size)}</div></div>
        ${confirming === h.t ? '<span class="dq">Replace the current board with this version?</span><button class="chip-s go" data-a="yes">Yes, restore</button><button class="chip-s" data-a="no">Cancel</button>' : '<button class="chip-s" data-a="restore">Restore</button><button class="chip-s" data-a="del" title="Delete snapshot">✕</button>'}
      </div>`).join('') || '<div class="dm">No snapshots yet — they will appear after the first changes.</div>'}</div>`;
  }
  db.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-a]');
    if (!b) return;
    const t = +b.closest('.drow')?.dataset.t;
    try {
      if (b.dataset.a === 'snap') { await flush(); await api(`/api/projects/${pid}/snapshot`, {}); toast('Version saved', 1500); }
      else if (b.dataset.a === 'restore') confirming = t;
      else if (b.dataset.a === 'no') confirming = null;
      else if (b.dataset.a === 'del') await api(`/api/projects/${pid}/snapshot-delete`, { t });
      else if (b.dataset.a === 'yes') { await flush(); await api(`/api/projects/${pid}/restore`, { t }); location.reload(); return; }
      await render();
    } catch (err) { toast('Error: ' + err.message, 4000); }
  });
  await render();
}

export async function openCache() {
  const db = modal('Files and cache', '<div class="dm">Counting…</div>');
  let d;
  try { d = await (await fetch('/api/assets/unused')).json(); } catch { db.innerHTML = '<div class="dm">Could not load the list</div>'; return; }
  const sel = new Set(d.unused.map((u) => u.name));
  const draw = () => {
    const chosen = d.unused.filter((u) => sel.has(u.name));
    db.innerHTML = `<div class="dm">Total files: <b>${d.files}</b> (${mb(d.total)}). Not used by any card, project or saved version: <b>${d.unused.length}</b> (${mb(d.unused_size)}).<br>These are downloaded pages, images and files of deleted cards. Deletion cannot be undone.</div>
      ${d.unused.length ? `<div class="dact"><button class="chip-s" data-a="all">Select all</button><button class="chip-s" data-a="none">Clear selection</button><span class="grow"></span><button class="chip-s danger" data-a="rm" ${chosen.length ? '' : 'disabled'}>Delete selected (${chosen.length}, ${mb(chosen.reduce((s, u) => s + u.size, 0))})</button></div>
      <div class="dlist">${d.unused.map((u) => {
    const ext = (u.name.split('.')[1] || '').toLowerCase();
    const img = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'svg', 'bmp', 'ico'].includes(ext);
    return `<label class="drow cr"><input type="checkbox" data-n="${u.name}" ${sel.has(u.name) ? 'checked' : ''}>${img ? `<img src="/assets/${u.name}" loading="lazy" alt="">` : `<span class="ext">${esc(ext || 'file')}</span>`}<span class="dmain">${u.name}<div class="dsub">${mb(u.size)} · ${ago(u.mtime)}</div></span></label>`;
  }).join('')}</div>` : ''}`;
  };
  db.addEventListener('change', (e) => { const n = e.target.dataset.n; if (n) { e.target.checked ? sel.add(n) : sel.delete(n); draw(); } });
  db.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-a]');
    if (!b) return;
    if (b.dataset.a === 'all') d.unused.forEach((u) => sel.add(u.name));
    else if (b.dataset.a === 'none') sel.clear();
    else if (b.dataset.a === 'rm') {
      try {
        const r = await api('/api/assets/delete', { names: [...sel] });
        toast(`Deleted files: ${r.deleted}, freed ${mb(r.size)}`, 3500);
        d = await (await fetch('/api/assets/unused')).json();
        sel.clear(); d.unused.forEach((u) => sel.add(u.name));
      } catch (err) { toast('Error: ' + err.message, 4000); }
    }
    draw();
  });
  draw();
}
