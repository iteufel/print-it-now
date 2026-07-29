#pragma once

#include <cstddef>
#include <ctime>
#include <string>

#include "status.h"

// Minimal, self-contained bindings for the CUPS 2.x client library.
//
// The declarations below are transcribed from cups/cups.h and cups/ipp.h rather
// than included from them, for two reasons. First, the library is resolved with
// dlopen at runtime, so the addon loads and reports a clean error on a machine
// with no CUPS at all instead of failing to load. Second, it means building
// from source needs no libcups development package on any platform, which
// matters because the only thing standing between a user on an unsupported
// architecture and a working install is `node-gyp rebuild`.
//
// The types and constants used here have been ABI-stable since CUPS 1.2 (2006).
// libcups3 changed both the soname and the API; we deliberately load
// libcups.so.2 / libcups.2.dylib by exact soname so that a CUPS 3 installation
// can never be mistaken for one we know how to talk to.
namespace pin {
namespace cups {

// Opaque; only ever handled as a pointer, and we always pass the NULL default
// connection so the library manages the connection for us.
struct Http;

struct Option {
  char* name;
  char* value;
};

struct Dest {
  char* name;
  char* instance;
  int is_default;
  int num_options;
  Option* options;
};

struct Job {
  int id;
  char* dest;
  char* title;
  char* user;
  char* format;
  int state;  // ipp_jstate_t
  int size;
  int priority;
  std::time_t completed_time;
  std::time_t creation_time;
  std::time_t processing_time;
};

inline constexpr const char* kFormatPdf = "application/pdf";

// ipp_jstate_t
inline constexpr int kJobPending = 3;
inline constexpr int kJobHeld = 4;
inline constexpr int kJobProcessing = 5;
inline constexpr int kJobStopped = 6;
inline constexpr int kJobCanceled = 7;
inline constexpr int kJobAborted = 8;
inline constexpr int kJobCompleted = 9;

// ipp_status_t
inline constexpr int kStatusOk = 0x0000;
inline constexpr int kStatusErrorNotPossible = 0x0404;
inline constexpr int kStatusErrorNotFound = 0x0406;
inline constexpr int kStatusErrorDocumentFormatNotSupported = 0x040A;

// http_status_t
inline constexpr int kHttpContinue = 100;

// cupsGetJobs2 `whichjobs`
inline constexpr int kWhichJobsAll = -1;

// printer-state attribute values
inline constexpr int kPrinterIdle = 3;
inline constexpr int kPrinterProcessing = 4;
inline constexpr int kPrinterStopped = 5;

struct Library {
  int (*GetDests2)(Http* http, Dest** dests);
  Dest* (*GetNamedDest)(Http* http, const char* name, const char* instance);
  void (*FreeDests)(int num_dests, Dest* dests);
  const char* (*GetOption)(const char* name, int num_options, Option* options);
  int (*AddOption)(const char* name, const char* value, int num_options, Option** options);
  void (*FreeOptions)(int num_options, Option* options);
  int (*CreateJob)(Http* http,
                   const char* name,
                   const char* title,
                   int num_options,
                   Option* options);
  int (*StartDocument)(Http* http,
                       const char* name,
                       int job_id,
                       const char* docname,
                       const char* format,
                       int last_document);
  int (*WriteRequestData)(Http* http, const char* buffer, std::size_t length);
  int (*FinishDocument)(Http* http, const char* name);
  int (*GetJobs2)(Http* http, Job** jobs, const char* name, int myjobs, int whichjobs);
  void (*FreeJobs)(int num_jobs, Job* jobs);
  int (*CancelJob2)(Http* http, const char* name, int job_id, int purge);
  int (*LastError)();
  const char* (*LastErrorString)();
};

// Resolves the library once per process. Returns nullptr and fills `status` with
// an EBACKENDUNAVAILABLE error when no usable CUPS library is present, which is
// the normal situation inside a minimal container.
const Library* Load(Status* status);

// Path of the library that was loaded, or the empty string if loading failed.
const std::string& LoadedPath();

// Turns the library's own error state into a Status, mapping the IPP statuses
// that have a more specific meaning to the caller onto dedicated codes.
Status LastErrorStatus(const Library& library, const std::string& context);

}  // namespace cups
}  // namespace pin
