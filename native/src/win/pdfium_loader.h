#pragma once

#include <string>

#include "fpdfview.h"
#include "status.h"

namespace pin {
namespace pdfium {

// PDFium's Windows print modes, from fpdf_edit.h. Only these nine values are
// needed, so the 1700-line header they live in is not vendored; the JS layer
// maps its `printMode` names onto them.
inline constexpr int kPrintModeEmf = 0;
inline constexpr int kPrintModeTextOnly = 1;
inline constexpr int kPrintModePostScript2 = 2;
inline constexpr int kPrintModePostScript3 = 3;
inline constexpr int kPrintModePostScript2Passthrough = 4;
inline constexpr int kPrintModePostScript3Passthrough = 5;
inline constexpr int kPrintModeEmfImageMasks = 6;
inline constexpr int kPrintModePostScript3Type42 = 7;
inline constexpr int kPrintModePostScript3Type42Passthrough = 8;

// The subset of PDFium the printing path uses, resolved from pdfium.dll at
// runtime rather than linked against its import library. Loading by absolute
// path keeps the addon independent of the DLL search order, which is the usual
// source of "works on my machine" failures when a foreign pdfium.dll is already
// present in the process or on PATH.
struct Library {
  void (*InitLibraryWithConfig)(const FPDF_LIBRARY_CONFIG* config);
  void (*DestroyLibrary)();
  FPDF_BOOL (*SetPrintMode)(int mode);
  unsigned long (*GetLastError)();

  FPDF_DOCUMENT (*LoadDocument)(FPDF_STRING file_path, FPDF_BYTESTRING password);
  FPDF_DOCUMENT (*LoadMemDocument64)(const void* data, size_t size, FPDF_BYTESTRING password);
  void (*CloseDocument)(FPDF_DOCUMENT document);

  int (*GetPageCount)(FPDF_DOCUMENT document);
  FPDF_BOOL (*GetPageSizeByIndexF)(FPDF_DOCUMENT document, int page_index, FS_SIZEF* size);
  FPDF_PAGE (*LoadPage)(FPDF_DOCUMENT document, int page_index);
  void (*ClosePage)(FPDF_PAGE page);
  float (*GetPageWidthF)(FPDF_PAGE page);
  float (*GetPageHeightF)(FPDF_PAGE page);

  FPDF_BOOL (*RenderPage)(HDC dc,
                          FPDF_PAGE page,
                          int start_x,
                          int start_y,
                          int size_x,
                          int size_y,
                          int rotate,
                          int flags);
  void (*RenderPageBitmap)(FPDF_BITMAP bitmap,
                           FPDF_PAGE page,
                           int start_x,
                           int start_y,
                           int size_x,
                           int size_y,
                           int rotate,
                           int flags);

  FPDF_BITMAP (*BitmapCreateEx)(int width, int height, int format, void* first_scan, int stride);
  FPDF_BOOL (*BitmapFillRect)(FPDF_BITMAP bitmap,
                              int left,
                              int top,
                              int width,
                              int height,
                              FPDF_DWORD color);
  void (*BitmapDestroy)(FPDF_BITMAP bitmap);
};

// Loads pdfium.dll and calls FPDF_InitLibraryWithConfig once per process.
// Returns nullptr and fills `status` when the DLL is missing or unusable.
const Library* Load(Status* status);

// Version of the loaded runtime, taken from the DLL's own resource information,
// or the empty string when it could not be read.
const std::string& Version();

// Full path of the DLL that was loaded, for diagnostics.
const std::string& LoadedPath();

// Turns FPDF_GetLastError() into a Status. PDFium reports "no password" and
// "wrong password" distinctly from corruption, which is worth passing on.
Status LastErrorStatus(const Library& library, const std::string& context);

}  // namespace pdfium
}  // namespace pin
