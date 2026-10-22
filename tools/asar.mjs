// Minimal ASAR reader: list/extract files without external deps.
// usage: node asar.mjs list <archive> [substring]
//        node asar.mjs read <archive> <path-in-archive> [outFile]
import fs from 'node:fs';
import path from 'node:path';

const [cmd, archivePath, arg1, arg2] = process.argv.slice(2);
const fd = fs.openSync(archivePath, 'r');
const head = Buffer.alloc(16);
fs.readSync(fd, head, 0, 16, 0);
const headerSize = head.readUInt32LE(4); // size of the header pickle, length prefix included
const headerBuf = Buffer.alloc(headerSize);
fs.readSync(fd, headerBuf, 0, headerSize, 8);
const baseOffset = 8 + headerSize;
const jsonLen = headerBuf.readUInt32LE(4);
const header = JSON.parse(headerBuf.subarray(8, 8 + jsonLen).toString('utf8'));

function walk(node, prefix, out) {
  for (const [name, entry] of Object.entries(node.files || {})) {
    const p = prefix ? `${prefix}/${name}` : name;
    if (entry.files) walk(entry, p, out);
    else out.push({ path: p, size: entry.size, offset: entry.offset, unpacked: entry.unpacked });
  }
  return out;
}
const all = walk(header, '', []);

if (cmd === 'list') {
  const needle = (arg1 || '').toLowerCase();
  const hits = all.filter((f) => f.path.toLowerCase().includes(needle));
  for (const f of hits) console.log(`${f.size}\t${f.unpacked ? 'UNPACKED' : ''}${f.path}`);
  console.log(`# ${hits.length} matches / ${all.length} files`);
} else if (cmd === 'read') {
  const target = all.find((f) => f.path === arg1 || f.path.replace(/\\/g, '/') === arg1);
  if (!target) {
    console.error('not found: ' + arg1);
    process.exit(2);
  }
  if (target.unpacked) {
    console.error('unpacked file, read from app.asar.unpacked');
    process.exit(3);
  }
  const buf = Buffer.alloc(target.size);
  fs.readSync(fd, buf, 0, target.size, baseOffset + Number(target.offset));
  if (arg2) fs.writeFileSync(arg2, buf);
  else process.stdout.write(buf);
} else {
  console.error('unknown command');
  process.exit(1);
}
