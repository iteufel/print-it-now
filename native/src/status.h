#pragma once

#include <string>
#include <utility>

namespace pin {

// Error discriminators shared with src/errors.ts. The JS layer maps these onto
// its public error classes, so the spelling must stay in sync.
namespace code {
inline constexpr const char* kBackend = "EBACKEND";
inline constexpr const char* kBackendUnavailable = "EBACKENDUNAVAILABLE";
inline constexpr const char* kInvalidPdf = "EINVALIDPDF";
inline constexpr const char* kJobNotFound = "EJOBNOTFOUND";
inline constexpr const char* kNoPrinter = "ENOPRINTER";
inline constexpr const char* kPrinterNotFound = "EPRINTERNOTFOUND";
}  // namespace code

// Backends report failure by value rather than by throwing. Keeping our own
// code exception-free means the addon behaves identically whether or not the
// toolchain has C++ exceptions enabled, and it keeps AsyncWorker::Execute --
// which runs off the JS thread and must never let an exception escape -- honest
// by construction.
class Status {
 public:
  Status() = default;

  static Status Ok() { return Status(); }

  static Status Error(const char* code, std::string message) {
    Status s;
    s.ok_ = false;
    s.code_ = code;
    s.message_ = std::move(message);
    return s;
  }

  // `native_code` carries the platform's own error number: a Win32
  // GetLastError() value, or an IPP/CUPS status.
  static Status Error(const char* code,
                      std::string message,
                      int native_code,
                      std::string native_message = {}) {
    Status s = Error(code, std::move(message));
    s.native_code_ = native_code;
    s.has_native_code_ = true;
    s.native_message_ = std::move(native_message);
    return s;
  }

  bool ok() const { return ok_; }
  const char* code() const { return code_; }
  const std::string& message() const { return message_; }
  bool has_native_code() const { return has_native_code_; }
  int native_code() const { return native_code_; }
  const std::string& native_message() const { return native_message_; }

 private:
  bool ok_ = true;
  const char* code_ = code::kBackend;
  std::string message_;
  bool has_native_code_ = false;
  int native_code_ = 0;
  std::string native_message_;
};

#define PIN_RETURN_IF_ERROR(expr)          \
  do {                                     \
    ::pin::Status _pin_status = (expr);     \
    if (!_pin_status.ok()) return _pin_status; \
  } while (0)

}  // namespace pin
