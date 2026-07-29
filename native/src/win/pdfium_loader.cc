#include "pdfium_loader.h"

#include <windows.h>

#include <cstdio>
#include <string>
#include <vector>

#include "win_util.h"

namespace pin {
namespace pdfium {
namespace {

struct Loaded {
  HMODULE handle = nullptr;
  Library library{};
  std::string path;
  std::string version;
  std::string error;
  bool ok = false;
};

// Anchors GetModuleHandleEx to this DLL so we can find the directory the addon
// was loaded from.
void AddressAnchor() {}

std::wstring ModuleDirectory() {
  HMODULE self = nullptr;
  if (GetModuleHandleExW(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS |
                             GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
                         reinterpret_cast<LPCWSTR>(&AddressAnchor), &self) == 0) {
    return {};
  }

  std::vector<wchar_t> buffer(MAX_PATH);
  while (true) {
    const DWORD length =
        GetModuleFileNameW(self, buffer.data(), static_cast<DWORD>(buffer.size()));
    if (length == 0) return {};
    if (length < buffer.size() - 1) {
      std::wstring path(buffer.data(), length);
      const size_t slash = path.find_last_of(L"\\/");
      return slash == std::wstring::npos ? std::wstring() : path.substr(0, slash);
    }
    buffer.resize(buffer.size() * 2);
  }
}

std::vector<std::wstring> CandidatePaths() {
  std::vector<std::wstring> candidates;

  std::vector<wchar_t> override_buffer(MAX_PATH);
  const DWORD override_length = GetEnvironmentVariableW(
      L"PRINT_IT_NOW_PDFIUM_PATH", override_buffer.data(),
      static_cast<DWORD>(override_buffer.size()));
  if (override_length > 0 && override_length < override_buffer.size()) {
    candidates.emplace_back(override_buffer.data(), override_length);
  }

  const std::wstring directory = ModuleDirectory();
  if (!directory.empty()) {
    candidates.push_back(directory + L"\\pdfium.dll");
    // node-gyp puts the freshly built addon in build/Release while the staged
    // DLL sits in prebuilds/<target>, so a from-source build finds it one level
    // up as well.
    candidates.push_back(directory + L"\\..\\pdfium.dll");
  }

  // Last resort: the standard search order, so an application that has already
  // deployed pdfium.dll of its own still works.
  candidates.emplace_back(L"pdfium.dll");
  return candidates;
}

// GetProcAddress hands back a FARPROC, and casting that to the real signature is
// the only way to use it. The detour through void* is what stops compilers
// warning about the (unavoidable) mismatch.
template <typename Fn>
bool Resolve(HMODULE handle, const char* name, Fn* out) {
  FARPROC symbol = GetProcAddress(handle, name);
  if (symbol == nullptr) return false;
  *out = reinterpret_cast<Fn>(reinterpret_cast<void*>(symbol));
  return true;
}

bool ResolveAll(HMODULE handle, Library* library, std::string* missing) {
  struct Binding {
    const char* name;
    bool (*resolve)(HMODULE, Library*);
  };

#define PIN_BIND(field, symbol)                                              \
  Binding {                                                                  \
    symbol, [](HMODULE h, Library* l) { return Resolve(h, symbol, &l->field); } \
  }

  const Binding bindings[] = {
      PIN_BIND(InitLibraryWithConfig, "FPDF_InitLibraryWithConfig"),
      PIN_BIND(DestroyLibrary, "FPDF_DestroyLibrary"),
      PIN_BIND(SetPrintMode, "FPDF_SetPrintMode"),
      PIN_BIND(GetLastError, "FPDF_GetLastError"),
      PIN_BIND(LoadDocument, "FPDF_LoadDocument"),
      PIN_BIND(LoadMemDocument64, "FPDF_LoadMemDocument64"),
      PIN_BIND(CloseDocument, "FPDF_CloseDocument"),
      PIN_BIND(GetPageCount, "FPDF_GetPageCount"),
      PIN_BIND(GetPageSizeByIndexF, "FPDF_GetPageSizeByIndexF"),
      PIN_BIND(LoadPage, "FPDF_LoadPage"),
      PIN_BIND(ClosePage, "FPDF_ClosePage"),
      PIN_BIND(GetPageWidthF, "FPDF_GetPageWidthF"),
      PIN_BIND(GetPageHeightF, "FPDF_GetPageHeightF"),
      PIN_BIND(RenderPage, "FPDF_RenderPage"),
      PIN_BIND(RenderPageBitmap, "FPDF_RenderPageBitmap"),
      PIN_BIND(BitmapCreateEx, "FPDFBitmap_CreateEx"),
      PIN_BIND(BitmapFillRect, "FPDFBitmap_FillRect"),
      PIN_BIND(BitmapDestroy, "FPDFBitmap_Destroy"),
  };

#undef PIN_BIND

  for (const Binding& binding : bindings) {
    if (!binding.resolve(handle, library)) {
      *missing = binding.name;
      return false;
    }
  }
  return true;
}

// fetch-pdfium.mjs writes this next to the DLL. Reading it beats linking
// version.lib just to report a version string in diagnostics.
std::string ReadVersionFile(const std::wstring& dll_path) {
  const size_t slash = dll_path.find_last_of(L"\\/");
  if (slash == std::wstring::npos) return {};
  const std::wstring version_path = dll_path.substr(0, slash) + L"\\pdfium-version.txt";

  std::FILE* file = nullptr;
  if (_wfopen_s(&file, version_path.c_str(), L"rb") != 0 || file == nullptr) return {};
  char buffer[256] = {};
  const size_t read = std::fread(buffer, 1, sizeof(buffer) - 1, file);
  std::fclose(file);

  std::string version(buffer, read);
  while (!version.empty() && (version.back() == '\n' || version.back() == '\r')) {
    version.pop_back();
  }
  return version;
}

const Loaded& LoadOnce() {
  static Loaded loaded = [] {
    Loaded result;
    std::string errors;

    for (const std::wstring& candidate : CandidatePaths()) {
      // LOAD_WITH_ALTERED_SEARCH_PATH makes the DLL's own directory the first
      // place its dependencies are looked for, which is what we want for a
      // privately deployed pdfium.dll.
      HMODULE handle = LoadLibraryExW(candidate.c_str(), nullptr,
                                      LOAD_WITH_ALTERED_SEARCH_PATH);
      if (handle == nullptr) {
        if (!errors.empty()) errors += "; ";
        errors += win::Narrow(candidate) + ": " + win::FormatLastError(GetLastError());
        continue;
      }

      Library library{};
      std::string missing;
      if (!ResolveAll(handle, &library, &missing)) {
        FreeLibrary(handle);
        if (!errors.empty()) errors += "; ";
        errors += win::Narrow(candidate) + ": missing export " + missing;
        continue;
      }

      FPDF_LIBRARY_CONFIG config{};
      config.version = 2;
      config.m_pUserFontPaths = nullptr;
      config.m_pIsolate = nullptr;
      config.m_v8EmbedderSlot = 0;
      library.InitLibraryWithConfig(&config);

      result.handle = handle;
      result.library = library;
      result.path = win::Narrow(candidate);
      result.version = ReadVersionFile(candidate);
      result.ok = true;
      return result;
    }

    result.error = errors;
    return result;
  }();
  return loaded;
}

}  // namespace

const Library* Load(Status* status) {
  const Loaded& loaded = LoadOnce();
  if (loaded.ok) return &loaded.library;

  *status = Status::Error(
      code::kBackendUnavailable,
      "pdfium.dll could not be loaded, so PDF printing is unavailable. It normally "
      "ships alongside the compiled addon; run `node scripts/fetch-pdfium.mjs` to "
      "stage it, or set PRINT_IT_NOW_PDFIUM_PATH to its full path. Tried: " +
          (loaded.error.empty() ? std::string("no candidates") : loaded.error));
  return nullptr;
}

const std::string& Version() { return LoadOnce().version; }

const std::string& LoadedPath() { return LoadOnce().path; }

Status LastErrorStatus(const Library& library, const std::string& context) {
  const unsigned long error = library.GetLastError();
  const char* detail;
  switch (error) {
    case FPDF_ERR_SUCCESS: detail = "no error reported"; break;
    case FPDF_ERR_FILE: detail = "the file could not be opened"; break;
    case FPDF_ERR_FORMAT: detail = "the file is not a PDF, or is corrupt"; break;
    case FPDF_ERR_PASSWORD: detail = "the document is password protected"; break;
    case FPDF_ERR_SECURITY: detail = "the document uses an unsupported security scheme"; break;
    case FPDF_ERR_PAGE: detail = "a page could not be loaded"; break;
    default: detail = "unknown PDFium error"; break;
  }
  return Status::Error(code::kInvalidPdf, context + ": " + detail,
                       static_cast<int>(error), detail);
}

}  // namespace pdfium
}  // namespace pin
