/**
 * PNG decode/encode + tolerant pixel comparison — the same rule the whole-app
 * harness uses (16/255 per channel, three times stricter than Playwright's
 * ~51/255 default), lifted here rather than reinvented so the story suite and
 * the app suite cannot disagree about what "changed" means.
 *
 * Why tolerance at all: headless Chromium is not byte-stable across runs here
 * (measured: 25, 95, 80 and 39 of 684 shots differed byte-wise on identical
 * code, with no layout difference). A per-channel tolerance ignores
 * rasterisation noise and still catches a moved element, a lost colour or a
 * changed glyph.
 */
import fs from "node:fs";
import zlib from "node:zlib";

function crc32(buf) {
  let table = crc32.table;
  if (!table) {
    table = crc32.table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
  }
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}


function decodePng(file) {
  const buf = fs.readFileSync(file);
  if (buf.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") {
    throw new Error(`not a PNG: ${file}`);
  }
  let pos = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.subarray(pos + 4, pos + 8).toString("ascii");
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      if (data[10] !== 0 || data[11] !== 0 || data[12] !== 0) {
        throw new Error(`unsupported PNG mode in ${file}`);
      }
    } else if (type === "IDAT") {
      idat.push(data);
    } else if (type === "IEND") {
      break;
    }
    pos += 12 + len;
  }
  if (bitDepth !== 8 || ![0, 2, 6].includes(colorType)) {
    throw new Error(`unsupported PNG (depth=${bitDepth}, type=${colorType}): ${file}`);
  }
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 1;
  const stride = width * channels;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const out = Buffer.alloc(width * height * 4);
  let p = 0;
  const prev = Buffer.alloc(stride);
  const cur = Buffer.alloc(stride);
  const paeth = (a, b, c) => {
    const q = a + b - c;
    const pa = Math.abs(q - a);
    const pb = Math.abs(q - b);
    const pc = Math.abs(q - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
  };
  for (let y = 0; y < height; y++) {
    const filter = raw[p++];
    for (let i = 0; i < stride; i++) {
      const v = raw[p++];
      const a = i >= channels ? cur[i - channels] : 0;
      const b = prev[i];
      const c = i >= channels ? prev[i - channels] : 0;
      cur[i] =
        filter === 0
          ? v
          : filter === 1
            ? (v + a) & 0xff
            : filter === 2
              ? (v + b) & 0xff
              : filter === 3
                ? (v + ((a + b) >> 1)) & 0xff
                : (v + paeth(a, b, c)) & 0xff;
    }
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      if (colorType === 6) {
        out[o] = cur[x * 4];
        out[o + 1] = cur[x * 4 + 1];
        out[o + 2] = cur[x * 4 + 2];
        out[o + 3] = cur[x * 4 + 3];
      } else if (colorType === 2) {
        out[o] = cur[x * 3];
        out[o + 1] = cur[x * 3 + 1];
        out[o + 2] = cur[x * 3 + 2];
        out[o + 3] = 255;
      } else {
        out[o] = out[o + 1] = out[o + 2] = cur[x];
        out[o + 3] = 255;
      }
    }
    cur.copy(prev);
  }
  return { width, height, rgba: out };
}

function encodePng(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

/**
 * Per-channel tolerance for a pixel to count as unchanged.
 *
 * Measured on this machine, twice per state: Chromium's software rasteriser
 * dithers large gradients and 1px edges by 1-4 / 255 between two identical
 * captures, and rounded-card corners reach 14 / 255 on ~10 isolated pixels.
 * That is not a visual change and no amount of waiting removes it — it is the
 * rasteriser, not the app.
 *
 * The number is chosen from evidence, not taste: a real defect measured on this
 * harness is far above it — an id-derived avatar tint 121/255, an unmasked
 * email 300-641/255, a single changed text weight 36/255. Playwright's own
 * toHaveScreenshot default tolerates ~51/255 per pixel; 16 is three times
 * stricter and still catches every real change measured so far.
 */
const CHANNEL_TOLERANCE = 16;

const withinTolerance = (a, b) =>
  Math.abs(a - b) <= CHANNEL_TOLERANCE;

/** Diff two decoded images. Returns { ratio, worstChannelDelta, diffMap } (diffMap = RGBA). */
function diffImages(a, b) {
  if (a.width !== b.width || a.height !== b.height) {
    return { ratio: 1, sizeMismatch: true, diffMap: null };
  }
  const n = a.width * a.height;
  const diffMap = Buffer.alloc(n * 4);
  let diff = 0;
  let worstChannelDelta = 0;
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    const delta = Math.max(
      Math.abs(a.rgba[o] - b.rgba[o]),
      Math.abs(a.rgba[o + 1] - b.rgba[o + 1]),
      Math.abs(a.rgba[o + 2] - b.rgba[o + 2]),
      Math.abs(a.rgba[o + 3] - b.rgba[o + 3]),
    );
    if (delta > worstChannelDelta) worstChannelDelta = delta;
    const same =
      withinTolerance(a.rgba[o], b.rgba[o]) &&
      withinTolerance(a.rgba[o + 1], b.rgba[o + 1]) &&
      withinTolerance(a.rgba[o + 2], b.rgba[o + 2]) &&
      withinTolerance(a.rgba[o + 3], b.rgba[o + 3]);
    if (same) {
      diffMap[o] = (a.rgba[o] * 0.35) | 0;
      diffMap[o + 1] = (a.rgba[o + 1] * 0.35) | 0;
      diffMap[o + 2] = (a.rgba[o + 2] * 0.35) | 0;
      diffMap[o + 3] = 255;
    } else {
      diff++;
      diffMap[o] = 255;
      diffMap[o + 1] = 0;
      diffMap[o + 2] = 64;
      diffMap[o + 3] = 255;
    }
  }
  return { ratio: diff / n, worstChannelDelta, sizeMismatch: false, diffMap };
}

export { decodePng, encodePng, diffImages, CHANNEL_TOLERANCE };
