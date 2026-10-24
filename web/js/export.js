import { S, bus, $, toast } from './store.js';
import { labelOf, rectOf, contentBounds, checkMd } from './cards.js';
import { tc } from './transcript.js';

const menu = document.createElement('div');
menu.id = 'expmenu';
menu.className = 'panel';
document.body.appendChild(menu);

const ASSET = /^\/assets\/([0-9a-f]{24}(\.[a-z0-9]{1,8})?)$/;
const aname = (u) => (typeof u === 'string' && ASSET.exec(u) ? ASSET.exec(u)[1] : null);

function cardMd(it, assets) {
  const link = (u, text) => { const n = aname(u); if (!n) return text; assets.push(n); return `[${text}](assets/${n})`; };
  const out = [];
  const name = it.name || labelOf(it);
  switch (it.type) {
    case 'note': case 'md': out.push(it.text || ''); break;
    case 'check': out.push(checkMd(it)); break;
    case 'text': out.push(it.text || ''); break;
    case 'code': out.push('```' + (it.lang && it.lang !== 'auto' ? it.lang : '') + '\n' + (it.text || '') + '\n```'); break;
    case 'image': {
      const n = aname(it.url);
      if (n) { assets.push(n); out.push(`![${name}](assets/${n})`); }
      if (it.ocr?.text) out.push('**Text in image**\n\n' + it.ocr.text.split('\n').map((l) => '> ' + l).join('\n'));
      break;
    }
    case 'audio': case 'video': case 'pdf': case 'file': {
      out.push(link(it.url, name));
      const segs = it.transcript?.segments;
      if (segs?.length) out.push('**Transcript**\n\n' + segs.map((s) => `- **${tc(s[0])}** ${s[2]}`).join('\n'));
      break;
    }
    case 'link': {
      out.push(`**[${it.title || it.href}](${it.href})**` + (it.site ? ` — ${it.site}` : ''));
      if (it.desc) out.push('> ' + it.desc.replace(/\n+/g, ' '));
      if (aname(it.archive)) out.push(link(it.archive, 'Saved copy of the page'));
      break;
    }
    case 'embed': out.push(`[▶ ${it.title || it.provider || 'Video'}](${it.href})` + (it.author ? ` — ${it.author}` : '')); break;
    case 'ref': out.push(`→ ${it.label || 'card'} (${location.origin}/?p=${it.pid}#card=${it.cid})`); break;
    default: break;
  }
  if (it.tags?.length) out.push(it.tags.map((t) => '#' + t).join(' '));
  return out.filter((s) => s !== '').join('\n\n');
}

function order(cards) {
  return [...cards].sort((a, b) => {
    const ra = rectOf(a.id), rb = rectOf(b.id);
    const dy = ra.y - rb.y;
    return Math.abs(dy) > 80 ? dy : ra.x - rb.x;
  });
}

export function boardToMarkdown(onlySel) {
  const assets = [];
  let cards = [...S.items.values()].filter((i) => i.kind === 'card');
  if (onlySel) cards = cards.filter((i) => S.sel.has(i.id));
  const frames = order(cards.filter((i) => i.type === 'frame'));
  const rest = cards.filter((i) => i.type !== 'frame');
  const inFrame = new Map();
  for (const c of rest) {
    const r = rectOf(c.id), cx = r.x + r.w / 2, cy = r.y + r.h / 2;
    let best = null, ba = Infinity;
    for (const f of frames) {
      const fr = rectOf(f.id);
      if (cx >= fr.x && cx <= fr.x + fr.w && cy >= fr.y && cy <= fr.y + fr.h && fr.w * fr.h < ba) { best = f.id; ba = fr.w * fr.h; }
    }
    if (best) (inFrame.get(best) || inFrame.set(best, []).get(best)).push(c);
  }
  const placed = new Set([...inFrame.values()].flat().map((c) => c.id));
  const blocks = [];
  for (const c of order(rest.filter((c) => !placed.has(c.id)))) blocks.push({ pos: rectOf(c.id), md: cardMd(c, assets) });
  for (const f of frames) {
    const body = order(inFrame.get(f.id) || []).map((c) => cardMd(c, assets)).filter(Boolean).join('\n\n');
    blocks.push({ pos: rectOf(f.id), md: `## ${f.title || 'Frame'}\n\n${body}` });
  }
  blocks.sort((a, b) => (Math.abs(a.pos.y - b.pos.y) > 80 ? a.pos.y - b.pos.y : a.pos.x - b.pos.x));
  const md = `# ${S.project.name}\n\n` + blocks.map((b) => b.md).filter(Boolean).join('\n\n---\n\n') + '\n';
  return { md, assets: [...new Set(assets)], count: cards.length };
}

async function exportMd(onlySel) {
  const { md, assets, count } = boardToMarkdown(onlySel);
  if (!count) { toast('Nothing to export', 2000); return; }
  toast('Preparing archive…', 1500);
  try {
    const r = await fetch('/api/export/md', { method: 'POST', headers: { 'X-Board': '1', 'Content-Type': 'application/json' }, body: JSON.stringify({ name: S.project.name, md, assets }) });
    if (!r.ok) throw new Error(r.status);
    const url = URL.createObjectURL(await r.blob());
    const a = document.createElement('a');
    a.href = url; a.download = S.project.name + '.zip';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  } catch (e) { toast('Export failed: ' + e.message, 4000); }
}

function printBoard(fit) {
  if (fit) { bus.emit('fitall'); }
  setTimeout(() => {
    const st = $('#stage').getBoundingClientRect();
    const pw = 1077, ph = 748;
    const sc = Math.min(1, pw / st.width, ph / st.height);
    document.documentElement.style.setProperty('--print-w', st.width + 'px');
    document.documentElement.style.setProperty('--print-h', st.height + 'px');
    document.documentElement.style.setProperty('--print-s', String(sc));
    window.print();
  }, fit ? 700 : 50);
}

function open(anchor) {
  const n = [...S.sel].filter((i) => S.items.get(i)?.kind === 'card').length;
  menu.innerHTML = `<button data-a="md-all">Markdown + files (zip): whole board</button>
    <button data-a="md-sel" ${n ? '' : 'disabled'}>Markdown + files: selected cards${n ? ` (${n})` : ''}</button>
    <i class="sep"></i>
    <button data-a="pdf-fit">PDF / print: fit everything</button>
    <button data-a="pdf-view">PDF / print: as currently on screen</button>
    <div class="em-note">In the print dialog choose "Save as PDF". The drawing and cards print as shown on screen.</div>`;
  menu.classList.add('open');
  const r = anchor.getBoundingClientRect();
  menu.style.top = r.bottom + 8 + 'px';
  menu.style.right = Math.max(8, window.innerWidth - r.right) + 'px';
}
menu.addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b || b.disabled) return;
  menu.classList.remove('open');
  const a = b.dataset.a;
  if (a === 'md-all') exportMd(false);
  else if (a === 'md-sel') exportMd(true);
  else if (a === 'pdf-fit') printBoard(true);
  else if (a === 'pdf-view') printBoard(false);
});
bus.on('openexport', (btn) => (menu.classList.contains('open') ? menu.classList.remove('open') : open(btn)));
window.addEventListener('pointerdown', (e) => { if (menu.classList.contains('open') && !menu.contains(e.target) && !e.target.closest('[data-do=export]')) menu.classList.remove('open'); });
