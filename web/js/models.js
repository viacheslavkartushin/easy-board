import { S, bus, $, api, toast, savePrefs } from './store.js';
import { I } from './icons.js';

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const gb = (n) => (n >= 1e9 ? (n / 1e9).toFixed(1) + ' GB' : Math.max(1, Math.round(n / 1e6)) + ' MB');
const IDLE = { 0: 'never', 2: '2 min', 5: '5 min', 10: '10 min', 30: '30 min', 60: '1 hour' };

const box = document.createElement('div');
box.id = 'modelsbar';
box.className = 'panel';
document.body.appendChild(box);
let st = null, open = false, timer = 0, busyAction = false;

async function fetchState() {
  try { st = await (await fetch('/api/models')).json(); } catch { st = null; }
  if (open && box.contains(document.activeElement) && document.activeElement.tagName === 'INPUT' && document.activeElement.type === 'text' && document.activeElement.value !== document.activeElement.defaultValue) return; // don't overwrite what the user is typing
  render();
}
function schedule() {
  clearTimeout(timer);
  const fast = open || (st && (st.whisper.loading || st.vl.loading || st.vl.pull && !st.vl.pull.done));
  timer = setTimeout(async () => { await fetchState(); schedule(); }, fast ? 1500 : 6000);
}

function dot(on, busy) { return `<i class="md ${busy ? 'busy' : on ? 'on' : ''}"></i>`; }

function whisperRow(w) {
  const sel = S.whisper.model;
  let state;
  if (!w.available) state = '<span class="m-err">faster-whisper is not installed (uv sync)</span>';
  else if (w.loading) state = '<span class="m-busy"><i class="spin"></i>Loading into memory…</span>';
  else if (w.loaded) state = `<b>In memory</b> · ${w.model} · ${w.device === 'cuda' ? 'GPU' : 'CPU'}${w.pinned ? '' : ' · unloads itself after ' + (IDLE[w.idle] || w.idle + ' min') + ' idle'}${w.model !== sel ? `<div class="m-hint">“${sel}” is selected in the list — it will load on the next transcription</div>` : ''}`;
  else state = 'Unloaded — uses no memory';
  if (w.error) state += `<div class="m-err">⚠ ${esc(w.error)}</div>`;
  return `<div class="mrow" data-m="whisper">
    <div class="mh"><label class="tgl ${w.loaded || w.loading ? 'on' : ''} ${(!w.available || w.busy || w.loading) ? 'dis' : ''}" title="${w.loaded ? 'Unload from memory' : 'Load into memory and keep it until you switch it off'}"><input type="checkbox" data-a="w-toggle" ${w.loaded || w.loading ? 'checked' : ''} ${(!w.available || w.busy || w.loading) ? 'disabled' : ''}><i></i></label>
      <div class="mt"><b>Speech → text</b><span>Whisper</span></div></div>
    <div class="ms">${state}${w.busy ? '<div class="m-hint">Transcribing…</div>' : ''}</div>
    <div class="mc"><label>Model <select data-a="w-model">${w.models.map((m) => `<option ${m === sel ? 'selected' : ''}>${m}</option>`).join('')}</select></label>
      <label>Auto-unload <select data-a="w-idle">${st.idle_choices.map((c) => `<option value="${c}" ${c === w.idle ? 'selected' : ''}>${IDLE[c]}</option>`).join('')}</select></label></div>
  </div>`;
}

function engSel(v) {
  return `<label>Engine <select data-a="v-engine"><option value="llama" ${v.engine === 'llama' ? 'selected' : ''}>llama.cpp</option><option value="ollama" ${v.engine === 'ollama' ? 'selected' : ''}>Ollama</option></select></label>`;
}

