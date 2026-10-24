import { toast } from './store.js';
import { createCard } from './cards.js';

const EXT = (n) => (n.split('.').pop() || '').toLowerCase();
const IMG = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'avif', 'ico']);
const AUDIO = new Set(['mp3', 'wav', 'ogg', 'oga', 'opus', 'm4a', 'aac', 'flac', 'weba']);
const VIDEO = new Set(['mp4', 'm4v', 'webm', 'ogv', 'mov', 'mkv']);
const CODE = {
  py: 'python', js: 'javascript', mjs: 'javascript', ts: 'typescript', tsx: 'typescript', jsx: 'javascript',
  json: 'json', html: 'xml', htm: 'xml', xml: 'xml', css: 'css', scss: 'scss', less: 'less',
  c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', hpp: 'cpp', cs: 'csharp', java: 'java', go: 'go', rs: 'rust',
  rb: 'ruby', php: 'php', sh: 'bash', bash: 'bash', bat: 'shell', cmd: 'shell', ps1: 'shell', sql: 'sql',
  yaml: 'yaml', yml: 'yaml', toml: 'ini', ini: 'ini', lua: 'lua', kt: 'kotlin', swift: 'swift', r: 'r',
  gd: 'python', diff: 'diff', patch: 'diff', mk: 'makefile', vb: 'vbnet', pl: 'perl', m: 'objectivec',
};
const MIME_EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/bmp': 'bmp', 'image/svg+xml': 'svg', 'application/pdf': 'pdf' };
const MAX_TEXT = 2 * 1024 * 1024;

export async function upload(file) {
  let name = file.name || 'file';
  if (!name.includes('.') && MIME_EXT[file.type]) name += '.' + MIME_EXT[file.type];
  const r = await fetch('/api/upload?name=' + encodeURIComponent(name), {
    method: 'POST', headers: { 'X-Board': '1' }, body: file,
  });
  if (!r.ok) throw new Error('upload ' + r.status);
  return r.json();
}

function imageSize(url) {
  return new Promise((res) => {
    const i = new Image();
    i.onload = () => res({ w: i.naturalWidth, h: i.naturalHeight });
    i.onerror = () => res(null);
    i.src = url;
  });
}

export function kindOf(file) {
  const ext = EXT(file.name || '');
  const t = file.type || '';
  if (t.startsWith('image/') || IMG.has(ext)) return 'image';
  if (t === 'application/pdf' || ext === 'pdf') return 'pdf';
  if (t.startsWith('audio/') || AUDIO.has(ext)) return 'audio';
  if (t.startsWith('video/') || VIDEO.has(ext)) return 'video';
  if ((ext === 'md' || ext === 'markdown') && file.size <= MAX_TEXT) return 'md';
  if (ext === 'txt' && file.size <= MAX_TEXT) return 'note';
  if (CODE[ext] && file.size <= MAX_TEXT) return 'code';
  return 'file';
}

export async function addFiles(files, at) {
  let i = 0;
  const ids = [];
  for (const file of files) {
    const pos = { x: at.x + i * 28, y: at.y + i * 28 };
    i++;
    const kind = kindOf(file);
    try {
      if (kind === 'md' || kind === 'note' || kind === 'code') {
        const text = await file.text();
        const ext = EXT(file.name);
        ids.push(createCard(kind, kind === 'code' ? { text, lang: CODE[ext] || 'auto' } : { text }, pos));
        continue;
      }
      toast('Uploading: ' + (file.name || 'file'), 1500);
      const up = await upload(file);
      const props = { url: up.url, name: up.name, size: up.size };
      if (kind === 'image') {
        const s = await imageSize(up.url);
        if (s) { props.ar = s.w / s.h; props.w = Math.min(s.w, 480); }
      }
      ids.push(createCard(kind, props, pos));
    } catch (e) {
      toast('Could not add ' + (file.name || 'file') + ': ' + e.message, 4000);
    }
  }
  return ids;
}
