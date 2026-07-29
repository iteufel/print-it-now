#pragma once

#include <cstdint>
#include <map>
#include <optional>
#include <string>
#include <vector>

#include "status.h"

namespace pin {

// A 1-based, inclusive page range. `to == kToEnd` means "through the last page".
struct PageRange {
  static constexpr int kToEnd = 0;
  int from = 1;
  int to = kToEnd;
};

enum class PageSubset { kAll = 0, kOdd = 1, kEven = 2 };

enum class ScaleMode { kActual = 0, kFit = 1, kShrink = 2, kNoScaleClip = 3 };

enum class RenderMode { kVector = 0, kBitmap = 1 };

// Windows-only settings. Every numeric field already holds the DEVMODE value
// the driver expects; the semantic-to-numeric mapping lives in src/options.ts so
// that it can be unit tested without a printer attached. A field left empty
// means "leave the driver default alone".
struct WindowsSettings {
  std::optional<int16_t> orientation;   // DMORIENT_*
  std::optional<int16_t> paper_size;    // DMPAPER_*
  std::optional<int16_t> paper_width;   // tenths of a millimetre
  std::optional<int16_t> paper_length;  // tenths of a millimetre
  std::optional<int16_t> duplex;        // DMDUP_*
  std::optional<int16_t> color;         // DMCOLOR_*
  std::optional<int16_t> quality;       // DMRES_*
  std::optional<int16_t> bin;           // DMBIN_*
  std::optional<int16_t> collate;       // DMCOLLATE_*

  RenderMode render_mode = RenderMode::kVector;
  // Forwarded to FPDF_SetPrintMode. Only consulted for RenderMode::kVector.
  int print_mode = 0;
  // Rasterisation resolution for RenderMode::kBitmap; 0 means "use the
  // device's own resolution".
  int dpi = 0;
  // Spool to this file instead of the device. Needed by file-backed drivers
  // such as "Microsoft Print to PDF", which otherwise raise a save dialog.
  std::string output_file;
};

struct PrintRequest {
  std::string printer;
  std::string job_name;

  // Exactly one of these is populated. Binary input is handed straight to the
  // printing subsystem, so nothing is ever staged through a temporary file.
  std::string file_path;
  const uint8_t* data = nullptr;
  size_t data_length = 0;

  int copies = 1;
  bool collate = true;
  std::vector<PageRange> ranges;  // empty means the whole document
  PageSubset subset = PageSubset::kAll;
  bool reverse = false;
  ScaleMode scale = ScaleMode::kShrink;
  int number_up = 1;

  // Fully resolved IPP attributes for the CUPS backend. Ignored on Windows.
  std::vector<std::pair<std::string, std::string>> ipp;

  WindowsSettings windows;
};

struct PrintResult {
  int job_id = 0;
  std::string printer;
  std::string job_name;
  // Pages the backend was asked to produce. Left empty when the backend
  // resolves the selection itself, as CUPS does for `page-ranges`.
  std::optional<int> page_count;
};

enum class PrinterState { kIdle = 0, kProcessing = 1, kStopped = 2, kUnknown = 3 };

struct PrinterInfo {
  std::string name;
  std::string display_name;
  bool is_default = false;
  PrinterState state = PrinterState::kUnknown;
  std::string state_reason;
  std::string location;
  std::string driver;
  std::string uri;
  bool accepting_jobs = true;
};

enum class JobState {
  kPending = 0,
  kHeld = 1,
  kProcessing = 2,
  kStopped = 3,
  kCompleted = 4,
  kCanceled = 5,
  kAborted = 6,
  kUnknown = 7,
};

struct JobInfo {
  int job_id = 0;
  std::string printer;
  std::string job_name;
  JobState state = JobState::kUnknown;
  std::optional<int> total_pages;
  std::optional<int> pages_printed;
  std::optional<int64_t> size;
  // Seconds since the Unix epoch, or empty when the backend does not say.
  std::optional<int64_t> created_at;
  std::string raw_state;
};

struct BackendInfo {
  std::string backend;
  std::string pdfium_version;
  std::string cups_library;
};

// Exactly one translation unit implements these: native/src/win/backend_win.cc
// on Windows, native/src/posix/backend_cups.cc elsewhere. All of them run on a
// libuv worker thread, never on the JS thread.
namespace backend {

Status Describe(BackendInfo* out);
Status ListPrinters(std::vector<PrinterInfo>* out);
// Leaves *out empty when the system has no default printer, which is not an
// error at this layer.
Status DefaultPrinter(std::string* out);
Status Print(const PrintRequest& request, PrintResult* out);
// Sets *found to false when the queue has no such job.
//
// Named QueryJob rather than GetJob because <winspool.h> defines `GetJob` as a
// macro selecting between GetJobA and GetJobW, which would silently rename this
// declaration on Windows and leave the call sites resolving to the wrong thing.
Status QueryJob(const std::string& printer, int job_id, JobInfo* out, bool* found);
Status CancelJob(const std::string& printer, int job_id);

}  // namespace backend
}  // namespace pin
