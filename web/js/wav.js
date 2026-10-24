// Re-encodes WAV files the browser refuses (extensible header, 32-bit int, 64-bit float, streamed sizes...) to plain 16-bit PCM.
export async function fixWav(url) {
  const buf = await (await fetch(url)).arrayBuffer();
  const v = new DataView(buf);
  const tag = (o) => String.fromCharCode(v.getUint8(o), v.getUint8(o + 1), v.getUint8(o + 2), v.getUint8(o + 3));
  if (buf.byteLength < 44 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('Not a WAV file');
  let fmt = null, data = null;
  for (let o = 12; o + 8 <= buf.byteLength;) {
    const id = tag(o);
    let n = v.getUint32(o + 4, true);
    if (id === 'data') { if (!n || o + 8 + n > buf.byteLength) n = buf.byteLength - o - 8; data = [o + 8, n]; break; }
    if (id === 'fmt ') fmt = { tag: v.getUint16(o + 8, true), ch: v.getUint16(o + 10, true), rate: v.getUint32(o + 12, true), align: v.getUint16(o + 20, true), spb: n >= 20 ? v.getUint16(o + 26, true) : 0, bits: v.getUint16(o + 22, true), sub: n >= 26 ? v.getUint16(o + 32, true) : 0 };
    o += 8 + n + (n & 1);
  }
  if (!fmt || !data) throw new Error('Damaged WAV file');
  if (fmt.tag === 0x11) return adpcm(v, fmt, data);
  const kind = fmt.tag === 0xFFFE ? fmt.sub : fmt.tag;
  const bytes = fmt.bits >> 3, ch = fmt.ch || 1;
  if ((kind !== 1 && kind !== 3) || !bytes) throw new Error('This WAV encoding (compressed) is not supported by the browser');
  const frames = Math.floor(data[1] / (bytes * ch));
  const out = new DataView(new ArrayBuffer(44 + frames * ch * 2));
  const put = (o, s) => { for (let i = 0; i < 4; i++) out.setUint8(o + i, s.charCodeAt(i)); };
  put(0, 'RIFF'); out.setUint32(4, 36 + frames * ch * 2, true); put(8, 'WAVE'); put(12, 'fmt ');
  out.setUint32(16, 16, true); out.setUint16(20, 1, true); out.setUint16(22, ch, true); out.setUint32(24, fmt.rate, true);
  out.setUint32(28, fmt.rate * ch * 2, true); out.setUint16(32, ch * 2, true); out.setUint16(34, 16, true); put(36, 'data'); out.setUint32(40, frames * ch * 2, true);
  const rd = (o) => {
    if (kind === 3) return bytes === 8 ? v.getFloat64(o, true) : v.getFloat32(o, true);
    if (bytes === 1) return (v.getUint8(o) - 128) / 128;
    if (bytes === 2) return v.getInt16(o, true) / 32768;
    if (bytes === 3) return ((v.getUint8(o) | (v.getUint8(o + 1) << 8) | (v.getInt8(o + 2) << 16)) / 8388608);
    return v.getInt32(o, true) / 2147483648;
  };
  for (let i = 0, k = 0; i < frames * ch; i++, k += 2) {
    const s = Math.max(-1, Math.min(1, rd(data[0] + i * bytes)));
    out.setInt16(44 + k, s < 0 ? s * 32768 : s * 32767, true);
  }
  return blobUrl(out, fmt.rate, ch);
}

function blobUrl(out, rate, ch) {
  return URL.createObjectURL(new Blob([out.buffer], { type: 'audio/wav' }));
}

const STEP = [7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41, 45, 50, 55, 60, 66, 73, 80, 88, 97, 107, 118, 130, 143, 157, 173, 190, 209, 230, 253, 279, 307, 337, 371, 408, 449, 494, 544, 598, 658, 724, 796, 876, 963, 1060, 1166, 1282, 1411, 1552, 1707, 1878, 2066, 2272, 2499, 2749, 3024, 3327, 3660, 4026, 4428, 4871, 5358, 5894, 6484, 7132, 7845, 8630, 9493, 10442, 11487, 12635, 13899, 15289, 16818, 18500, 20350, 22385, 24623, 27086, 29794, 32767];
const IDX = [-1, -1, -1, -1, 2, 4, 6, 8];

// IMA ADPCM (WAVE format 0x11): browsers do not play it
function adpcm(v, fmt, data) {
  const ch = fmt.ch || 1, align = fmt.align, spb = fmt.spb || (align - 4 * ch) * 8 / (4 * ch) + 1;
  if (!align || align < 4 * ch || fmt.bits !== 4) throw new Error('Unsupported ADPCM variant');
  const blocks = Math.floor(data[1] / align), tail = data[1] - blocks * align;
  const total = blocks * spb + (tail > 4 * ch ? Math.floor((tail - 4 * ch) * 2 / ch) + 1 : 0);
  const pcm = new Int16Array(total * ch);
  let w = 0;
  for (let b = 0; b * align < data[1]; b++) {
    const base = data[0] + b * align, len = Math.min(align, data[1] - b * align);
    if (len <= 4 * ch) break;
    const n = Math.min(spb, Math.floor((len - 4 * ch) * 2 / ch) + 1);
    for (let c = 0; c < ch; c++) {
      let pred = v.getInt16(base + c * 4, true), idx = Math.min(88, v.getUint8(base + c * 4 + 2));
      pcm[(w) * ch + c] = pred;
      for (let i = 1; i < n; i++) {
        const j = i - 1, group = Math.floor(j / 8), within = j % 8;
        const off = base + 4 * ch + (group * ch + c) * 4 + (within >> 1);
        const code = (v.getUint8(off) >> ((within & 1) * 4)) & 15;
        const step = STEP[idx];
        const diff = ((2 * (code & 7) + 1) * step) >> 3;
        pred = Math.max(-32768, Math.min(32767, code & 8 ? pred - diff : pred + diff));
        idx = Math.max(0, Math.min(88, idx + IDX[code & 7]));
        pcm[(w + i) * ch + c] = pred;
      }
    }
    w += n;
  }
  const out = new DataView(new ArrayBuffer(44 + w * ch * 2));
  const put = (o, str) => { for (let i = 0; i < 4; i++) out.setUint8(o + i, str.charCodeAt(i)); };
  put(0, 'RIFF'); out.setUint32(4, 36 + w * ch * 2, true); put(8, 'WAVE'); put(12, 'fmt ');
  out.setUint32(16, 16, true); out.setUint16(20, 1, true); out.setUint16(22, ch, true); out.setUint32(24, fmt.rate, true);
  out.setUint32(28, fmt.rate * ch * 2, true); out.setUint16(32, ch * 2, true); out.setUint16(34, 16, true); put(36, 'data'); out.setUint32(40, w * ch * 2, true);
  for (let i = 0; i < w * ch; i++) out.setInt16(44 + i * 2, pcm[i], true);
  return blobUrl(out, fmt.rate, ch);
}
