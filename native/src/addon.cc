#include <napi.h>

#include <vector>

#include "backend.h"
#include "convert.h"
#include "page_selection.h"
#include "placement.h"
#include "workers.h"

namespace {

// Exposed for the test suite: page expansion is platform-independent logic that
// only the native side can perform for real (it needs the document's page
// count), so this lets it be exercised on every platform rather than only where
// a printer exists.
Napi::Value ExpandPageSelection(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 4 || !info[0].IsArray() || !info[1].IsNumber() ||
      !info[2].IsBoolean() || !info[3].IsNumber()) {
    Napi::TypeError::New(
        env, "expected (ranges: Array, subset: number, reverse: boolean, pageCount: number)")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }

  std::vector<pin::PageRange> ranges;
  Napi::Array raw = info[0].As<Napi::Array>();
  for (uint32_t i = 0; i < raw.Length(); ++i) {
    Napi::Value entry = raw.Get(i);
    if (!entry.IsObject()) {
      Napi::TypeError::New(env, "each range must be { from, to }").ThrowAsJavaScriptException();
      return env.Undefined();
    }
    Napi::Object object = entry.As<Napi::Object>();
    pin::PageRange range;
    range.from = object.Get("from").As<Napi::Number>().Int32Value();
    range.to = object.Get("to").As<Napi::Number>().Int32Value();
    ranges.push_back(range);
  }

  const int subset_raw = info[1].As<Napi::Number>().Int32Value();
  const pin::PageSubset subset = subset_raw == 1   ? pin::PageSubset::kOdd
                                 : subset_raw == 2 ? pin::PageSubset::kEven
                                                   : pin::PageSubset::kAll;

  const std::vector<int> pages = pin::ExpandPageSelection(
      ranges, subset, info[2].As<Napi::Boolean>().Value(),
      info[3].As<Napi::Number>().Int32Value());

  Napi::Array out = Napi::Array::New(env, pages.size());
  for (size_t i = 0; i < pages.size(); ++i) {
    out.Set(static_cast<uint32_t>(i), Napi::Number::New(env, pages[i]));
  }
  return out;
}

// Also exposed for the test suite. Mapping a page onto a sheet is the fiddliest
// part of the Windows path -- printable versus physical area, the device's own
// origin offset, auto-rotation, four scaling modes -- and it is pure arithmetic,
// so it is worth testing directly on a machine with no printer at all.
Napi::Value ComputePlacement(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 4 || !info[0].IsNumber() || !info[1].IsNumber() || !info[2].IsObject() ||
      !info[3].IsNumber()) {
    Napi::TypeError::New(env,
                         "expected (pageWidthPt: number, pageHeightPt: number, "
                         "sheet: object, scale: number, autoRotate?: boolean)")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }

  Napi::Object raw = info[2].As<Napi::Object>();
  const auto read = [&raw](const char* key, int fallback) {
    Napi::Value value = raw.Get(key);
    return value.IsNumber() ? value.As<Napi::Number>().Int32Value() : fallback;
  };

  pin::SheetMetrics sheet;
  sheet.dpi_x = read("dpiX", 300);
  sheet.dpi_y = read("dpiY", 300);
  sheet.physical_width = read("physicalWidth", 0);
  sheet.physical_height = read("physicalHeight", 0);
  sheet.printable_width = read("printableWidth", 0);
  sheet.printable_height = read("printableHeight", 0);
  sheet.offset_x = read("offsetX", 0);
  sheet.offset_y = read("offsetY", 0);

  pin::ScaleMode scale;
  switch (info[3].As<Napi::Number>().Int32Value()) {
    case 0: scale = pin::ScaleMode::kActual; break;
    case 1: scale = pin::ScaleMode::kFit; break;
    case 3: scale = pin::ScaleMode::kNoScaleClip; break;
    default: scale = pin::ScaleMode::kShrink; break;
  }

  const bool auto_rotate = info.Length() < 5 || !info[4].IsBoolean()
                               ? true
                               : info[4].As<Napi::Boolean>().Value();

  const pin::Placement placement =
      pin::ComputePlacement(info[0].As<Napi::Number>().DoubleValue(),
                            info[1].As<Napi::Number>().DoubleValue(), sheet, scale, auto_rotate);

  Napi::Object out = Napi::Object::New(env);
  out.Set("x", Napi::Number::New(env, placement.x));
  out.Set("y", Napi::Number::New(env, placement.y));
  out.Set("width", Napi::Number::New(env, placement.width));
  out.Set("height", Napi::Number::New(env, placement.height));
  out.Set("rotate", Napi::Number::New(env, placement.rotate));
  return out;
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("describe", Napi::Function::New(env, pin::StartDescribe));
  exports.Set("listPrinters", Napi::Function::New(env, pin::StartListPrinters));
  exports.Set("defaultPrinter", Napi::Function::New(env, pin::StartDefaultPrinter));
  exports.Set("print", Napi::Function::New(env, pin::StartPrint));
  exports.Set("getJob", Napi::Function::New(env, pin::StartGetJob));
  exports.Set("listJobs", Napi::Function::New(env, pin::StartListJobs));
  exports.Set("cancelJob", Napi::Function::New(env, pin::StartCancelJob));
  exports.Set("_expandPageSelection", Napi::Function::New(env, ExpandPageSelection));
  exports.Set("_computePlacement", Napi::Function::New(env, ComputePlacement));
  return exports;
}

}  // namespace

NODE_API_MODULE(print_it_now, Init)
