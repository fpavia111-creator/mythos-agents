// Minimal ZIP reader (stored and deflate entries) using node:zlib. Enough for
// DOCX/XLSX/PPTX parts. Refuses encrypted entries, zip64 and oversized output.

import { inflateRawSync, deflateRawSync } from 'node:zlib';

const MAX_TOTAL = 200 * 1024 * 1024;

/** Read a zip buffer. Returns Map name -> Buffer. */
export function readZip(buf, { only = null, maxBytes = MAX_TOTAL } = {}) {
  if (!Buffer.isBuffer(buf)) throw new Error('readZip needs a Buffer');
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('not a zip file (no end of central directory)');
  const count = buf.readUInt16LE(eocd + 10); const cdOff = buf.readUInt32LE(eocd + 16);
  if (cdOff === 0xffffffff) throw new Error('zip64 is not supported');
  const out = new Map(); let p = cdOff; let total = 0;
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('corrupt central directory');
    const flags = buf.readUInt16LE(p + 8); const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20); const usize = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28), xlen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32);
    const lho = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nlen).toString('utf8');
    p += 46 + nlen + xlen + clen;
    if (name.endsWith('/')) continue;
    if (only && !only(name)) continue;
    if (flags & 1) throw new Error(`${name} is encrypted`);
    total += usize; if (total > maxBytes) throw new Error('zip expands beyond the size limit (zip bomb?)');
    const lnlen = buf.readUInt16LE(lho + 26), lxlen = buf.readUInt16LE(lho + 28);
    const data = buf.slice(lho + 30 + lnlen + lxlen, lho + 30 + lnlen + lxlen + csize);
    let body;
    if (method === 0) body = data;
    else if (method === 8) body = inflateRawSync(data, { maxOutputLength: Math.max(usize, 1) });
    else throw new Error(`${name}: compression method ${method} is not supported`);
    out.set(name, body);
  }
  return out;
}

/** Build a zip (stored or deflated) from Map/obj name -> string|Buffer. Deterministic timestamps. */
export function writeZip(files, { deflate = true } = {}) {
  const entries = files instanceof Map ? [...files] : Object.entries(files);
  const locals = []; const centrals = []; let off = 0;
  for (const [name, content] of entries) {
    const raw = Buffer.isBuffer(content) ? content : Buffer.from(String(content));
    const comp = deflate ? deflateRawSync(raw) : raw; const method = deflate ? 8 : 0;
    const nb = Buffer.from(name); const crc = crc32Impl(raw);
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6); lh.writeUInt16LE(method, 8);
    lh.writeUInt16LE(0, 10); lh.writeUInt16LE(0x21, 12); lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(raw.length, 22); lh.writeUInt16LE(nb.length, 26);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8); ch.writeUInt16LE(method, 10);
    ch.writeUInt16LE(0, 12); ch.writeUInt16LE(0x21, 14); ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(raw.length, 24); ch.writeUInt16LE(nb.length, 28); ch.writeUInt32LE(off, 42);
    locals.push(lh, nb, comp); centrals.push(ch, nb); off += 30 + nb.length + comp.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
  return Buffer.concat([...locals, cd, end]);
}

const CRC_TABLE = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32Impl(buf) { let c = 0xffffffff; for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }

/** Plain text of a DOCX: paragraphs from word/document.xml, one per line. */
export function docxText(buf) {
  const z = readZip(buf, { only: (n) => n === 'word/document.xml' });
  const xml = z.get('word/document.xml');
  if (!xml) throw new Error('not a DOCX (word/document.xml missing)');
  const unesc = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d)).replace(/&amp;/g, '&');
  const paras = xml.toString('utf8').split(/<\/w:p>/).map((p) => {
    const heading = /<w:pStyle w:val="(?:Heading|heading)(\d)"/.exec(p);
    const txt = [...p.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|<w:tab\/>|<w:br\/>/g)].map((m) => (m[1] !== undefined ? unesc(m[1]) : m[0] === '<w:tab/>' ? '\t' : '\n')).join('');
    return heading && txt.trim() ? `${'#'.repeat(Number(heading[1]))} ${txt}` : txt;
  });
  return paras.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}
