#pragma once

#include <windows.h>

#include <string>

namespace pin {
namespace win {

// UTF-8 <-> UTF-16 conversion. Printer names, job titles and file paths all
// routinely contain non-ASCII characters, and the ...A variants of the Win32
// print APIs would mangle them, so the backend uses the wide APIs throughout.
std::wstring Widen(const std::string& utf8);
std::string Narrow(const std::wstring& utf16);

// Renders a Win32 error code as "message (code N)".
std::string FormatLastError(DWORD error);

}  // namespace win
}  // namespace pin
