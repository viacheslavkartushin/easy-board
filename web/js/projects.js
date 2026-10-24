import { S, api, flush, $, toast } from './store.js';
import { I } from './icons.js';
import { openHistory, openCache } from './dialogs.js';

const bar = $('#projbar');
bar.innerHTML = `<button id="projbtn" title="Projects"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg><span></span><span style="opacity:.5">▾</span></button>
<div id="projmenu"></div>
<input type="file" id="zipin" accept=".zip,application/zip" hidden>`;
const btn = $('#projbtn'), menu = $('#projmenu'), zipin = $('#zipin');
let editing = null, confirming = null;

const open = async (id) => { await flush(); location.search = '?p=' + id; };
const when = (t) => new Date(t * 1000).toLocaleString('en-US', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function setName(name) {
  btn.firstElementChild.nextElementSibling.textContent = name;
  document.title = name + ' — Board';
}

async function refresh() {
  S.projects = await (await fetch('/api/projects')).json();
  render();
}

function render() {
  const rows = S.projects.map((p) => {
    const cur = p.id === S.project.id;
    if (editing === p.id) {
      return `<div class="prow edit ${cur ? 'cur' : ''}" data-id="${p.id}"><input data-r value="${esc(p.name)}" maxlength="80"><span class="pa"><button data-a="ok" title="Save">${I.check}</button></span></div>`;
    }
    if (confirming === p.id) {
      return `<div class="prow edit" data-id="${p.id}"><span class="pn">Delete “${esc(p.name)}”?</span><span class="pa"><button class="yes" data-a="yes">Delete</button><button data-a="no">Cancel</button></span></div>`;
    }
    return `<div class="prow ${cur ? 'cur' : ''}" data-id="${p.id}" data-a="open"><span class="pn">${esc(p.name)}</span><span class="pd">${when(p.updated)}</span>
      <span class="pa"><button data-a="rename" title="Rename">${I.pen}</button><button data-a="dup" title="Duplicate">${I.copy}</button><button data-a="export" title="Export to .zip (board + files)">${I.upload}</button><button data-a="del" title="Delete (goes to data/trash)">${I.trash}</button></span></div>`;
  }).join('');
  menu.innerHTML = `${rows}<div class="psep"></div>
    <div class="pnew"><input id="pnname" placeholder="New project" maxlength="80"><button data-a="create">Create</button></div>
    <div class="pfoot"><button data-a="import" title="Load a project from a .zip made by export">Import from .zip…</button><button data-a="history" title="Automatic snapshots and manual versions of the current project, restore">Version history…</button><button data-a="cache" title="Which files are in data/assets and which are no longer needed by anyone">Files and cache…</button></div>`;
  const inp = menu.querySelector('input[data-r]');
  if (inp) { inp.focus(); inp.select(); }
}

btn.addEventListener('click', async () => {
  menu.classList.toggle('open');
  if (menu.classList.contains('open')) { editing = confirming = null; await refresh(); }
});
window.addEventListener('pointerdown', (e) => { if (!bar.contains(e.target)) menu.classList.remove('open'); });
window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && menu.classList.contains('open')) { menu.classList.remove('open'); e.stopPropagation(); } }, true);

menu.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-a]');
  if (!b) return;
  const row = b.closest('.prow');
  const id = row?.dataset.id;
  const a = b.dataset.a;
  try {
    if (a === 'open') { if (id !== S.project.id) await open(id); else menu.classList.remove('open'); }
    else if (a === 'rename') { e.stopPropagation(); editing = id; render(); }
    else if (a === 'ok') await commitRename(row);
    else if (a === 'dup') { e.stopPropagation(); await api(`/api/projects/${id}/duplicate`, {}); toast('Copy created', 1500); await refresh(); }
    else if (a === 'export') { e.stopPropagation(); await flush(); const l = document.createElement('a'); l.href = `/api/projects/${id}/export`; l.download = ''; l.click(); }
    else if (a === 'del') { e.stopPropagation(); confirming = id; render(); }
    else if (a === 'no') { e.stopPropagation(); confirming = null; render(); }
    else if (a === 'yes') {
      e.stopPropagation();
      await api(`/api/projects/${id}/delete`, {});
      confirming = null;
      if (id === S.project.id) { try { localStorage.removeItem('board.last'); } catch { /* ignore */ } location.search = ''; return; }
      await refresh();
    } else if (a === 'create') {
      const name = $('#pnname').value.trim() || 'New project';
      const p = await api('/api/projects', { name });
      await open(p.id);
    } else if (a === 'import') zipin.click();
    else if (a === 'history') { menu.classList.remove('open'); openHistory(); }
    else if (a === 'cache') { menu.classList.remove('open'); openCache(); }
  } catch (err) { toast('Error: ' + err.message, 4000); }
});
menu.addEventListener('keydown', async (e) => {
  e.stopPropagation();
  if (e.key !== 'Enter' && e.key !== 'Escape') return;
  if (e.target.matches('[data-r]')) {
    if (e.key === 'Enter') await commitRename(e.target.closest('.prow'));
    else { editing = null; render(); }
  } else if (e.target.id === 'pnname' && e.key === 'Enter') menu.querySelector('[data-a=create]').click();
});

async function commitRename(row) {
  const id = row.dataset.id;
  const name = row.querySelector('input').value.trim();
  editing = null;
  if (name) {
    await api(`/api/projects/${id}/rename`, { name });
    if (id === S.project.id) { S.project.name = name; setName(name); }
  }
  await refresh();
}

zipin.addEventListener('change', async () => {
  const f = zipin.files[0];
  zipin.value = '';
  if (!f) return;
  try {
    toast('Importing…', 1500);
    const r = await fetch('/api/projects/import?name=' + encodeURIComponent(f.name.replace(/\.(board\.)?zip$/i, '')), { method: 'POST', headers: { 'X-Board': '1' }, body: f });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || r.status);
    await open(d.id);
  } catch (err) { toast('Import failed: ' + err.message, 5000); }
});

export function initProjectsUI() { setName(S.project.name); }
