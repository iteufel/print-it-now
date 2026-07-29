#include "render_win.h"

#include <algorithm>
#include <cmath>
#include <vector>

#include "win_util.h"

namespace pin {
namespace win {
namespace {

// Annotations are included because a filled-in form or a stamped approval is
// almost always meant to appear on paper; FPDF_PRINTING selects PDFium's
// print-oriented rendering, which is the flag that makes it honour "print" 
// appearance streams and skip screen-only optimisations.
constexpr int kRenderFlags = FPDF_PRINTING | FPDF_ANNOT;

// Cap on how much of a page is rasterised at once. A 600 dpi A3 page is roughly
// 190 MB as 32bpp BGRA, which is not something to allocate in one go inside a
// server process, so tall pages are rendered as horizontal bands.
constexpr size_t kMaxBandBytes = 16u * 1024u * 1024u;

int ScaleEdge(int edge, int from, int to) {
  if (from <= 0) return 0;
  return static_cast<int>(std::lround(static_cast<double>(edge) * to / from));
}

Status RenderVector(const pdfium::Library& pdfium,
                    HDC dc,
                    FPDF_PAGE page,
                    const Placement& placement) {
  if (pdfium.RenderPage(dc, page, placement.x, placement.y, placement.width, placement.height,
                        placement.rotate, kRenderFlags) == 0) {
    return pdfium::LastErrorStatus(pdfium, "PDFium could not render a page to the printer");
  }
  return Status::Ok();
}

Status RenderBitmap(const pdfium::Library& pdfium,
                    HDC dc,
                    FPDF_PAGE page,
                    const Placement& placement,
                    const SheetMetrics& sheet,
                    int requested_dpi) {
  // Rasterise at the device's own resolution unless the caller asked for less.
  // Asking for more than the device can mark only costs memory.
  int raster_width = placement.width;
  int raster_height = placement.height;
  const int device_dpi = std::max(sheet.dpi_x, sheet.dpi_y);
  if (requested_dpi > 0 && device_dpi > 0 && requested_dpi < device_dpi) {
    const double factor = static_cast<double>(requested_dpi) / device_dpi;
    raster_width = std::max(1, static_cast<int>(std::lround(placement.width * factor)));
    raster_height = std::max(1, static_cast<int>(std::lround(placement.height * factor)));
  }

  const size_t stride = static_cast<size_t>(raster_width) * 4;
  const int band_rows = static_cast<int>(
      std::max<size_t>(1, std::min<size_t>(static_cast<size_t>(raster_height),
                                           kMaxBandBytes / std::max<size_t>(stride, 1))));

  std::vector<unsigned char> band(stride * static_cast<size_t>(band_rows));

  BITMAPINFO info{};
  info.bmiHeader.biSize = sizeof(BITMAPINFOHEADER);
  info.bmiHeader.biWidth = raster_width;
  info.bmiHeader.biPlanes = 1;
  info.bmiHeader.biBitCount = 32;
  info.bmiHeader.biCompression = BI_RGB;

  const int previous_mode = SetStretchBltMode(dc, HALFTONE);
  // HALFTONE requires the brush origin to be reset, or dithered fills drift
  // between successive blits.
  SetBrushOrgEx(dc, 0, 0, nullptr);

  Status status = Status::Ok();
  for (int top = 0; top < raster_height; top += band_rows) {
    const int rows = std::min(band_rows, raster_height - top);

    // FPDFBitmap_BGRx matches Windows' 32bpp BI_RGB layout byte for byte, and
    // skipping alpha avoids any question of how GDI would interpret it.
    FPDF_BITMAP bitmap = pdfium.BitmapCreateEx(raster_width, rows, FPDFBitmap_BGRx, band.data(),
                                               static_cast<int>(stride));
    if (bitmap == nullptr) {
      status = Status::Error(code::kBackend,
                            "Could not allocate a rasterisation buffer for the page");
      break;
    }

    pdfium.BitmapFillRect(bitmap, 0, 0, raster_width, rows, 0xFFFFFFFF);
    // Shifting the origin up by `top` renders the whole page's geometry but only
    // lets this band's rows land in the buffer.
    pdfium.RenderPageBitmap(bitmap, page, 0, -top, raster_width, raster_height,
                            placement.rotate, kRenderFlags);
    pdfium.BitmapDestroy(bitmap);

    // Destination edges are derived from cumulative positions rather than by
    // scaling each band's height, so rounding cannot leave a hairline gap
    // between bands.
    const int destination_top = ScaleEdge(top, raster_height, placement.height);
    const int destination_bottom = ScaleEdge(top + rows, raster_height, placement.height);
    const int destination_rows = std::max(1, destination_bottom - destination_top);

    // Negative height marks the DIB as top-down, matching PDFium's row order.
    info.bmiHeader.biHeight = -rows;

    // StretchDIBits is declared as returning int, so the documented GDI_ERROR
    // sentinel arrives here as -1; comparing against the unsigned constant
    // directly would never match.
    if (StretchDIBits(dc, placement.x, placement.y + destination_top, placement.width,
                      destination_rows, 0, 0, raster_width, rows, band.data(), &info,
                      DIB_RGB_COLORS, SRCCOPY) == static_cast<int>(GDI_ERROR)) {
      const DWORD error = GetLastError();
      status = Status::Error(code::kBackend,
                            "The printer driver rejected a rasterised page band: " +
                                FormatLastError(error),
                            static_cast<int>(error), FormatLastError(error));
      break;
    }
  }

  if (previous_mode != 0) SetStretchBltMode(dc, previous_mode);
  return status;
}

}  // namespace

SheetMetrics ReadSheetMetrics(HDC dc) {
  SheetMetrics sheet;
  sheet.dpi_x = std::max(1, GetDeviceCaps(dc, LOGPIXELSX));
  sheet.dpi_y = std::max(1, GetDeviceCaps(dc, LOGPIXELSY));
  sheet.printable_width = GetDeviceCaps(dc, HORZRES);
  sheet.printable_height = GetDeviceCaps(dc, VERTRES);
  sheet.physical_width = GetDeviceCaps(dc, PHYSICALWIDTH);
  sheet.physical_height = GetDeviceCaps(dc, PHYSICALHEIGHT);
  sheet.offset_x = GetDeviceCaps(dc, PHYSICALOFFSETX);
  sheet.offset_y = GetDeviceCaps(dc, PHYSICALOFFSETY);

  // Some drivers, notably file-backed ones, report no physical extent at all.
  // Falling back to the printable area keeps the centring maths sane instead of
  // pushing every page off the top-left corner.
  if (sheet.physical_width <= 0) sheet.physical_width = sheet.printable_width;
  if (sheet.physical_height <= 0) sheet.physical_height = sheet.printable_height;
  return sheet;
}

Status RenderPage(const pdfium::Library& pdfium,
                  HDC dc,
                  FPDF_PAGE page,
                  const Placement& placement,
                  const SheetMetrics& sheet,
                  RenderMode mode,
                  int requested_dpi) {
  if (placement.width <= 0 || placement.height <= 0) {
    return Status::Error(code::kInvalidPdf, "A page reported a zero or negative size");
  }
  if (mode == RenderMode::kBitmap) {
    return RenderBitmap(pdfium, dc, page, placement, sheet, requested_dpi);
  }
  return RenderVector(pdfium, dc, page, placement);
}

}  // namespace win
}  // namespace pin