function llamaRow(v) {
  const canToggle = v.configured && v.binary_ok && !v.busy && !v.loading;
  let state;
  if (v.loading) state = '<span class="m-busy"><i class="spin"></i>llama-server is loading the model…</span><div class="m-hint">On the first run with a Hugging Face repo, the model is downloaded first</div>';
  else if (v.loaded) state = `<b>In memory</b> · ${v.vram ? gb(v.vram) + ' VRAM' : 'llama-server is running'}${v.pinned ? '' : ' · unloads itself after ' + (v.idle ? (IDLE[v.idle] || v.idle + ' min') : 'never') + ' idle'}`;
  else if (!v.binary_ok) state = `<span class="m-err">${esc(v.binary_error)}</span>`;
  else if (!v.configured) state = 'Set the model below — a .gguf file or a Hugging Face repo';
  else state = 'Unloaded — uses no memory';
  if (v.error) state += `<div class="m-err">⚠ ${esc(v.error)}</div>${v.log && v.log.length ? `<pre class="m-log">${esc(v.log.join('\n'))}</pre>` : ''}`;
  return `<div class="mrow" data-m="vl">
    <div class="mh"><label class="tgl ${v.loaded || v.loading ? 'on' : ''} ${canToggle || v.loaded ? '' : 'dis'}" title="${v.loaded ? 'Stop llama-server and free the memory' : 'Start llama-server and keep it running until you switch it off'}"><input type="checkbox" data-a="v-toggle" ${v.loaded || v.loading ? 'checked' : ''} ${(canToggle || v.loaded) && !v.busy ? '' : 'disabled'}><i></i></label>
      <div class="mt"><b>Text in images</b><span>VL model · llama.cpp</span></div></div>
    <div class="ms">${state}${v.busy ? '<div class="m-hint">Recognizing…</div>' : ''}</div>
    <div class="mc mcol">
      <label>llama-server <input data-a="l-bin" value="${esc(v.bin)}" placeholder="llama-server or C:\\llama\\llama-server.exe"></label>
      <label>Model <input data-a="l-model" value="${esc(v.model)}" placeholder="C:\\models\\GLM-OCR-Q8_0.gguf or ggml-org/GLM-OCR-GGUF"></label>
      <label>mmproj <input data-a="l-mmproj" value="${esc(v.mmproj)}" placeholder="mmproj-….gguf file (needed for a .gguf; not needed for a repo)"></label>
      <label>Arguments <input data-a="l-args" value="${esc(v.args)}"></label>
      <div class="mrow2">${engSel(v)}<label>Auto-unload <select data-a="v-idle">${st.idle_choices.map((c) => `<option value="${c}" ${c === v.idle ? 'selected' : ''}>${IDLE[c]}</option>`).join('')}</select></label></div>
    </div>
  </div>`;
}

function vlRow(v) {
  if (v.engine === 'llama') return llamaRow(v);
  let state, canToggle = v.reachable && v.installed && !v.busy;
  const p = v.pull;
  if (!v.reachable) state = `<span class="m-err">Ollama is not running.</span> Install it from <b>ollama.com</b> and start it — the model will be found automatically.<div class="m-hint">${esc(v.host)}</div>`;
  else if (p && !p.done) {
    const pct = p.total ? Math.round((p.completed / p.total) * 100) : 0;
    state = `<span class="m-busy"><i class="spin"></i>Downloading ${esc(p.model)}: ${pct}%</span><div class="mbar"><i style="width:${pct}%"></i></div><button class="chip-s" data-a="v-cancelpull">Cancel</button>`;
  } else if (!v.installed) state = `Model “${esc(v.model)}” is not downloaded. <button class="chip-s go" data-a="v-pull">Download</button>${p?.error ? `<div class="m-err">⚠ ${esc(p.error)}</div>` : ''}`;
  else if (v.loaded) {
    const where = v.vram >= v.size * 0.95 ? 'GPU' : v.vram > 0 ? `partly on the GPU (${gb(v.vram)} of ${gb(v.size)})` : 'CPU (RAM)';
    state = `<b>In memory</b> · ${gb(v.size)} · ${where}${v.pinned ? '' : ' · unloads itself after ' + (v.idle ? (IDLE[v.idle] || v.idle + ' min') : 'never') + ' idle'}`;
  } else state = 'Unloaded — uses no memory';
  if (v.error && v.reachable) state += `<div class="m-err">⚠ ${esc(v.error)}</div>`;
  const names = new Set(v.suggested.map((s) => s.name));
  const opts = v.suggested.map((s) => `<option value="${s.name}" title="${esc(s.title)}" ${s.name === v.model ? 'selected' : ''}>${s.name}</option>`).join('') +
    v.installed_models.filter((n) => !names.has(n) && !names.has(n.replace(/:latest$/, ''))).map((n) => `<option value="${esc(n)}" ${n === v.model ? 'selected' : ''}>${esc(n)}</option>`).join('') +
    (names.has(v.model) || v.installed_models.includes(v.model) ? '' : `<option selected>${esc(v.model)}</option>`) + '<option value="__custom">other…</option>';
  return `<div class="mrow" data-m="vl">
    <div class="mh"><label class="tgl ${v.loaded ? 'on' : ''} ${canToggle ? '' : 'dis'}" title="${v.loaded ? 'Unload from memory' : 'Load into memory and keep it until you switch it off'}"><input type="checkbox" data-a="v-toggle" ${v.loaded ? 'checked' : ''} ${canToggle ? '' : 'disabled'}><i></i></label>
      <div class="mt"><b>Text in images</b><span>VL model · Ollama</span></div></div>
    <div class="ms">${state}${v.busy ? '<div class="m-hint">Recognizing…</div>' : ''}</div>
    <div class="mc"><label>Model <select data-a="v-model">${opts}</select></label>
      ${engSel(v)}<label>Auto-unload <select data-a="v-idle">${st.idle_choices.map((c) => `<option value="${c}" ${c === v.idle ? 'selected' : ''}>${IDLE[c]}</option>`).join('')}</select></label></div>
  </div>`;
}

