#pragma once

#include <cstddef>
#include <cstdint>
#include <vector>

#include "backend.h"
#include "status.h"

namespace pin {
namespace bitmap {

// Composites a source pixel onto an opaque white background and returns the
// resulting B, G, R bytes. Alpha 255 is opaque; alpha 0 leaves the white
// background alone.
inline void CompositeToBgr(PixelFormat format,
                           const uint8_t* pixel,
                           uint8_t* bgr) {
  uint8_t r = 0;
  uint8_t g = 0;
  uint8_t b = 0;
  uint8_t a = 255;
  if (format == PixelFormat::kBgra) {
    b = pixel[0];
    g = pixel[1];
    r = pixel[2];
    a = pixel[3];
  } else {
    r = pixel[0];
    g = pixel[1];
    b = pixel[2];
    a = pixel[3];
  }

  if (a >= 255) {
    bgr[0] = b;
    bgr[1] = g;
    bgr[2] = r;
    return;
  }
  if (a == 0) {
    bgr[0] = 255;
    bgr[1] = 255;
    bgr[2] = 255;
    return;
  }

  // Straight alpha over white: out = src * a + 255 * (1 - a).
  const unsigned inv = 255u - a;
  bgr[0] = static_cast<uint8_t>((b * a + 255u * inv + 127u) / 255u);
  bgr[1] = static_cast<uint8_t>((g * a + 255u * inv + 127u) / 255u);
  bgr[2] = static_cast<uint8_t>((r * a + 255u * inv + 127u) / 255u);
}

// Packs tightly-packed 4-byte pixels into a top-down 32-bpp BGRx buffer that
// StretchDIBits can consume with BI_RGB. The fourth byte is left as 0.
Status ToBgrx(PixelFormat format,
              int width,
              int height,
              const uint8_t* data,
              size_t data_length,
              std::vector<uint8_t>* out);

// Encodes tightly-packed 4-byte pixels as an in-memory 24-bit Windows BMP.
// `dpi` is written into the header's pixels-per-metre fields so CUPS can honour
// the caller's intrinsic resolution; values <= 0 default to 72.
Status EncodeBmp(PixelFormat format,
                 int width,
                 int height,
                 const uint8_t* data,
                 size_t data_length,
                 int dpi,
                 std::vector<uint8_t>* out);

}  // namespace bitmap
}  // namespace pin
