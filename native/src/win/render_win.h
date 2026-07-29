#pragma once

#include <windows.h>

#include "backend.h"
#include "pdfium_loader.h"
#include "placement.h"
#include "status.h"

namespace pin {
namespace win {

// Reads the sheet geometry the placement calculation needs off a printer DC.
SheetMetrics ReadSheetMetrics(HDC dc);

// Draws one page onto the printer DC between StartPage and EndPage.
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

}  // namespace win
}  // namespace pin
