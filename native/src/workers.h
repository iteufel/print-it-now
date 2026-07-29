#pragma once

#include <napi.h>

#include <mutex>
#include <string>
#include <vector>

#include "backend.h"
#include "convert.h"
#include "status.h"

namespace pin {

// PDFium is not thread-safe, and a printer device context must not be driven
// from two threads at once. Every backend call therefore takes this lock, which
// serialises native work while still keeping the JS thread free. Printing is
// inherently serial per queue, so this costs nothing in practice.
std::mutex& BackendMutex();

// AsyncWorker specialised for our Status-returning backends: the subclass fills
// in `Run()` off-thread, and a failure is reported to JS as an Error carrying
// the `code` discriminator the JS layer switches on.
template <typename Result>
class BackendWorker : public Napi::AsyncWorker {
 public:
  explicit BackendWorker(Napi::Env env)
      : Napi::AsyncWorker(env), deferred_(Napi::Promise::Deferred::New(env)) {}

  Napi::Promise Promise() { return deferred_.Promise(); }

 protected:
  virtual Status Run(Result* out) = 0;
  virtual Napi::Value Convert(Napi::Env env, const Result& result) = 0;

  void Execute() final {
    std::lock_guard<std::mutex> lock(BackendMutex());
    status_ = Run(&result_);
  }

  void OnOK() final {
    Napi::Env env = Env();
    Napi::HandleScope scope(env);
    if (!status_.ok()) {
      deferred_.Reject(ToJsError(env, status_).Value());
      return;
    }
    deferred_.Resolve(Convert(env, result_));
  }

  void OnError(const Napi::Error& error) final {
    Napi::Env env = Env();
    Napi::HandleScope scope(env);
    deferred_.Reject(error.Value());
  }

  Result result_{};

 private:
  Napi::Promise::Deferred deferred_;
  Status status_;
};

Napi::Value StartDescribe(const Napi::CallbackInfo& info);
Napi::Value StartListPrinters(const Napi::CallbackInfo& info);
Napi::Value StartDefaultPrinter(const Napi::CallbackInfo& info);
Napi::Value StartPrint(const Napi::CallbackInfo& info);
Napi::Value StartGetJob(const Napi::CallbackInfo& info);
Napi::Value StartCancelJob(const Napi::CallbackInfo& info);

}  // namespace pin
