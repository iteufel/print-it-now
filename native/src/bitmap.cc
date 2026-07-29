#include "bitmap.h"

namespace pin {
namespace bitmap {
namespace {

Status ValidatePixels(int width, int height, size_t data_length) {
  if (width < 1 || height < 1) {
    return Status::Error(code::kBackend, "Bitmap dimensions must be positive");
  }
  const size_t expected =
      static_cast<size_t>(width) * static_cast<size_t>(height) * 4u;
  if (data_length != expected) {
    return Status::Error(code::kBackend,
                         "Bitmap pixel buffer length does not match width × height × 4");
  }
  return Status::Ok();
}

void WriteLe16(uint8_t* dest, uint16_t value) {
  dest[0] = static_cast<uint8_t>(value & 0xff);
  dest[1] = static_cast<uint8_t>((value >> 8) & 0xff);
}

void WriteLe32(uint8_t* dest, uint32_t value) {
  dest[0] = static_cast<uint8_t>(value & 0xff);
  dest[1] = static_cast<uint8_t>((value >> 8) & 0xff);
  dest[2] = static_cast<uint8_t>((value >> 16) & 0xff);
  dest[3] = static_cast<uint8_t>((value >> 24) & 0xff);
}

int DpiToPixelsPerMeter(int dpi) {
  // 1 inch = 0.0254 m; round to nearest integer.
  if (dpi <= 0) dpi = 72;
  return static_cast<int>((static_cast<long long>(dpi) * 10000 + 127) / 254);
}

}  // namespace

Status ToBgrx(PixelFormat format,
              int width,
              int height,
              const uint8_t* data,
              size_t data_length,
              std::vector<uint8_t>* out) {
  PIN_RETURN_IF_ERROR(ValidatePixels(width, height, data_length));

  const size_t stride = static_cast<size_t>(width) * 4u;
  out->assign(stride * static_cast<size_t>(height), 0);

  for (int y = 0; y < height; ++y) {
    const uint8_t* src_row = data + static_cast<size_t>(y) * stride;
    uint8_t* dest_row = out->data() + static_cast<size_t>(y) * stride;
    for (int x = 0; x < width; ++x) {
      uint8_t bgr[3];
      CompositeToBgr(format, src_row + static_cast<size_t>(x) * 4u, bgr);
      dest_row[static_cast<size_t>(x) * 4u + 0] = bgr[0];
      dest_row[static_cast<size_t>(x) * 4u + 1] = bgr[1];
      dest_row[static_cast<size_t>(x) * 4u + 2] = bgr[2];
      // Fourth byte unused by BI_RGB; leave zero.
    }
  }
  return Status::Ok();
}

Status EncodeBmp(PixelFormat format,
                 int width,
                 int height,
                 const uint8_t* data,
                 size_t data_length,
                 int dpi,
                 std::vector<uint8_t>* out) {
  PIN_RETURN_IF_ERROR(ValidatePixels(width, height, data_length));

  // BMP rows are padded to a multiple of 4 bytes.
  const int row_stride = (width * 3 + 3) & ~3;
  const size_t pixel_bytes = static_cast<size_t>(row_stride) * static_cast<size_t>(height);
  constexpr size_t kHeaderSize = 14 + 40;
  out->assign(kHeaderSize + pixel_bytes, 0);

  uint8_t* header = out->data();
  header[0] = 'B';
  header[1] = 'M';
  WriteLe32(header + 2, static_cast<uint32_t>(out->size()));
  WriteLe32(header + 10, static_cast<uint32_t>(kHeaderSize));

  WriteLe32(header + 14, 40);  // BITMAPINFOHEADER size
  WriteLe32(header + 18, static_cast<uint32_t>(width));
  // Positive height = bottom-up, the classic BMP layout.
  WriteLe32(header + 22, static_cast<uint32_t>(height));
  WriteLe16(header + 26, 1);   // planes
  WriteLe16(header + 28, 24);  // bits per pixel
  WriteLe32(header + 34, static_cast<uint32_t>(pixel_bytes));
  const uint32_t ppm = static_cast<uint32_t>(DpiToPixelsPerMeter(dpi));
  WriteLe32(header + 38, ppm);
  WriteLe32(header + 42, ppm);

  const size_t src_stride = static_cast<size_t>(width) * 4u;
  for (int y = 0; y < height; ++y) {
    // BMP stores rows bottom-up.
    const int src_y = height - 1 - y;
    const uint8_t* src_row = data + static_cast<size_t>(src_y) * src_stride;
    uint8_t* dest_row = out->data() + kHeaderSize + static_cast<size_t>(y) * row_stride;
    for (int x = 0; x < width; ++x) {
      CompositeToBgr(format, src_row + static_cast<size_t>(x) * 4u, dest_row + x * 3);
    }
  }
  return Status::Ok();
}

}  // namespace bitmap
}  // namespace pin
