import { S, bus, mark, commit, touch, dirty, toast, $ } from './store.js';
import { I } from './icons.js';
import { createTranscript } from './transcript.js';
import { fixWav } from './wav.js';

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

function fmt(t) {
  t = Math.max(0, Math.floor(t || 0));
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
  return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(s).padStart(2, '0');
}
function fmtP(t) {
  t = Math.max(0, t || 0);
  const m = Math.floor(t / 60), s = t - m * 60;
  return m + ':' + (s < 10 ? '0' : '') + s.toFixed(2);
}
export function parseTime(str) {
  const parts = String(str).trim().replace(',', '.').split(':').map(Number);
  if (!parts.length || parts.some((n) => !isFinite(n) || n < 0)) return null;
  return parts.reduce((acc, n) => acc * 60 + n, 0);
}

const peakCache = new Map();
async function computePeaks(url) {
  if (peakCache.has(url)) return peakCache.get(url);
  const p = (async () => {
    const r = await fetch(url);
    if (+r.headers.get('content-length') > 60e6) return null;
    const buf = await r.arrayBuffer();
    const AC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    const dec = (b) => new AC(1, 44100, 44100).decodeAudioData(b);
    const ab = await dec(buf.slice(0)).catch(async () => (url.endsWith('.wav') ? dec(await (await fetch(await fixWav(url))).arrayBuffer()) : Promise.reject()));
    const N = 600, peaks = new Array(N).fill(0), len = ab.length, per = len / N;
    for (let c = 0; c < ab.numberOfChannels; c++) {
      const d = ab.getChannelData(c);
      for (let i = 0; i < N; i++) {
        const a = Math.floor(i * per), b = Math.min(len, Math.floor((i + 1) * per));
        const st = Math.max(1, Math.floor((b - a) / 200));
        let mx = 0;
        for (let j = a; j < b; j += st) { const v = Math.abs(d[j]); if (v > mx) mx = v; }
        if (mx > peaks[i]) peaks[i] = mx;
      }
    }
    const top = Math.max(...peaks) || 1;
    return peaks.map((v) => Math.round((v / top) * 100));
  })().catch(() => null);
  peakCache.set(url, p);
  return p;
}

const players = new Map();
bus.on('seek', ({ id, t }) => players.get(id)?.(t));

