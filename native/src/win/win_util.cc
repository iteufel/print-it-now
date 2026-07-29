#include "win_util.h"

#include <string>
#include <vector>

namespace pin {
namespace win {

std::wstring Widen(const std::string& utf8) {
  if (utf8.empty()) return {};
  const int length = MultiByteToWideChar(CP_UTF8, 0, utf8.data(),
                                         static_cast<int>(utf8.size()), nullptr, 0);
  if (length <= 0) return {};
  std::wstring result(static_cast<size_t>(length), L'\0');
  MultiByteToWideChar(CP_UTF8, 0, utf8.data(), static_cast<int>(utf8.size()), result.data(),
                      length);
  return result;
}

std::string Narrow(const std::wstring& utf16) {
  if (utf16.empty()) return {};
  const int length = WideCharToMultiByte(CP_UTF8, 0, utf16.data(),
                                          static_cast<int>(utf16.size()), nullptr, 0, nullptr,
                                          nullptr);
  if (length <= 0) return {};
  std::string result(static_cast<size_t>(length), '\0');
  WideCharToMultiByte(CP_UTF8, 0, utf16.data(), static_cast<int>(utf16.size()), result.data(),
                      length, nullptr, nullptr);
  return result;
}

std::string FormatLastError(DWORD error) {
  LPWSTR buffer = nullptr;
  const DWORD length = FormatMessageW(
      FORMAT_MESSAGE_ALLOCATE_BUFFER | FORMAT_MESSAGE_FROM_SYSTEM |
          FORMAT_MESSAGE_IGNORE_INSERTS,
      nullptr, error, MAKELANGID(LANG_NEUTRAL, SUBLANG_DEFAULT),
      reinterpret_cast<LPWSTR>(&buffer), 0, nullptr);

  std::string message;
  if (length > 0 && buffer != nullptr) {
    std::wstring wide(buffer, length);
    while (!wide.empty() && (wide.back() == L'\n' || wide.back() == L'\r' || wide.back() == L'.')) {
      wide.pop_back();
    }
    message = Narrow(wide);
  }
  if (buffer != nullptr) LocalFree(buffer);
  if (message.empty()) message = "unknown Windows error";
  return message + " (code " + std::to_string(error) + ")";
}

}  // namespace win
}  // namespace pin
