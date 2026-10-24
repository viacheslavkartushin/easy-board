import { api } from './store.js';

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export function askDownload(info) {
  const run = info.kind === 'run';
  const body = run
    ? `<div class="dm">Easy Board is about to start <b>${esc(info.what)}</b>: a separate, third-party program (llama.cpp) that is not part of Easy Board. It will run on your computer with your user's permissions until you switch the model off or it is unloaded after idle time.</div>
        <div class="dm">Program:<br><code>${esc(info.program)}</code></div>
        <div class="dm">Command:<br><code>${esc(info.command)}</code></div>
        <a class="dl-url" href="${esc(info.url)}" target="_blank" rel="noopener noreferrer">${esc(info.url)}</a>
        <div class="dm">Only continue if you trust this file and these arguments. You will be asked again if either changes.</div>`
    : `<div class="dm"><b>${esc(info.what)}</b> is not on this computer yet. If you continue, it will be downloaded from the internet (${esc(info.source)}):</div>
        <a class="dl-url" href="${esc(info.url)}" target="_blank" rel="noopener noreferrer">${esc(info.url)}</a>
        <div class="dm">Size: ${esc(info.size)}.<br>Saved to: <code>${esc(info.dest)}</code></div>`;
  return new Promise((resolve) => {
    const root = document.createElement('div');
    root.id = 'modal';
    root.innerHTML = `<div class="dlg dl-confirm" role="dialog" aria-modal="true">
      <div class="dh"><b>${run ? 'Run an external program?' : 'Download a model?'}</b></div>
      <div class="db">${body}
        <div class="dact"><span class="grow"></span><button class="chip-s" data-a="no">Cancel</button><button class="chip-s go" data-a="yes">${run ? 'Run' : 'Download'}</button></div>
      </div></div>`;
    document.body.appendChild(root);
    const done = (v) => { root.remove(); window.removeEventListener('keydown', key, true); resolve(v); };
    const key = (e) => { if (e.key === 'Escape') { e.stopPropagation(); done(false); } };
    window.addEventListener('keydown', key, true);
    root.addEventListener('click', (e) => { const a = e.target.closest('[data-a]')?.dataset.a; if (a) done(a === 'yes'); });
    root.querySelector('[data-a=no]').focus();
  });
}

// Calls the API; while the server asks for a confirmation (run a program, download a model), asks the user and repeats the call.
export async function apiConfirm(path, body) {
  const confirmed = {};
  for (let i = 0; i < 4; i++) {
    try {
      return await api(path, { ...body, confirmed });
    } catch (e) {
      if (!e.confirm) throw e;
      if (confirmed[e.confirm.kind || 'download']) throw new Error('The server did not accept the confirmation. Restart Easy Board: the running server is probably an older version.');
      if (!(await askDownload(e.confirm))) throw Object.assign(new Error('Cancelled'), { cancelled: true });
      confirmed[e.confirm.kind || 'download'] = true;
    }
  }
  throw new Error('Confirmation failed');
}
