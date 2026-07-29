#pragma once

#include <napi.h>

#include <string>
#include <vector>

#include "backend.h"
#include "status.h"

namespace pin {

// Reads a print request out of the plain object built by src/options.ts.
// `keep_alive` is given a reference to the caller's Buffer so the bytes stay
// valid for as long as the worker runs; `request.data` points straight into it,
// which is what keeps in-memory printing copy-free.
Status ReadPrintRequest(const Napi::Object& source,
                        PrintRequest* request,
                        Napi::Reference<Napi::Value>* keep_alive);

Napi::Value ToJs(Napi::Env env, const PrintResult& result);
Napi::Value ToJs(Napi::Env env, const PrinterInfo& printer);
Napi::Value ToJs(Napi::Env env, const std::vector<PrinterInfo>& printers);
Napi::Value ToJs(Napi::Env env, const JobInfo& job);
Napi::Value ToJs(Napi::Env env, const std::vector<JobInfo>& jobs);
Napi::Value ToJs(Napi::Env env, const BackendInfo& info);

// Builds the Error object the JS layer expects: a `code` discriminator plus the
// platform's own error number and message when there is one.
Napi::Error ToJsError(Napi::Env env, const Status& status);

const char* PrinterStateName(PrinterState state);
const char* JobStateName(JobState state);

}  // namespace pin
