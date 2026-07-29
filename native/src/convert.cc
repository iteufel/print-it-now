#include "convert.h"

#include <cstdint>
#include <limits>

namespace pin {
namespace {

Status MissingField(const char* field) {
  return Status::Error(code::kBackend,
                       std::string("Internal error: request field \"") + field +
                           "\" is missing or has the wrong type");
}

Status ReadString(const Napi::Object& source, const char* field, std::string* out) {
  Napi::Value value = source.Get(field);
  if (!value.IsString()) return MissingField(field);
  *out = value.As<Napi::String>().Utf8Value();
  return Status::Ok();
}

Status ReadOptionalString(const Napi::Object& source, const char* field, std::string* out) {
  Napi::Value value = source.Get(field);
  if (value.IsUndefined() || value.IsNull()) return Status::Ok();
  if (!value.IsString()) return MissingField(field);
  *out = value.As<Napi::String>().Utf8Value();
  return Status::Ok();
}

Status ReadInt(const Napi::Object& source, const char* field, int* out) {
  Napi::Value value = source.Get(field);
  if (!value.IsNumber()) return MissingField(field);
  *out = value.As<Napi::Number>().Int32Value();
  return Status::Ok();
}

Status ReadBool(const Napi::Object& source, const char* field, bool* out) {
  Napi::Value value = source.Get(field);
  if (!value.IsBoolean()) return MissingField(field);
  *out = value.As<Napi::Boolean>().Value();
  return Status::Ok();
}

Status ReadOptionalInt16(const Napi::Object& source,
                         const char* field,
                         std::optional<int16_t>* out) {
  Napi::Value value = source.Get(field);
  if (value.IsUndefined() || value.IsNull()) return Status::Ok();
  if (!value.IsNumber()) return MissingField(field);
  const int32_t raw = value.As<Napi::Number>().Int32Value();
  if (raw < std::numeric_limits<int16_t>::min() || raw > std::numeric_limits<int16_t>::max()) {
    return Status::Error(code::kBackend,
                         std::string("Internal error: request field \"") + field +
                             "\" does not fit in the 16-bit DEVMODE field it maps to");
  }
  *out = static_cast<int16_t>(raw);
  return Status::Ok();
}

Status ReadRanges(const Napi::Object& source, std::vector<PageRange>* out) {
  Napi::Value value = source.Get("ranges");
  if (value.IsUndefined() || value.IsNull()) return Status::Ok();
  if (!value.IsArray()) return MissingField("ranges");

  Napi::Array array = value.As<Napi::Array>();
  const uint32_t length = array.Length();
  out->reserve(length);
  for (uint32_t i = 0; i < length; ++i) {
    Napi::Value entry = array.Get(i);
    if (!entry.IsObject()) return MissingField("ranges[]");
    Napi::Object range = entry.As<Napi::Object>();
    PageRange parsed;
    PIN_RETURN_IF_ERROR(ReadInt(range, "from", &parsed.from));
    PIN_RETURN_IF_ERROR(ReadInt(range, "to", &parsed.to));
    out->push_back(parsed);
  }
  return Status::Ok();
}

Status ReadIpp(const Napi::Object& source,
               std::vector<std::pair<std::string, std::string>>* out) {
  Napi::Value value = source.Get("ipp");
  if (value.IsUndefined() || value.IsNull()) return Status::Ok();
  if (!value.IsArray()) return MissingField("ipp");

  Napi::Array array = value.As<Napi::Array>();
  const uint32_t length = array.Length();
  out->reserve(length);
  for (uint32_t i = 0; i < length; ++i) {
    Napi::Value entry = array.Get(i);
    if (!entry.IsArray()) return MissingField("ipp[]");
    Napi::Array pair = entry.As<Napi::Array>();
    Napi::Value key = pair.Get(0u);
    Napi::Value val = pair.Get(1u);
    if (!key.IsString() || !val.IsString()) return MissingField("ipp[]");
    out->emplace_back(key.As<Napi::String>().Utf8Value(), val.As<Napi::String>().Utf8Value());
  }
  return Status::Ok();
}

Status ReadWindowsSettings(const Napi::Object& source, WindowsSettings* out) {
  Napi::Value value = source.Get("windows");
  if (value.IsUndefined() || value.IsNull()) return Status::Ok();
  if (!value.IsObject()) return MissingField("windows");
  Napi::Object win = value.As<Napi::Object>();

  PIN_RETURN_IF_ERROR(ReadOptionalInt16(win, "orientation", &out->orientation));
  PIN_RETURN_IF_ERROR(ReadOptionalInt16(win, "paperSize", &out->paper_size));
  PIN_RETURN_IF_ERROR(ReadOptionalInt16(win, "paperWidth", &out->paper_width));
  PIN_RETURN_IF_ERROR(ReadOptionalInt16(win, "paperLength", &out->paper_length));
  PIN_RETURN_IF_ERROR(ReadOptionalInt16(win, "duplex", &out->duplex));
  PIN_RETURN_IF_ERROR(ReadOptionalInt16(win, "color", &out->color));
  PIN_RETURN_IF_ERROR(ReadOptionalInt16(win, "quality", &out->quality));
  PIN_RETURN_IF_ERROR(ReadOptionalInt16(win, "bin", &out->bin));
  PIN_RETURN_IF_ERROR(ReadOptionalInt16(win, "collate", &out->collate));
  PIN_RETURN_IF_ERROR(ReadOptionalString(win, "outputFile", &out->output_file));

  int render_mode = 0;
  PIN_RETURN_IF_ERROR(ReadInt(win, "renderMode", &render_mode));
  out->render_mode = render_mode == 1 ? RenderMode::kBitmap : RenderMode::kVector;
  PIN_RETURN_IF_ERROR(ReadInt(win, "printMode", &out->print_mode));
  PIN_RETURN_IF_ERROR(ReadInt(win, "dpi", &out->dpi));
  return Status::Ok();
}

void SetOptionalNumber(Napi::Object& target, const char* key, const std::optional<int>& value) {
  if (value.has_value()) target.Set(key, Napi::Number::New(target.Env(), *value));
}

void SetOptionalNumber(Napi::Object& target, const char* key, const std::optional<int64_t>& value) {
  if (value.has_value()) {
    target.Set(key, Napi::Number::New(target.Env(), static_cast<double>(*value)));
  }
}

void SetIfNotEmpty(Napi::Object& target, const char* key, const std::string& value) {
  if (!value.empty()) target.Set(key, Napi::String::New(target.Env(), value));
}

}  // namespace

Status ReadPrintRequest(const Napi::Object& source,
                        PrintRequest* request,
                        Napi::Reference<Napi::Value>* keep_alive) {
  PIN_RETURN_IF_ERROR(ReadString(source, "printer", &request->printer));
  PIN_RETURN_IF_ERROR(ReadString(source, "jobName", &request->job_name));
  PIN_RETURN_IF_ERROR(ReadOptionalString(source, "filePath", &request->file_path));

  int kind = 0;
  PIN_RETURN_IF_ERROR(ReadInt(source, "kind", &kind));
  request->kind = kind == 1 ? DocumentKind::kBitmap : DocumentKind::kPdf;

  Napi::Value data = source.Get("data");
  if (!data.IsUndefined() && !data.IsNull()) {
    if (!data.IsTypedArray()) return MissingField("data");
    Napi::TypedArray typed = data.As<Napi::TypedArray>();
    if (typed.TypedArrayType() != napi_uint8_array) return MissingField("data");
    Napi::Uint8Array bytes = typed.As<Napi::Uint8Array>();
    request->data = bytes.Data();
    request->data_length = bytes.ByteLength();
    // The worker reads these bytes from another thread after this function has
    // returned, so the JS-side buffer has to be pinned for the duration.
    *keep_alive = Napi::Persistent(Napi::Value(data));
  }

  if (request->kind == DocumentKind::kBitmap) {
    PIN_RETURN_IF_ERROR(ReadInt(source, "bitmapWidth", &request->bitmap_width));
    PIN_RETURN_IF_ERROR(ReadInt(source, "bitmapHeight", &request->bitmap_height));
    int pixel_format = 0;
    PIN_RETURN_IF_ERROR(ReadInt(source, "pixelFormat", &pixel_format));
    request->pixel_format =
        pixel_format == 1 ? PixelFormat::kBgra : PixelFormat::kRgba;
    if (request->data == nullptr) {
      return Status::Error(code::kBackend,
                           "Internal error: bitmap request carries no pixel data");
    }
  } else if (request->file_path.empty() && request->data == nullptr) {
    return Status::Error(code::kBackend,
                         "Internal error: request carries neither filePath nor data");
  }

  PIN_RETURN_IF_ERROR(ReadInt(source, "copies", &request->copies));
  PIN_RETURN_IF_ERROR(ReadBool(source, "collate", &request->collate));
  PIN_RETURN_IF_ERROR(ReadRanges(source, &request->ranges));

  int subset = 0;
  PIN_RETURN_IF_ERROR(ReadInt(source, "subset", &subset));
  request->subset = subset == 1 ? PageSubset::kOdd
                                : subset == 2 ? PageSubset::kEven : PageSubset::kAll;

  PIN_RETURN_IF_ERROR(ReadBool(source, "reverse", &request->reverse));

  int scale = 2;
  PIN_RETURN_IF_ERROR(ReadInt(source, "scale", &scale));
  switch (scale) {
    case 0: request->scale = ScaleMode::kActual; break;
    case 1: request->scale = ScaleMode::kFit; break;
    case 3: request->scale = ScaleMode::kNoScaleClip; break;
    default: request->scale = ScaleMode::kShrink; break;
  }

  PIN_RETURN_IF_ERROR(ReadInt(source, "numberUp", &request->number_up));
  PIN_RETURN_IF_ERROR(ReadIpp(source, &request->ipp));
  PIN_RETURN_IF_ERROR(ReadWindowsSettings(source, &request->windows));
  return Status::Ok();
}

const char* PrinterStateName(PrinterState state) {
  switch (state) {
    case PrinterState::kIdle: return "idle";
    case PrinterState::kProcessing: return "processing";
    case PrinterState::kStopped: return "stopped";
    case PrinterState::kUnknown: break;
  }
  return "unknown";
}

const char* JobStateName(JobState state) {
  switch (state) {
    case JobState::kPending: return "pending";
    case JobState::kHeld: return "held";
    case JobState::kProcessing: return "processing";
    case JobState::kStopped: return "stopped";
    case JobState::kCompleted: return "completed";
    case JobState::kCanceled: return "canceled";
    case JobState::kAborted: return "aborted";
    case JobState::kUnknown: break;
  }
  return "unknown";
}

Napi::Value ToJs(Napi::Env env, const PrintResult& result) {
  Napi::Object out = Napi::Object::New(env);
  out.Set("jobId", Napi::Number::New(env, result.job_id));
  out.Set("printer", Napi::String::New(env, result.printer));
  out.Set("jobName", Napi::String::New(env, result.job_name));
  SetOptionalNumber(out, "pageCount", result.page_count);
  return out;
}

Napi::Value ToJs(Napi::Env env, const PrinterInfo& printer) {
  Napi::Object out = Napi::Object::New(env);
  out.Set("name", Napi::String::New(env, printer.name));
  SetIfNotEmpty(out, "displayName", printer.display_name);
  out.Set("isDefault", Napi::Boolean::New(env, printer.is_default));
  out.Set("state", Napi::String::New(env, PrinterStateName(printer.state)));
  SetIfNotEmpty(out, "stateReason", printer.state_reason);
  SetIfNotEmpty(out, "location", printer.location);
  SetIfNotEmpty(out, "driver", printer.driver);
  SetIfNotEmpty(out, "uri", printer.uri);
  out.Set("acceptingJobs", Napi::Boolean::New(env, printer.accepting_jobs));
  return out;
}

Napi::Value ToJs(Napi::Env env, const std::vector<PrinterInfo>& printers) {
  Napi::Array out = Napi::Array::New(env, printers.size());
  for (size_t i = 0; i < printers.size(); ++i) {
    out.Set(static_cast<uint32_t>(i), ToJs(env, printers[i]));
  }
  return out;
}

Napi::Value ToJs(Napi::Env env, const JobInfo& job) {
  Napi::Object out = Napi::Object::New(env);
  out.Set("jobId", Napi::Number::New(env, job.job_id));
  out.Set("printer", Napi::String::New(env, job.printer));
  out.Set("jobName", Napi::String::New(env, job.job_name));
  out.Set("state", Napi::String::New(env, JobStateName(job.state)));
  SetOptionalNumber(out, "totalPages", job.total_pages);
  SetOptionalNumber(out, "pagesPrinted", job.pages_printed);
  SetOptionalNumber(out, "size", job.size);
  SetOptionalNumber(out, "createdAt", job.created_at);
  SetIfNotEmpty(out, "rawState", job.raw_state);
  return out;
}

Napi::Value ToJs(Napi::Env env, const BackendInfo& info) {
  Napi::Object out = Napi::Object::New(env);
  out.Set("backend", Napi::String::New(env, info.backend));
  SetIfNotEmpty(out, "pdfiumVersion", info.pdfium_version);
  SetIfNotEmpty(out, "cupsLibrary", info.cups_library);
  return out;
}

Napi::Error ToJsError(Napi::Env env, const Status& status) {
  Napi::Error error = Napi::Error::New(env, status.message());
  error.Set("code", Napi::String::New(env, status.code()));
  if (status.has_native_code()) {
    error.Set("nativeCode", Napi::Number::New(env, status.native_code()));
  }
  if (!status.native_message().empty()) {
    error.Set("nativeMessage", Napi::String::New(env, status.native_message()));
  }
  return error;
}

}  // namespace pin
