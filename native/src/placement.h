#pragma once

#include <algorithm>
#include <cmath>

#include "backend.h"

namespace pin {

// Everything the placement calculation needs to know about a sheet, in the units
// GetDeviceCaps reports.
//
// A printer device context's origin sits at the top-left of the *printable*
// area, not of the sheet, and `offset` is how far that is from the sheet corner.
// Getting that wrong is what makes output drift towards one margin, so both
// rectangles are carried explicitly rather than being conflated.
struct SheetMetrics {
  int dpi_x = 300;
  int dpi_y = 300;
  int physical_width = 0;   // whole sheet, device pixels
  int physical_height = 0;
  int printable_width = 0;  // area the device can actually mark
  int printable_height = 0;
  int offset_x = 0;         // printable origin, relative to the sheet corner
  int offset_y = 0;
};

// Where a page lands on the sheet, in the device context's coordinate space.
struct Placement {
  int x = 0;
  int y = 0;
  int width = 0;
  int height = 0;
  // Quarter turns clockwise to pass to PDFium: 0 or 1 here, since the only
  // rotation applied is the one that matches page orientation to sheet
  // orientation.
  int rotate = 0;
};

// Maps a PDF page onto a sheet.
//
// `page_width_pt` and `page_height_pt` are PostScript points (1/72"), which is
// what PDFium reports. `auto_rotate` turns a page a quarter turn when its
// orientation disagrees with the sheet's, so a landscape drawing fills a
// portrait sheet instead of being shrunk to fit across it.
inline Placement ComputePlacement(double page_width_pt,
                                  double page_height_pt,
                                  const SheetMetrics& sheet,
                                  ScaleMode scale,
                                  bool auto_rotate) {
  Placement placement;
  if (page_width_pt <= 0.0 || page_height_pt <= 0.0) return placement;

  const double width_px = page_width_pt / 72.0 * sheet.dpi_x;
  const double height_px = page_height_pt / 72.0 * sheet.dpi_y;

  double effective_width = width_px;
  double effective_height = height_px;
  if (auto_rotate && sheet.printable_width > 0 && sheet.printable_height > 0) {
    const bool page_is_landscape = width_px > height_px;
    const bool sheet_is_landscape = sheet.printable_width > sheet.printable_height;
    if (page_is_landscape != sheet_is_landscape) {
      placement.rotate = 1;
      std::swap(effective_width, effective_height);
    }
  }

  double factor = 1.0;
  if ((scale == ScaleMode::kFit || scale == ScaleMode::kShrink) && sheet.printable_width > 0 &&
      sheet.printable_height > 0) {
    factor = std::min(static_cast<double>(sheet.printable_width) / effective_width,
                      static_cast<double>(sheet.printable_height) / effective_height);
    // `shrink` is the familiar viewer default: never enlarge, only rescue pages
    // that would otherwise overflow the paper.
    if (scale == ScaleMode::kShrink) factor = std::min(1.0, factor);
  }

  placement.width = std::max(1, static_cast<int>(std::lround(effective_width * factor)));
  placement.height = std::max(1, static_cast<int>(std::lround(effective_height * factor)));

  switch (scale) {
    case ScaleMode::kNoScaleClip:
      // Anchored at the printable origin: predictable for pre-printed
      // stationery and labels, where centring would move the content.
      placement.x = 0;
      placement.y = 0;
      break;
    case ScaleMode::kActual:
      // Centred on the physical sheet, so a page the same size as the paper
      // lands exactly on it even though the margins mean part of it cannot be
      // marked.
      placement.x = (sheet.physical_width - placement.width) / 2 - sheet.offset_x;
      placement.y = (sheet.physical_height - placement.height) / 2 - sheet.offset_y;
      break;
    case ScaleMode::kFit:
    case ScaleMode::kShrink:
      // Scaled against the printable area, so centre within it.
      placement.x = (sheet.printable_width - placement.width) / 2;
      placement.y = (sheet.printable_height - placement.height) / 2;
      break;
  }

  return placement;
}

}  // namespace pin
