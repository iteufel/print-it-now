#include <napi.h>

#include <vector>

#include "backend.h"
#include "convert.h"
#include "page_selection.h"
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

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("describe", Napi::Function::New(env, pin::StartDescribe));
  exports.Set("listPrinters", Napi::Function::New(env, pin::StartListPrinters));
  exports.Set("defaultPrinter", Napi::Function::New(env, pin::StartDefaultPrinter));
  exports.Set("print", Napi::Function::New(env, pin::StartPrint));
  exports.Set("getJob", Napi::Function::New(env, pin::StartGetJob));
  exports.Set("cancelJob", Napi::Function::New(env, pin::StartCancelJob));
  exports.Set("_expandPageSelection", Napi::Function::New(env, ExpandPageSelection));
  return exports;
}

}  // namespace

NODE_API_MODULE(print_it_now, Init)
