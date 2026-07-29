#include "devmode.h"

#include <winspool.h>

#include <algorithm>
#include <limits>

#include "win_util.h"

namespace pin {
namespace win {
namespace {

// Copies a field into the DEVMODE and records it in dmFields, which is what
// tells the driver the value is meaningful rather than leftover.
void SetField(DEVMODEW* devmode, short* target, DWORD flag, const std::optional<int16_t>& value) {
  if (!value.has_value()) return;
  *target = *value;
  devmode->dmFields |= flag;
}

}  // namespace

Status PrinterHandle::Open(const std::wstring& printer) {
  Close();

  // PRINTER_ACCESS_USE is enough to submit jobs and read the driver's defaults.
  // Asking for PRINTER_ALL_ACCESS would fail for non-administrators on queues
  // they are perfectly entitled to print to.
  PRINTER_DEFAULTSW defaults{};
  defaults.DesiredAccess = PRINTER_ACCESS_USE;

  if (OpenPrinterW(const_cast<LPWSTR>(printer.c_str()), &handle_, &defaults) != 0) {
    return Status::Ok();
  }

  const DWORD error = GetLastError();
  const std::string printer_utf8 = Narrow(printer);
  switch (error) {
    case ERROR_INVALID_PRINTER_NAME:
    case ERROR_INVALID_NAME:
    case ERROR_FILE_NOT_FOUND:
    case ERROR_UNKNOWN_PRINTER_DRIVER:
      return Status::Error(code::kPrinterNotFound,
                          "Printer \"" + printer_utf8 + "\" was not found", static_cast<int>(error),
                          FormatLastError(error));
    case RPC_S_SERVER_UNAVAILABLE:
    case RPC_S_CALL_FAILED:
    case ERROR_NOT_READY:
      return Status::Error(code::kBackendUnavailable,
                          "The Windows print spooler is not reachable. Check that the "
                          "\"Print Spooler\" service is running",
                          static_cast<int>(error), FormatLastError(error));
    default:
      return Status::Error(code::kBackend,
                          "Could not open printer \"" + printer_utf8 + "\": " +
                              FormatLastError(error),
                          static_cast<int>(error), FormatLastError(error));
  }
}

void PrinterHandle::Close() {
  if (handle_ != nullptr) {
    ClosePrinter(handle_);
    handle_ = nullptr;
  }
}

Status DevMode::LoadDefaults(HANDLE printer_handle, const std::wstring& printer) {
  LPWSTR name = const_cast<LPWSTR>(printer.c_str());
  const LONG size = DocumentPropertiesW(nullptr, printer_handle, name, nullptr, nullptr, 0);
  if (size <= 0) {
    const DWORD error = GetLastError();
    return Status::Error(code::kBackend,
                        "The driver for \"" + Narrow(printer) +
                            "\" did not report its settings size: " + FormatLastError(error),
                        static_cast<int>(error), FormatLastError(error));
  }

  buffer_.assign(static_cast<size_t>(size), 0);
  DEVMODEW* devmode = reinterpret_cast<DEVMODEW*>(buffer_.data());
  if (DocumentPropertiesW(nullptr, printer_handle, name, devmode, nullptr, DM_OUT_BUFFER) !=
      IDOK) {
    const DWORD error = GetLastError();
    buffer_.clear();
    return Status::Error(code::kBackend,
                        "Could not read the current settings for \"" + Narrow(printer) +
                            "\": " + FormatLastError(error),
                        static_cast<int>(error), FormatLastError(error));
  }
  return Status::Ok();
}

Status DevMode::Apply(HANDLE printer_handle,
                      const std::wstring& printer,
                      const WindowsSettings& settings,
                      int copies) {
  PIN_RETURN_IF_ERROR(LoadDefaults(printer_handle, printer));

  DEVMODEW* devmode = get();
  if (devmode == nullptr) {
    return Status::Error(code::kBackend, "The driver returned no settings structure");
  }

  SetField(devmode, &devmode->dmOrientation, DM_ORIENTATION, settings.orientation);
  SetField(devmode, &devmode->dmPaperSize, DM_PAPERSIZE, settings.paper_size);
  SetField(devmode, &devmode->dmPaperWidth, DM_PAPERWIDTH, settings.paper_width);
  SetField(devmode, &devmode->dmPaperLength, DM_PAPERLENGTH, settings.paper_length);
  SetField(devmode, &devmode->dmDuplex, DM_DUPLEX, settings.duplex);
  SetField(devmode, &devmode->dmColor, DM_COLOR, settings.color);
  SetField(devmode, &devmode->dmPrintQuality, DM_PRINTQUALITY, settings.quality);
  SetField(devmode, &devmode->dmDefaultSource, DM_DEFAULTSOURCE, settings.bin);
  SetField(devmode, &devmode->dmCollate, DM_COLLATE, settings.collate);

  // dmCopies is a short. A caller asking for more copies than that gets the
  // remainder from the render loop, which repeats the document itself.
  if (copies > 1) {
    devmode->dmCopies =
        static_cast<short>(std::min<int>(copies, std::numeric_limits<short>::max()));
    devmode->dmFields |= DM_COPIES;
  }

  // Round-tripping through the driver turns our request into something the
  // device can actually do: an unsupported paper size falls back, duplex is
  // dropped on a simplex device, and driver-private bytes stay consistent with
  // the public fields.
  std::vector<unsigned char> merged(buffer_.size(), 0);
  DEVMODEW* out = reinterpret_cast<DEVMODEW*>(merged.data());
  LPWSTR name = const_cast<LPWSTR>(printer.c_str());
  if (DocumentPropertiesW(nullptr, printer_handle, name, out, devmode,
                          DM_IN_BUFFER | DM_OUT_BUFFER) != IDOK) {
    const DWORD error = GetLastError();
    return Status::Error(code::kBackend,
                        "The driver for \"" + Narrow(printer) +
                            "\" rejected the requested settings: " + FormatLastError(error),
                        static_cast<int>(error), FormatLastError(error));
  }
  buffer_.swap(merged);
  return Status::Ok();
}

}  // namespace win
}  // namespace pin
