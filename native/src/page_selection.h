#pragma once

#include <algorithm>
#include <vector>

#include "backend.h"

namespace pin {

// Expands a request's page selection into concrete 1-based page numbers.
//
// This has to happen natively rather than in JS because the page count is only
// known once the document is open, and only the renderer can open it. CUPS does
// its own expansion server-side from `page-ranges`, so in practice this drives
// the Windows page loop; it is exported to JS as `_expandPageSelection` purely
// so the tests can exercise it on every platform.
//
// Out-of-document ranges are clamped rather than rejected: asking for pages
// 1-9999 of a three page PDF prints three pages, matching how viewers behave.
// Pages are emitted once each, in ascending order, even if the caller's ranges
// overlap -- an overlap is far more likely to be a typo than a request for
// duplicates, and `copies` is the option for wanting more than one.
inline std::vector<int> ExpandPageSelection(const std::vector<PageRange>& ranges,
                                            PageSubset subset,
                                            bool reverse,
                                            int page_count) {
  std::vector<int> pages;
  if (page_count <= 0) return pages;

  std::vector<bool> selected(static_cast<size_t>(page_count) + 1, false);

  if (ranges.empty()) {
    std::fill(selected.begin() + 1, selected.end(), true);
  } else {
    for (const PageRange& range : ranges) {
      int from = std::max(1, range.from);
      int to = range.to == PageRange::kToEnd ? page_count : range.to;
      to = std::min(to, page_count);
      for (int page = from; page <= to; ++page) {
        selected[static_cast<size_t>(page)] = true;
      }
    }
  }

  for (int page = 1; page <= page_count; ++page) {
    if (!selected[static_cast<size_t>(page)]) continue;
    const bool odd = (page % 2) == 1;
    if (subset == PageSubset::kOdd && !odd) continue;
    if (subset == PageSubset::kEven && odd) continue;
    pages.push_back(page);
  }

  if (reverse) std::reverse(pages.begin(), pages.end());
  return pages;
}

}  // namespace pin
