#pragma once

#include <windows.h>

#include <cstdint>
#include <vector>

#include "backend.h"
#include "pdfium_loader.h"
#include "placement.h"
#include "status.h"

namespace pin {
namespace win {

// Reads the sheet geometry the placement calculation needs off a printer DC.
SheetMetrics ReadSheetMetrics(HDC dc);

// Draws one PDF page onto the printer DC between StartPage and EndPage.
//
// `vector` mode hands the page to PDFium's Windows print device, which emits EMF
// or PostScript: text stays resolution-independent and the spool file stays
// small. `bitmap` mode rasterises to a DIB and blits it, which is slower and
// larger but survives drivers that mishandle EMF records. This mirrors the two
// paths PdfiumViewer offers on .NET.
Status RenderPage(const pdfium::Library& pdfium,
                  HDC dc,
                  FPDF_PAGE page,
                  const Placement& placement,
                  const SheetMetrics& sheet,
                  RenderMode mode,
                  int requested_dpi);

// Blits a tightly packed top-down 32-bpp BGRx buffer onto the printer DC at the
// given placement. Tall images are sent in horizontal bands so a large buffer
// never has to sit in the process heap all at once as a second copy.
Status BlitBgrx(HDC dc,
                const Placement& placement,
                int width,
                int height,
                const uint8_t* pixels,
                size_t stride);

// Converts a raw pixel buffer to BGRx and blits it. Used by printBitmap.
Status RenderRawBitmap(HDC dc,
                       const Placement& placement,
                       PixelFormat format,
                       int width,
                       int height,
                       const uint8_t* data,
                       size_t data_length);

}  // namespace win
}  // namespace pin
