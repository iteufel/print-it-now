import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  DOCUMENT_KIND_CODE,
  PIXEL_FORMAT_CODE,
  buildBitmapNativeRequest,
  encodeBmp,
  readBitmapSource,
  resolveBitmapOptions,
  toIppOptions,
} from "../../dist/internal.js";
import { printBitmap } from "../../dist/index.js";

function solidBitmap(width, height, rgba = [255, 0, 0, 255]) {
  const data = Buffer.alloc(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = rgba[0];
    data[i + 1] = rgba[1];
    data[i + 2] = rgba[2];
    data[i + 3] = rgba[3];
  }
  return { width, height, data, format: "rgba" };
}

describe("readBitmapSource", () => {
  it("accepts a well-formed rgba buffer", () => {
    const source = solidBitmap(2, 2);
    const read = readBitmapSource(source);
    assert.equal(read.width, 2);
    assert.equal(read.height, 2);
    assert.equal(read.format, "rgba");
    assert.equal(read.data.byteLength, 16);
  });

  it("defaults format to rgba", () => {
    const { format } = readBitmapSource({ width: 1, height: 1, data: Buffer.alloc(4) });
    assert.equal(format, "rgba");
  });

  it("rejects a wrong byte length", () => {
    assert.throws(
      () => readBitmapSource({ width: 2, height: 2, data: Buffer.alloc(8) }),
      { code: "EINVALIDOPTION", option: "source.data" },
    );
  });

  it("rejects non-positive dimensions", () => {
    assert.throws(
      () => readBitmapSource({ width: 0, height: 1, data: Buffer.alloc(0) }),
      { code: "EINVALIDOPTION", option: "source.width" },
    );
    assert.throws(
      () => readBitmapSource({ width: 1, height: -1, data: Buffer.alloc(4) }),
      { code: "EINVALIDOPTION", option: "source.height" },
    );
  });

  it("rejects an unknown pixel format", () => {
    assert.throws(
      () => readBitmapSource({ width: 1, height: 1, data: Buffer.alloc(4), format: "rgb" }),
      { code: "EINVALIDOPTION", option: "source.format" },
    );
  });
});

describe("resolveBitmapOptions", () => {
  it("defaults dpi to 72", () => {
    assert.equal(resolveBitmapOptions().dpi, 72);
  });

  it("rejects PDF-only options", () => {
    for (const [options, option] of [
      [{ pages: "1" }, "pages"],
      [{ pageSubset: "odd" }, "pageSubset"],
      [{ reverse: true }, "reverse"],
      [{ numberUp: 2 }, "numberUp"],
      [{ windows: { renderMode: "bitmap" } }, "windows.renderMode"],
      [{ windows: { printMode: "emf" } }, "windows.printMode"],
    ]) {
      assert.throws(() => resolveBitmapOptions(options), {
        code: "EINVALIDOPTION",
        option,
      });
    }
  });
});

describe("buildBitmapNativeRequest", () => {
  it("marks the request as a bitmap with size and format", () => {
    const resolved = resolveBitmapOptions({ dpi: 150, scale: "fit" });
    const bitmap = solidBitmap(4, 3);
    const request = buildBitmapNativeRequest(
      resolved,
      "Queue",
      "job",
      {
        data: bitmap.data,
        width: bitmap.width,
        height: bitmap.height,
        format: "rgba",
      },
      "cups",
    );

    assert.equal(request.kind, DOCUMENT_KIND_CODE.bitmap);
    assert.equal(request.bitmapWidth, 4);
    assert.equal(request.bitmapHeight, 3);
    assert.equal(request.pixelFormat, PIXEL_FORMAT_CODE.rgba);
    assert.equal(request.windows.dpi, 150);
    assert.deepEqual(request.ranges, []);
    assert.equal(request.numberUp, 1);
  });

  it("declares image/bmp for CUPS", () => {
    const resolved = resolveBitmapOptions({ dpi: 96 });
    const ipp = Object.fromEntries(toIppOptions(resolved, "bitmap"));
    assert.equal(ipp["document-format"], "image/bmp");
    assert.equal(ipp["page-ranges"], undefined);
    assert.equal(ipp["number-up"], undefined);
  });

  it("still rejects dpi for PDF jobs on CUPS", () => {
    const resolved = resolveBitmapOptions({ dpi: 96 });
    assert.throws(() => toIppOptions(resolved, "pdf"), {
      code: "EUNSUPPORTEDOPTION",
      option: "dpi",
    });
  });
});

describe("encodeBmp", () => {
  it("writes a valid BMP header for a 1x1 pixel", () => {
    const pixels = Buffer.from([255, 0, 0, 255]); // opaque red rgba
    const bmp = encodeBmp(1, 1, pixels, "rgba", 72);
    assert.equal(bmp[0], 0x42);
    assert.equal(bmp[1], 0x4d);
    // Pixel data starts at offset 54; BGR order for red is 0,0,255.
    assert.equal(bmp[54], 0);
    assert.equal(bmp[55], 0);
    assert.equal(bmp[56], 255);
  });

  it("composites translucent pixels onto white", () => {
    const pixels = Buffer.from([0, 0, 0, 128]); // 50% black
    const bmp = encodeBmp(1, 1, pixels, "rgba", 72);
    // round(0*128 + 255*127)/255 ≈ 127
    assert.equal(bmp[54], 127);
    assert.equal(bmp[55], 127);
    assert.equal(bmp[56], 127);
  });
});

describe("printBitmap input validation", () => {
  it("rejects before touching a backend", async () => {
    await assert.rejects(printBitmap({ width: 1, height: 1, data: Buffer.alloc(2) }), {
      code: "EINVALIDOPTION",
      option: "source.data",
    });
    await assert.rejects(
      printBitmap(solidBitmap(1, 1), { pages: "1" }),
      { code: "EINVALIDOPTION", option: "pages" },
    );
  });
});
