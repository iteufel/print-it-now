#include <windows.h>
#include <winspool.h>

#include <algorithm>
#include <string>
#include <vector>

#include "backend.h"
#include "devmode.h"
#include "page_selection.h"
#include "pdfium_loader.h"
#include "placement.h"
#include "render_win.h"
#include "status.h"
#include "win_util.h"

// Present in the Windows SDK but missing from some older toolchain headers,
// including the MinGW ones the syntax-check job uses.
#ifndef JOB_STATUS_RETAINED
#define JOB_STATUS_RETAINED 0x00002000
#endif

namespace pin {
namespace backend {
namespace {

// Closes a printer DC created with CreateDCW.
class DeviceContext {
 public:
  DeviceContext() = default;
  ~DeviceContext() {
    if (dc_ != nullptr) DeleteDC(dc_);
  }

  DeviceContext(const DeviceContext&) = delete;
  DeviceContext& operator=(const DeviceContext&) = delete;

  void Reset(HDC dc) {
    if (dc_ != nullptr) DeleteDC(dc_);
    dc_ = dc;
  }

  HDC get() const { return dc_; }

 private:
  HDC dc_ = nullptr;
};

// Ends the document, or aborts it if the job never completed. Abandoning a
// half-written document with EndDoc would spool whatever had been written so
// far; AbortDoc discards it, which is what a failure part-way through a
// multi-page job should do.
class DocumentScope {
 public:
  DocumentScope(HDC dc) : dc_(dc) {}
  ~DocumentScope() {
    if (!open_) return;
    if (committed_) {
      EndDoc(dc_);
    } else {
      AbortDoc(dc_);
    }
  }

  DocumentScope(const DocumentScope&) = delete;
  DocumentScope& operator=(const DocumentScope&) = delete;

  void MarkOpen() { open_ = true; }
  void Commit() { committed_ = true; }

 private:
  HDC dc_;
  bool open_ = false;
  bool committed_ = false;
};

class Document {
 public:
  explicit Document(const pdfium::Library& pdfium) : pdfium_(pdfium) {}
  ~Document() {
    if (document_ != nullptr) pdfium_.CloseDocument(document_);
  }

  Document(const Document&) = delete;
  Document& operator=(const Document&) = delete;

  Status Open(const PrintRequest& request) {
    if (request.data != nullptr) {
      document_ = pdfium_.LoadMemDocument64(request.data, request.data_length, nullptr);
    } else {
      // PDFium takes a UTF-8 path on Windows and widens it internally, which is
      // what makes non-ASCII paths work without us converting.
      document_ = pdfium_.LoadDocument(request.file_path.c_str(), nullptr);
    }
    if (document_ == nullptr) {
      return pdfium::LastErrorStatus(pdfium_, "Could not open the PDF");
    }
    return Status::Ok();
  }

  FPDF_DOCUMENT get() const { return document_; }

 private:
  const pdfium::Library& pdfium_;
  FPDF_DOCUMENT document_ = nullptr;
};

class Page {
 public:
  Page(const pdfium::Library& pdfium, FPDF_DOCUMENT document, int index) : pdfium_(pdfium) {
    page_ = pdfium.LoadPage(document, index);
  }
  ~Page() {
    if (page_ != nullptr) pdfium_.ClosePage(page_);
  }

  Page(const Page&) = delete;
  Page& operator=(const Page&) = delete;

  FPDF_PAGE get() const { return page_; }

