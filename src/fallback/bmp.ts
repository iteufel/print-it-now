import type { BitmapPixelFormat } from "../types.js";

/**
 * Encodes tightly packed 4-byte pixels as a 24-bit Windows BMP.
 *
 * Used by the `lp` command-line fallback, which has no native addon to do the
 * conversion. The CUPS library path encodes in C++ instead
 * (`native/src/bitmap.cc`); the layouts must stay identical.
 */
export function encodeBmp(
  width: number,
  height: number,
  data: Uint8Array,
  format: BitmapPixelFormat,
  dpi = 72,
): Uint8Array {
  const rowStride = (width * 3 + 3) & ~3;
  const pixelBytes = rowStride * height;
  const headerSize = 14 + 40;
  const out = new Uint8Array(headerSize + pixelBytes);
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);

  out[0] = 0x42; // 'B'
  out[1] = 0x4d; // 'M'
  view.setUint32(2, out.byteLength, true);
  view.setUint32(10, headerSize, true);
  view.setUint32(14, 40, true);
  view.setInt32(18, width, true);
  view.setInt32(22, height, true); // positive = bottom-up
  view.setUint16(26, 1, true);
  view.setUint16(28, 24, true);
  view.setUint32(34, pixelBytes, true);
  const ppm = Math.round((Math.max(dpi, 1) * 10000) / 254);
  view.setUint32(38, ppm, true);
  view.setUint32(42, ppm, true);

  for (let y = 0; y < height; y++) {
    const srcY = height - 1 - y;
    const srcRow = srcY * width * 4;
    const destRow = headerSize + y * rowStride;
    for (let x = 0; x < width; x++) {
      const src = srcRow + x * 4;
      let r: number;
      let g: number;
      let b: number;
      let a: number;
      if (format === "bgra") {
        b = data[src]!;
        g = data[src + 1]!;
        r = data[src + 2]!;
        a = data[src + 3]!;
      } else {
        r = data[src]!;
        g = data[src + 1]!;
        b = data[src + 2]!;
        a = data[src + 3]!;
      }

      if (a < 255) {
        if (a === 0) {
          r = 255;
          g = 255;
          b = 255;
        } else {
          const inv = 255 - a;
          r = Math.round((r * a + 255 * inv) / 255);
          g = Math.round((g * a + 255 * inv) / 255);
          b = Math.round((b * a + 255 * inv) / 255);
        }
      }

      const dest = destRow + x * 3;
      out[dest] = b;
      out[dest + 1] = g;
      out[dest + 2] = r;
    }
  }

  return out;
}