export function createMedia(kind, item0) {
  let it = item0;
  let editing = false;
  let dur = 0;
  let raf = 0;
  const root = document.createElement('div');
  root.className = 'media ' + kind;
  root.innerHTML = `
    <div class="mv">${kind === 'audio' ? '<div class="mt">' + I.audio + '<span></span></div>' : ''}${kind === 'video' ? '<video preload="metadata" playsinline></video><div class="mv-hit"><span class="bigplay">' + I.play + '</span></div>' : ''}</div>
    <div class="mc" data-nodrag>
      <button class="pp" title="Play / pause (selected range only)">${I.play}</button>
      <div class="track" data-nodrag><canvas class="wave"></canvas><div class="rng"></div><div class="fill"></div><div class="h hs" title="Start"></div><div class="h he" title="End"></div><div class="ph"></div></div>
      <span class="tm"></span>
      <button class="mute" title="Sound">${I.vol}</button>
      <input class="vol" type="range" min="0" max="1" step="0.05" value="1" title="Volume">
      ${kind === 'video' ? `<button class="fs" title="Fullscreen">${I.full}</button>` : ''}
    </div>
    <div class="me" data-nodrag>
      <label>Start <input class="ts" spellcheck="false"></label>
      <button class="cs" title="Use current position as start">⌖</button>
      <label>End <input class="te" spellcheck="false"></label>
      <button class="ce" title="Use current position as end">⌖</button>
      <button class="rr" title="Play the whole file">Whole file</button>
    </div>`;
  const q = (s) => root.querySelector(s);
  const m = kind === 'video' ? q('video') : new Audio();
  m.preload = 'metadata';
  const pp = q('.pp'), track = q('.track'), wave = q('.wave'), rng = q('.rng'), fill = q('.fill');
  const hs = q('.hs'), he = q('.he'), ph = q('.ph'), tm = q('.tm');
  const inS = q('.ts'), inE = q('.te'), mute = q('.mute'), vol = q('.vol');

  let srcFor = null, wavTimer = 0;
  // Firefox rejects some WAV encodings (or never reports a length): re-encode to 16-bit PCM and play that copy
  function watchWav(u) {
    clearTimeout(wavTimer);
    if (kind !== 'audio' || !u.endsWith('.wav')) return;
    const fix = async () => {
      if (srcFor !== u || m.dataset.fixed === u) return;
      m.dataset.fixed = u;
      try { m.src = await fixWav(u); } catch (e) { toast('Cannot play this WAV: ' + e.message, 5000); }
    };
    m.onerror = fix;
    wavTimer = setTimeout(() => { if (!(m.duration > 0)) fix(); }, 2500);
  }

  let override = false; // Transcript-click playback may leave the selected range
  const seekPlay = (t) => {
    override = t < S0() - 0.05 || t >= E0() - 0.05;
    m.currentTime = t;
    m.play().catch(() => {});
  };
  players.set(item0.id, seekPlay);
  const trn = createTranscript(it, { seekPlay });
  root.appendChild(trn.root);

  const S0 = () => it.start || 0;
  const E0 = () => {
    const e = it.end == null ? dur : Math.min(it.end, dur || it.end);
    return Math.max(e, S0() + 0.05);
  };

  function update() {
    const s = S0(), e = E0(), t = m.currentTime || 0;
    if (editing) {
      const d = dur || 1;
      rng.style.left = (s / d) * 100 + '%';
      rng.style.width = ((e - s) / d) * 100 + '%';
      hs.style.left = (s / d) * 100 + '%';
      he.style.left = (e / d) * 100 + '%';
      ph.style.left = (t / d) * 100 + '%';
      tm.textContent = `${fmtP(t)} / ${fmtP(dur)}`;
    } else {
      fill.style.width = clamp((t - s) / (e - s), 0, 1) * 100 + '%';
      tm.textContent = `${fmt(Math.max(0, t - s))} / ${fmt(e - s)}`;
    }
    if (document.activeElement !== inS) inS.value = fmtP(s);
    if (document.activeElement !== inE) inE.value = fmtP(e);
    const ppState = m.paused ? 'play' : 'pause';
    if (pp.dataset.s !== ppState) { pp.dataset.s = ppState; pp.innerHTML = m.paused ? I.play : I.pause; }  // Don't rewrite the icon each frame: Firefox loses a click if the node under the cursor is replaced
    trn.onTime(t);
    const big = q('.bigplay');
    if (big) big.style.opacity = m.paused ? '1' : '0';
  }

  function tick() {
    raf = 0;
    if (!m.paused) {
      if (m.currentTime >= E0() - 0.02 && !override) { m.pause(); m.currentTime = S0(); }
      else raf = requestAnimationFrame(tick);
    }
    update();
  }

  function toggle() {
    override = false;
    if (m.paused) {
      const s = S0(), e = E0();
      if (m.currentTime < s - 0.05 || m.currentTime >= e - 0.05) m.currentTime = s;
      m.play().catch(() => {});
    } else m.pause();
  }

  m.addEventListener('play', () => { if (!raf) raf = requestAnimationFrame(tick); update(); });
  m.addEventListener('pause', update);
  m.addEventListener('seeked', update);
  m.addEventListener('timeupdate', () => { if (m.paused) update(); });
  m.addEventListener('ended', () => { override = false; m.currentTime = S0(); update(); });
  m.addEventListener('loadedmetadata', () => {
    dur = isFinite(m.duration) ? m.duration : 0;
    if (kind === 'video' && m.videoWidth && !it.ar) {
      it.ar = m.videoWidth / m.videoHeight;
      dirty();
      touch([it.id]);
    }
    if (m.currentTime < S0()) m.currentTime = S0();
    update();
    if (editing) loadWave();
  });
  pp.addEventListener('click', toggle);
  const hit = q('.mv-hit');
  if (hit) hit.addEventListener('click', () => { if (!S.moved) toggle(); });
  mute.addEventListener('click', () => { m.muted = !m.muted; mute.innerHTML = m.muted ? I.mute : I.vol; });
  vol.addEventListener('input', () => { m.volume = +vol.value; });
  const fs = q('.fs');
  if (fs) fs.addEventListener('click', () => (document.fullscreenElement ? document.exitFullscreen() : q('.mv').requestFullscreen?.()));

  let dragging = null;
  const setRange = (key, val) => {
    if (key === 's') it.start = clamp(val, 0, E0() - 0.1);
    else it.end = clamp(val, S0() + 0.1, dur || val);
  };
  track.addEventListener('pointerdown', (ev) => {
    if (ev.button !== 0 || !dur) return;
    const r = track.getBoundingClientRect();
    const f = clamp((ev.clientX - r.left) / r.width, 0, 1);
    const s = S0(), e = E0();
    dragging = 'seek';
    if (editing) {
      const ds = Math.abs(f - s / dur) * r.width, de = Math.abs(f - e / dur) * r.width;
      if (Math.min(ds, de) < 10) dragging = ds <= de ? 's' : 'e';
    }
    if (dragging !== 'seek') mark(it.id);
    track.setPointerCapture(ev.pointerId);
    move(ev);
  });
  function move(ev) {
    if (!dragging) return;
    const r = track.getBoundingClientRect();
    const f = clamp((ev.clientX - r.left) / r.width, 0, 1);
    if (dragging === 'seek') {
      m.currentTime = editing ? f * dur : S0() + f * (E0() - S0());
    } else {
      setRange(dragging, f * dur);
      m.currentTime = dragging === 's' ? S0() : Math.max(S0(), E0() - 0.5);
      dirty();
      touch([it.id]);
    }
    update();
  }
  track.addEventListener('pointermove', move);
  const end = () => {
    if (dragging && dragging !== 'seek') commit();
    dragging = null;
  };
  track.addEventListener('pointerup', end);
  track.addEventListener('pointercancel', end);

  function applyInput(key, inp) {
    const v = parseTime(inp.value);
    if (v == null || !dur) { update(); return; }
    mark(it.id);
    setRange(key, v);
    commit();
    dirty();
    touch([it.id]);
    m.currentTime = key === 's' ? S0() : m.currentTime;
  }
  for (const [inp, key] of [[inS, 's'], [inE, 'e']]) {
    inp.addEventListener('change', () => applyInput(key, inp));
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') inp.blur(); e.stopPropagation(); });
  }
  q('.cs').addEventListener('click', () => { mark(it.id); setRange('s', m.currentTime); commit(); dirty(); touch([it.id]); });
  q('.ce').addEventListener('click', () => { mark(it.id); setRange('e', m.currentTime); commit(); dirty(); touch([it.id]); });
  q('.rr').addEventListener('click', () => {
    mark(it.id); it.start = 0; it.end = null; commit(); dirty(); touch([it.id]);
  });

  async function loadWave() {
    if (!it.peaks && it.url && it.url.startsWith('/assets/')) {
      const p = await computePeaks(it.url);
      if (p) { it.peaks = p; dirty(); }
    }
    drawWave();
  }
  function drawWave() {
    const w = Math.max(50, track.clientWidth) * 2, h = Math.max(20, track.clientHeight) * 2;
    if (wave.width !== w) wave.width = w;
    if (wave.height !== h) wave.height = h;
    const c = wave.getContext('2d');
    c.clearRect(0, 0, w, h);
    const peaks = it.peaks;
    if (!peaks) return;
    c.fillStyle = getComputedStyle(root).getPropertyValue('--wave').trim() || '#888';
    const n = peaks.length, bw = w / n;
    for (let i = 0; i < n; i++) {
      const bh = Math.max(2, (peaks[i] / 100) * h * 0.9);
      c.fillRect(i * bw, (h - bh) / 2, Math.max(1, bw - 0.6), bh);
    }
  }
  new ResizeObserver(() => { if (editing) drawWave(); }).observe(track);

  return {
    root,
    render(item, isEditing) {
      it = item;
      const was = editing;
      editing = isEditing;
      root.classList.toggle('editing', editing);
      const u = /^\/assets\/[0-9a-f]{24}(\.[a-z0-9]{1,8})?$/.test(it.url || '') ? it.url : '';
      if (srcFor !== u) { srcFor = u; m.src = u; watchWav(u); }
      if (kind === 'video') q('.mv').style.aspectRatio = it.ar || '16 / 9';
      else q('.mt span').textContent = it.name || 'Audio';
      trn.render(it);
      update();
      if (editing && !was) loadWave();
      else if (editing) drawWave();
    },
    destroy() {
      players.delete(item0.id);
      trn.destroy();
      m.pause();
      m.removeAttribute('src');
      m.load();
      cancelAnimationFrame(raf);
    },
  };
}