 private:
  const pdfium::Library& pdfium_;
  FPDF_PAGE page_ = nullptr;
};

PrinterState ToPrinterState(DWORD status, DWORD attributes) {
  constexpr DWORD kStopped = PRINTER_STATUS_PAUSED | PRINTER_STATUS_ERROR |
                             PRINTER_STATUS_PAPER_JAM | PRINTER_STATUS_PAPER_OUT |
                             PRINTER_STATUS_OFFLINE | PRINTER_STATUS_OUT_OF_MEMORY |
                             PRINTER_STATUS_DOOR_OPEN | PRINTER_STATUS_NOT_AVAILABLE |
                             PRINTER_STATUS_NO_TONER | PRINTER_STATUS_USER_INTERVENTION;
  if ((attributes & PRINTER_ATTRIBUTE_WORK_OFFLINE) != 0) return PrinterState::kStopped;
  if ((status & kStopped) != 0) return PrinterState::kStopped;
  if ((status & (PRINTER_STATUS_PRINTING | PRINTER_STATUS_PROCESSING |
                 PRINTER_STATUS_BUSY | PRINTER_STATUS_WARMING_UP)) != 0) {
    return PrinterState::kProcessing;
  }
  if (status == 0) return PrinterState::kIdle;
  return PrinterState::kUnknown;
}

std::string DescribePrinterStatus(DWORD status) {
  struct Bit {
    DWORD mask;
    const char* text;
  };
  static constexpr Bit kBits[] = {
      {PRINTER_STATUS_PAUSED, "paused"},
      {PRINTER_STATUS_ERROR, "error"},
      {PRINTER_STATUS_PENDING_DELETION, "pending-deletion"},
      {PRINTER_STATUS_PAPER_JAM, "paper-jam"},
      {PRINTER_STATUS_PAPER_OUT, "paper-out"},
      {PRINTER_STATUS_MANUAL_FEED, "manual-feed"},
      {PRINTER_STATUS_PAPER_PROBLEM, "paper-problem"},
      {PRINTER_STATUS_OFFLINE, "offline"},
      {PRINTER_STATUS_IO_ACTIVE, "io-active"},
      {PRINTER_STATUS_BUSY, "busy"},
      {PRINTER_STATUS_PRINTING, "printing"},
      {PRINTER_STATUS_OUTPUT_BIN_FULL, "output-bin-full"},
      {PRINTER_STATUS_NOT_AVAILABLE, "not-available"},
      {PRINTER_STATUS_WAITING, "waiting"},
      {PRINTER_STATUS_PROCESSING, "processing"},
      {PRINTER_STATUS_INITIALIZING, "initializing"},
      {PRINTER_STATUS_WARMING_UP, "warming-up"},
      {PRINTER_STATUS_TONER_LOW, "toner-low"},
      {PRINTER_STATUS_NO_TONER, "no-toner"},
      {PRINTER_STATUS_PAGE_PUNT, "page-punt"},
      {PRINTER_STATUS_USER_INTERVENTION, "user-intervention"},
      {PRINTER_STATUS_OUT_OF_MEMORY, "out-of-memory"},
      {PRINTER_STATUS_DOOR_OPEN, "door-open"},
      {PRINTER_STATUS_SERVER_UNKNOWN, "server-unknown"},
      {PRINTER_STATUS_POWER_SAVE, "power-save"},
  };

  std::string reasons;
  for (const Bit& bit : kBits) {
    if ((status & bit.mask) == 0) continue;
    if (!reasons.empty()) reasons += ",";
    reasons += bit.text;
  }
  return reasons;
}

JobState ToJobState(DWORD status) {
  if ((status & (JOB_STATUS_DELETING | JOB_STATUS_DELETED)) != 0) return JobState::kCanceled;
  if ((status & JOB_STATUS_PRINTED) != 0) return JobState::kCompleted;
  if ((status & JOB_STATUS_COMPLETE) != 0) return JobState::kCompleted;
  if ((status & JOB_STATUS_ERROR) != 0) return JobState::kAborted;
  if ((status & (JOB_STATUS_PAUSED | JOB_STATUS_BLOCKED_DEVQ |
                 JOB_STATUS_USER_INTERVENTION | JOB_STATUS_OFFLINE |
                 JOB_STATUS_PAPEROUT)) != 0) {
    return JobState::kStopped;
  }
  if ((status & (JOB_STATUS_PRINTING | JOB_STATUS_SPOOLING | JOB_STATUS_RETAINED)) != 0) {
    return JobState::kProcessing;
  }
  if (status == 0) return JobState::kPending;
  return JobState::kUnknown;
}

std::string DescribeJobStatus(DWORD status) {
  struct Bit {
    DWORD mask;
    const char* text;
  };
  static constexpr Bit kBits[] = {
      {JOB_STATUS_PAUSED, "paused"},          {JOB_STATUS_ERROR, "error"},
      {JOB_STATUS_DELETING, "deleting"},      {JOB_STATUS_SPOOLING, "spooling"},
      {JOB_STATUS_PRINTING, "printing"},      {JOB_STATUS_OFFLINE, "offline"},
      {JOB_STATUS_PAPEROUT, "paper-out"},     {JOB_STATUS_PRINTED, "printed"},
      {JOB_STATUS_DELETED, "deleted"},        {JOB_STATUS_BLOCKED_DEVQ, "blocked"},
      {JOB_STATUS_USER_INTERVENTION, "user-intervention"},
      {JOB_STATUS_RESTART, "restart"},        {JOB_STATUS_COMPLETE, "complete"},
      {JOB_STATUS_RETAINED, "retained"},
  };

  std::string reasons;
  for (const Bit& bit : kBits) {
    if ((status & bit.mask) == 0) continue;
    if (!reasons.empty()) reasons += ",";
    reasons += bit.text;
  }
  return reasons;
}

int64_t ToUnixSeconds(const SYSTEMTIME& system_time) {
  FILETIME file_time{};
  if (SystemTimeToFileTime(&system_time, &file_time) == 0) return 0;
  ULARGE_INTEGER value{};
  value.LowPart = file_time.dwLowDateTime;
  value.HighPart = file_time.dwHighDateTime;
  // FILETIME counts 100 ns intervals from 1601-01-01; 11644473600 seconds
  // separate that from the Unix epoch.
  constexpr uint64_t kIntervalsPerSecond = 10000000ull;
  constexpr uint64_t kEpochDifference = 11644473600ull;
  if (value.QuadPart < kEpochDifference * kIntervalsPerSecond) return 0;
  return static_cast<int64_t>(value.QuadPart / kIntervalsPerSecond - kEpochDifference);
}

std::string DefaultPrinterName() {
  DWORD length = 0;
  GetDefaultPrinterW(nullptr, &length);
  if (length == 0) return {};
  std::vector<wchar_t> buffer(length);
  if (GetDefaultPrinterW(buffer.data(), &length) == 0) return {};
  return win::Narrow(std::wstring(buffer.data()));
}

Status EnumeratePrinters(std::vector<PrinterInfo>* out) {
  // PRINTER_ENUM_CONNECTIONS is what surfaces per-user network queues; without
  // it, printers the user added themselves are invisible.
  constexpr DWORD kFlags = PRINTER_ENUM_LOCAL | PRINTER_ENUM_CONNECTIONS;
  DWORD needed = 0;
  DWORD returned = 0;

  EnumPrintersW(kFlags, nullptr, 2, nullptr, 0, &needed, &returned);
  if (needed == 0) return Status::Ok();  // no printers installed

  std::vector<unsigned char> buffer(needed);
  if (EnumPrintersW(kFlags, nullptr, 2, buffer.data(), needed, &needed, &returned) == 0) {
    const DWORD error = GetLastError();
    return Status::Error(code::kBackend, "Could not enumerate printers: " +
                                             win::FormatLastError(error),
                        static_cast<int>(error), win::FormatLastError(error));
  }

  const std::string default_printer = DefaultPrinterName();
  const PRINTER_INFO_2W* printers = reinterpret_cast<const PRINTER_INFO_2W*>(buffer.data());
  out->reserve(returned);
  for (DWORD i = 0; i < returned; ++i) {
    const PRINTER_INFO_2W& printer = printers[i];
    PrinterInfo info;
    info.name = printer.pPrinterName != nullptr ? win::Narrow(printer.pPrinterName) : "";
    info.display_name = printer.pComment != nullptr ? win::Narrow(printer.pComment) : "";
    info.is_default = !default_printer.empty() && info.name == default_printer;
    info.state = ToPrinterState(printer.Status, printer.Attributes);
    info.state_reason = DescribePrinterStatus(printer.Status);
    info.location = printer.pLocation != nullptr ? win::Narrow(printer.pLocation) : "";
    info.driver = printer.pDriverName != nullptr ? win::Narrow(printer.pDriverName) : "";
    info.uri = printer.pPortName != nullptr ? win::Narrow(printer.pPortName) : "";
    info.accepting_jobs = (printer.Status & PRINTER_STATUS_NOT_AVAILABLE) == 0 &&
                          (printer.Attributes & PRINTER_ATTRIBUTE_WORK_OFFLINE) == 0;
    out->push_back(std::move(info));
  }
  return Status::Ok();
}

Status ReadJobInfo(HANDLE handle,
                   const std::string& printer,
                   int job_id,
                   JobInfo* out,
                   bool* found) {
  *found = false;
  DWORD needed = 0;
  ::GetJobW(handle, static_cast<DWORD>(job_id), 2, nullptr, 0, &needed);
  if (needed == 0) {
    const DWORD error = GetLastError();
    // A finished job leaves the queue entirely, so "not found" is an ordinary
    // outcome rather than a failure.
    if (error == ERROR_INVALID_PARAMETER || error == ERROR_NOT_FOUND ||
        error == ERROR_FILE_NOT_FOUND) {
      return Status::Ok();
    }
    return Status::Error(code::kBackend,
                        "Could not read job " + std::to_string(job_id) + ": " +
                            win::FormatLastError(error),
                        static_cast<int>(error), win::FormatLastError(error));
  }

  std::vector<unsigned char> buffer(needed);
  if (::GetJobW(handle, static_cast<DWORD>(job_id), 2, buffer.data(), needed, &needed) == 0) {
    const DWORD error = GetLastError();
    if (error == ERROR_INVALID_PARAMETER || error == ERROR_NOT_FOUND) return Status::Ok();
    return Status::Error(code::kBackend,
                        "Could not read job " + std::to_string(job_id) + ": " +
                            win::FormatLastError(error),
                        static_cast<int>(error), win::FormatLastError(error));
  }

  const JOB_INFO_2W* job = reinterpret_cast<const JOB_INFO_2W*>(buffer.data());
  out->job_id = static_cast<int>(job->JobId);
  out->printer = job->pPrinterName != nullptr ? win::Narrow(job->pPrinterName) : printer;
  out->job_name = job->pDocument != nullptr ? win::Narrow(job->pDocument) : "";
  out->state = ToJobState(job->Status);
  out->raw_state = DescribeJobStatus(job->Status);
  if (job->TotalPages > 0) out->total_pages = static_cast<int>(job->TotalPages);
  out->pages_printed = static_cast<int>(job->PagesPrinted);
  out->size = static_cast<int64_t>(job->Size);
  const int64_t submitted = ToUnixSeconds(job->Submitted);
  if (submitted > 0) out->created_at = submitted;
  *found = true;
  return Status::Ok();
}

// Emits one pass of the selected pages onto an already-started document.
Status PrintPass(const pdfium::Library& pdfium,
                 const PrintRequest& request,
                 HDC dc,
                 const SheetMetrics& sheet,
                 FPDF_DOCUMENT document,
                 const std::vector<int>& pages,
                 int repeats_per_page) {
  for (int page_number : pages) {
    Page page(pdfium, document, page_number - 1);
    if (page.get() == nullptr) {
      return pdfium::LastErrorStatus(
          pdfium, "Could not load page " + std::to_string(page_number));
    }

    const double width_pt = pdfium.GetPageWidthF(page.get());
    const double height_pt = pdfium.GetPageHeightF(page.get());
    const Placement placement =
        ComputePlacement(width_pt, height_pt, sheet, request.scale, /*auto_rotate=*/true);

    for (int repeat = 0; repeat < repeats_per_page; ++repeat) {
      if (StartPage(dc) <= 0) {
        const DWORD error = GetLastError();
        return Status::Error(code::kBackend,
                            "The driver refused to start a page: " + win::FormatLastError(error),
                            static_cast<int>(error), win::FormatLastError(error));
      }
      // MM_TEXT makes one logical unit one device pixel, which is the space the
      // placement calculation works in.
      SetMapMode(dc, MM_TEXT);

      const Status status = win::RenderPage(pdfium, dc, page.get(), placement, sheet,
                                           request.windows.render_mode, request.windows.dpi);
      if (!status.ok()) {
        EndPage(dc);
        return status;
      }

      if (EndPage(dc) <= 0) {
        const DWORD error = GetLastError();
        return Status::Error(code::kBackend,
                            "The driver refused to finish a page: " + win::FormatLastError(error),
                            static_cast<int>(error), win::FormatLastError(error));
      }
    }
  }
  return Status::Ok();
}

}  // namespace

Status Describe(BackendInfo* out) {
  out->backend = "windows";

  // A missing PDFium is deliberately not an error here. Rendering needs it, but
  // talking to the spooler does not, so enumerating printers and reading job
  // status keep working -- which is exactly what someone diagnosing a broken
  // install wants to be able to do. Print() reports the problem when it matters,
  // and an empty pdfiumVersion is how a caller can tell.
  Status ignored;
  if (pdfium::Load(&ignored) != nullptr) out->pdfium_version = pdfium::Version();
  return Status::Ok();
}

Status ListPrinters(std::vector<PrinterInfo>* out) { return EnumeratePrinters(out); }

Status DefaultPrinter(std::string* out) {
  *out = DefaultPrinterName();
  return Status::Ok();
}

Status Print(const PrintRequest& request, PrintResult* out) {
  Status status;
  const pdfium::Library* pdfium = pdfium::Load(&status);
  if (pdfium == nullptr) return status;

  const std::wstring printer = win::Widen(request.printer);

  win::PrinterHandle printer_handle;
  PIN_RETURN_IF_ERROR(printer_handle.Open(printer));

  win::DevMode devmode;
  PIN_RETURN_IF_ERROR(devmode.Apply(printer_handle.get(), printer, request.windows,
                                    request.copies));

  Document document(*pdfium);
  PIN_RETURN_IF_ERROR(document.Open(request));

  const int page_count = pdfium->GetPageCount(document.get());
  if (page_count <= 0) {
    return Status::Error(code::kInvalidPdf, "The PDF reports no pages");
  }

  const std::vector<int> pages =
      ExpandPageSelection(request.ranges, request.subset, request.reverse, page_count);
  if (pages.empty()) {
    return Status::Error(code::kInvalidPdf,
                        "The page selection matched none of the document's " +
                            std::to_string(page_count) + " pages");
  }

  // FPDF_SetPrintMode is process-wide, so it is set inside the backend mutex
  // held by the worker rather than once at load time; two jobs wanting different
  // modes would otherwise race.
  if (request.windows.render_mode == RenderMode::kVector) {
    pdfium->SetPrintMode(request.windows.print_mode);
  }

  DeviceContext dc;
  dc.Reset(CreateDCW(L"WINSPOOL", printer.c_str(), nullptr, devmode.get()));
  if (dc.get() == nullptr) {
    const DWORD error = GetLastError();
    return Status::Error(code::kBackend,
                        "Could not create a device context for \"" + request.printer +
                            "\": " + win::FormatLastError(error),
                        static_cast<int>(error), win::FormatLastError(error));
  }

  const SheetMetrics sheet = win::ReadSheetMetrics(dc.get());

  // When the driver can produce copies itself we let it, because it is far
  // faster than re-rendering and it can use the device's own collating hardware.
  // Otherwise the render loop repeats: the whole document per copy when
  // collating, each page in turn when not.
  const bool driver_handles_copies =
      DeviceCapabilitiesW(printer.c_str(), nullptr, DC_COPIES, nullptr, devmode.get()) > 1;
  int document_passes = 1;
  int repeats_per_page = 1;
  if (!driver_handles_copies && request.copies > 1) {
    if (request.collate) {
      document_passes = request.copies;
    } else {
      repeats_per_page = request.copies;
    }
  }

  const std::wstring job_name = win::Widen(request.job_name);
  const std::wstring output_file = win::Widen(request.windows.output_file);

  DOCINFOW doc_info{};
  doc_info.cbSize = sizeof(doc_info);
  doc_info.lpszDocName = job_name.empty() ? L"print-it-now" : job_name.c_str();
  // A file-backed driver such as "Microsoft Print to PDF" raises a save dialog
  // unless it is told where to write, which would hang a headless process.
  doc_info.lpszOutput = output_file.empty() ? nullptr : output_file.c_str();

  DocumentScope document_scope(dc.get());
  const int job_id = StartDocW(dc.get(), &doc_info);
  if (job_id <= 0) {
    const DWORD error = GetLastError();
    if (error == ERROR_CANCELLED) {
      return Status::Error(code::kBackend,
                          "The print job was cancelled before it started. A driver that "
                          "writes to a file needs windows.outputFile set, or it will wait "
                          "for a save dialog that a headless process never answers",
                          static_cast<int>(error), win::FormatLastError(error));
    }
    return Status::Error(code::kBackend,
                        "Could not start the print job: " + win::FormatLastError(error),
                        static_cast<int>(error), win::FormatLastError(error));
  }
  document_scope.MarkOpen();

  for (int pass = 0; pass < document_passes; ++pass) {
    PIN_RETURN_IF_ERROR(PrintPass(*pdfium, request, dc.get(), sheet, document.get(), pages,
                                  repeats_per_page));
  }

  document_scope.Commit();

  out->job_id = job_id;
  out->printer = request.printer;
  out->job_name = request.job_name;
  out->page_count = static_cast<int>(pages.size()) * document_passes * repeats_per_page;
  return Status::Ok();
}

Status QueryJob(const std::string& printer, int job_id, JobInfo* out, bool* found) {
  win::PrinterHandle handle;
  PIN_RETURN_IF_ERROR(handle.Open(win::Widen(printer)));
  return ReadJobInfo(handle.get(), printer, job_id, out, found);
}

Status CancelJob(const std::string& printer, int job_id) {
  win::PrinterHandle handle;
  PIN_RETURN_IF_ERROR(handle.Open(win::Widen(printer)));

  if (SetJobW(handle.get(), static_cast<DWORD>(job_id), 0, nullptr, JOB_CONTROL_DELETE) != 0) {
    return Status::Ok();
  }

  const DWORD error = GetLastError();
  if (error == ERROR_INVALID_PARAMETER || error == ERROR_NOT_FOUND ||
      error == ERROR_FILE_NOT_FOUND) {
    return Status::Error(code::kJobNotFound,
                        "Job " + std::to_string(job_id) + " was not found on printer \"" +
                            printer + "\"",
                        static_cast<int>(error), win::FormatLastError(error));
  }
  return Status::Error(code::kBackend,
                      "Could not cancel job " + std::to_string(job_id) + ": " +
                          win::FormatLastError(error),
                      static_cast<int>(error), win::FormatLastError(error));
}

}  // namespace backend
}  // namespace pin
