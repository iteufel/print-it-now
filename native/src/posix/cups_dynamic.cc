#include "cups_dynamic.h"

#include <dlfcn.h>

#include <cstdlib>
#include <mutex>
#include <string>
#include <vector>

namespace pin {
namespace cups {
namespace {

struct Loaded {
  void* handle = nullptr;
  Library library{};
  std::string path;
  std::string error;
  bool ok = false;
};

std::vector<std::string> CandidatePaths() {
  std::vector<std::string> candidates;
  if (const char* override_path = std::getenv("PRINT_IT_NOW_CUPS_LIBRARY")) {
    if (*override_path != '\0') candidates.emplace_back(override_path);
  }
#if defined(__APPLE__)
  candidates.emplace_back("libcups.2.dylib");
  candidates.emplace_back("/usr/lib/libcups.2.dylib");
#else
  candidates.emplace_back("libcups.so.2");
  // Some distributions ship only the development symlink; try it last so a
  // libcups3 installation that provides libcups.so cannot shadow a real
  // libcups.so.2 sitting next to it.
  candidates.emplace_back("libcups.so");
#endif
  return candidates;
}

// dlsym returns void*, which is not convertible to a function pointer in
// standard C++; POSIX guarantees the reinterpret_cast is well defined here.
template <typename Fn>
bool Resolve(void* handle, const char* name, Fn* out) {
  void* symbol = dlsym(handle, name);
  if (symbol == nullptr) return false;
  *out = reinterpret_cast<Fn>(symbol);
  return true;
}

bool ResolveAll(void* handle, Library* library, std::string* missing) {
  struct Binding {
    const char* name;
    bool (*resolve)(void*, Library*);
  };

#define PIN_BIND(field, symbol)                                     \
  Binding {                                                         \
    symbol, [](void* h, Library* l) {                               \
      return Resolve(h, symbol, &l->field);                         \
    }                                                               \
  }

  const Binding bindings[] = {
      PIN_BIND(GetDests2, "cupsGetDests2"),
      PIN_BIND(GetNamedDest, "cupsGetNamedDest"),
      PIN_BIND(FreeDests, "cupsFreeDests"),
      PIN_BIND(GetOption, "cupsGetOption"),
      PIN_BIND(AddOption, "cupsAddOption"),
      PIN_BIND(FreeOptions, "cupsFreeOptions"),
      PIN_BIND(CreateJob, "cupsCreateJob"),
      PIN_BIND(StartDocument, "cupsStartDocument"),
      PIN_BIND(WriteRequestData, "cupsWriteRequestData"),
      PIN_BIND(FinishDocument, "cupsFinishDocument"),
      PIN_BIND(GetJobs2, "cupsGetJobs2"),
      PIN_BIND(FreeJobs, "cupsFreeJobs"),
      PIN_BIND(CancelJob2, "cupsCancelJob2"),
      PIN_BIND(LastError, "cupsLastError"),
      PIN_BIND(LastErrorString, "cupsLastErrorString"),
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

const Loaded& LoadOnce() {
  static Loaded loaded = [] {
    Loaded result;
    std::string errors;

    for (const std::string& candidate : CandidatePaths()) {
      void* handle = dlopen(candidate.c_str(), RTLD_LAZY | RTLD_LOCAL);
      if (handle == nullptr) {
        const char* message = dlerror();
        if (!errors.empty()) errors += "; ";
        errors += message != nullptr ? message : candidate + ": cannot open";
        continue;
      }

      Library library{};
      std::string missing;
      if (!ResolveAll(handle, &library, &missing)) {
        dlclose(handle);
        if (!errors.empty()) errors += "; ";
        errors += candidate + ": missing symbol " + missing;
        continue;
      }

      result.handle = handle;
      result.library = library;
      result.path = candidate;
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
      "The CUPS client library could not be loaded, so printing is unavailable. "
      "Install CUPS (Debian/Ubuntu: libcups2; Fedora: cups-libs; Alpine: cups-libs) "
      "or set PRINT_IT_NOW_CUPS_LIBRARY to its full path. Tried: " +
          (loaded.error.empty() ? std::string("no candidates") : loaded.error));
  return nullptr;
}

const std::string& LoadedPath() { return LoadOnce().path; }

Status LastErrorStatus(const Library& library, const std::string& context) {
  const int ipp_status = library.LastError();
  const char* detail = library.LastErrorString();
  const std::string native_message = detail != nullptr ? detail : "";

  const char* code = code::kBackend;
  if (ipp_status == kStatusErrorNotFound) {
    code = code::kPrinterNotFound;
  } else if (ipp_status == kStatusErrorDocumentFormatNotSupported) {
    code = code::kInvalidPdf;
  }

  std::string message = context;
  if (!native_message.empty()) message += ": " + native_message;
  return Status::Error(code, std::move(message), ipp_status, native_message);
}

}  // namespace cups
}  // namespace pin
