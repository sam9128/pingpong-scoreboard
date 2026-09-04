/**
 * 產生 PWA 圖示。沒有外部影像套件，直接輸出最小可用的 PNG。
 * 執行：node scripts/make-icons.mjs
 */
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'icons');

const BG = [10, 14, 26];
const BALL = [255, 159, 67];
const RING = [61, 220, 132];

const CRC_TABLE = Int32Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});

function crc32(buf) {
  let c = ~0;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function png(size, { padding }) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolour RGB
  const raw = Buffer.alloc(size * (size * 3 + 1));

  const cx = size / 2;
  const cy = size / 2;
  const ballR = (size / 2) * (1 - padding) * 0.66;
  const ringR = (size / 2) * (1 - padding);
  const ringW = Math.max(2, size * 0.045);

  for (let y = 0; y < size; y++) {
    const row = y * (size * 3 + 1);
    raw[row] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
      const color = d <= ballR ? BALL : Math.abs(d - ringR) <= ringW / 2 ? RING : BG;
      const at = row + 1 + x * 3;
      raw[at] = color[0];
      raw[at + 1] = color[1];
      raw[at + 2] = color[2];
    }
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

mkdirSync(OUT, { recursive: true });
const files = [
  ['icon-192.png', 192, 0.12],
  ['icon-512.png', 512, 0.12],
  // maskable 需要更大的安全邊距，讓系統裁切成圓形時不會切到主體。
  ['icon-maskable-512.png', 512, 0.3],
];

for (const [name, size, padding] of files) {
  writeFileSync(join(OUT, name), png(size, { padding }));
  console.log(`寫入 public/icons/${name}`);
}
