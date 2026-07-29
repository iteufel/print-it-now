#pragma once

#include <windows.h>

#include <string>
#include <vector>

#include "backend.h"
#include "status.h"

namespace pin {
namespace win {

// RAII wrapper around OpenPrinterW.
class PrinterHandle {
 public:
  PrinterHandle() = default;
  ~PrinterHandle() { Close(); }

  PrinterHandle(const PrinterHandle&) = delete;
  PrinterHandle& operator=(const PrinterHandle&) = delete;

  // Maps a failure to open onto EPRINTERNOTFOUND when the spooler says the name
  // is unknown, and onto EBACKENDUNAVAILABLE when the spooler itself is down --
  // two very different things for a caller to act on.
  Status Open(const std::wstring& printer);
  void Close();

  HANDLE get() const { return handle_; }

 private:
  HANDLE handle_ = nullptr;
};

// Owns a DEVMODEW together with the driver-private bytes that follow it. The
// private area is what carries driver-specific settings such as stapling or
// watermarking, so it has to be round-tripped rather than rebuilt.
class DevMode {
 public:
  // Fetches the driver's current defaults for `printer`.
  Status LoadDefaults(HANDLE printer_handle, const std::wstring& printer);

  // Applies the caller's overrides and lets the driver normalise the result,
  // which is what resolves conflicts such as duplex on a simplex-only device.
  Status Apply(HANDLE printer_handle,
               const std::wstring& printer,
               const WindowsSettings& settings,
               int copies);

  DEVMODEW* get() { return buffer_.empty() ? nullptr : reinterpret_cast<DEVMODEW*>(buffer_.data()); }
  const DEVMODEW* get() const {
    return buffer_.empty() ? nullptr : reinterpret_cast<const DEVMODEW*>(buffer_.data());
  }

 private:
  std::vector<unsigned char> buffer_;
};

}  // namespace win
}  // namespace pin