function render() {
  const any = st && (st.whisper.loaded || st.vl.loaded);
  const busy = st && (st.whisper.loading || st.vl.loading || (st.vl.pull && !st.vl.pull.done));
  const head = `<button class="tb mb-btn ${open ? 'on' : ''}" data-a="open" title="Models in memory: Whisper and text recognition">${I.chip}${dot(any, busy)}</button>`;
  if (!open || !st) { box.innerHTML = head; box.classList.remove('open'); return; }
  box.classList.add('open');
  box.innerHTML = `${head}<div class="mbody"><div class="mtitle">Models in memory<span>Switch on — the model loads and waits. Switch off — the memory is freed.</span></div>${whisperRow(st.whisper)}${vlRow(st.vl)}</div>`;
}

async function act(path, body, okMsg) {
  if (busyAction) return;
  busyAction = true;
  try { await api(path, body); if (okMsg) toast(okMsg, 1200); } catch (e) { toast(e.message, 4500); } finally { busyAction = false; }
  await fetchState(); schedule();
}

box.addEventListener('click', (e) => {
  if (e.target.closest('[data-a=open]')) { open = !open; render(); if (open) fetchState(); schedule(); return; }
  const a = e.target.closest('button[data-a]')?.dataset.a;
  if (a === 'v-pull') act('/api/models/vl', { action: 'pull' });
  else if (a === 'v-cancelpull') act('/api/models/vl', { action: 'cancelpull' });
});
box.addEventListener('change', async (e) => {
  const a = e.target.dataset.a;
  if (a === 'w-toggle') await act('/api/models/whisper', { action: e.target.checked ? 'load' : 'unload', model: S.whisper.model });
  else if (a === 'v-toggle') await act('/api/models/vl', { action: e.target.checked ? 'load' : 'unload' });
  else if (a === 'w-model') { S.whisper.model = e.target.value; savePrefs(); render(); }
  else if (a === 'w-idle') await act('/api/models/settings', { whisper_idle: +e.target.value });
  else if (a === 'v-engine') await act('/api/models/settings', { vl_engine: e.target.value });
  else if (a === 'l-bin') await act('/api/models/settings', { llama_bin: e.target.value });
  else if (a === 'l-model') await act('/api/models/settings', { llama_model: e.target.value });
  else if (a === 'l-mmproj') await act('/api/models/settings', { llama_mmproj: e.target.value });
  else if (a === 'l-args') await act('/api/models/settings', { llama_args: e.target.value });
  else if (a === 'v-idle') await act('/api/models/settings', { vl_idle: +e.target.value });
  else if (a === 'v-model') {
    let v = e.target.value;
    if (v === '__custom') { v = (prompt('Ollama model name (for example, qwen3-vl:4b or minicpm-v):') || '').trim(); if (!v) return fetchState(); }
    await act('/api/models/settings', { vl_model: v });
  }
});
window.addEventListener('pointerdown', (e) => { if (open && !box.contains(e.target)) { open = false; render(); schedule(); } });
bus.on('models-changed', () => { fetchState(); });
bus.on('openmodels', () => { open = true; render(); fetchState(); schedule(); });
fetchState().then(schedule);
