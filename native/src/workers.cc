#include "workers.h"

#include <utility>

namespace pin {
namespace {

struct Empty {};

struct JobLookup {
  JobInfo job;
  bool found = false;
};

class DescribeWorker final : public BackendWorker<BackendInfo> {
 public:
  using BackendWorker::BackendWorker;

 protected:
  Status Run(BackendInfo* out) override { return backend::Describe(out); }
  Napi::Value Convert(Napi::Env env, const BackendInfo& result) override {
    return ToJs(env, result);
  }
};

class ListPrintersWorker final : public BackendWorker<std::vector<PrinterInfo>> {
 public:
  using BackendWorker::BackendWorker;

 protected:
  Status Run(std::vector<PrinterInfo>* out) override { return backend::ListPrinters(out); }
  Napi::Value Convert(Napi::Env env, const std::vector<PrinterInfo>& result) override {
    return ToJs(env, result);
  }
};

class DefaultPrinterWorker final : public BackendWorker<std::string> {
 public:
  using BackendWorker::BackendWorker;

 protected:
  Status Run(std::string* out) override { return backend::DefaultPrinter(out); }
  Napi::Value Convert(Napi::Env env, const std::string& result) override {
    if (result.empty()) return env.Null();
    return Napi::String::New(env, result);
  }
};

class PrintWorker final : public BackendWorker<PrintResult> {
 public:
  PrintWorker(Napi::Env env, PrintRequest request, Napi::Reference<Napi::Value> keep_alive)
      : BackendWorker(env), request_(std::move(request)), keep_alive_(std::move(keep_alive)) {}

 protected:
  Status Run(PrintResult* out) override { return backend::Print(request_, out); }
  Napi::Value Convert(Napi::Env env, const PrintResult& result) override {
    return ToJs(env, result);
  }

 private:
  PrintRequest request_;
  // Pins the caller's Buffer until the job has been handed to the spooler.
  Napi::Reference<Napi::Value> keep_alive_;
};

class GetJobWorker final : public BackendWorker<JobLookup> {
 public:
  GetJobWorker(Napi::Env env, std::string printer, int job_id)
      : BackendWorker(env), printer_(std::move(printer)), job_id_(job_id) {}

 protected:
  Status Run(JobLookup* out) override {
    return backend::QueryJob(printer_, job_id_, &out->job, &out->found);
  }
  Napi::Value Convert(Napi::Env env, const JobLookup& result) override {
    if (!result.found) return env.Null();
    return ToJs(env, result.job);
  }

 private:
  std::string printer_;
  int job_id_;
};

class ListJobsWorker final : public BackendWorker<std::vector<JobInfo>> {
 public:
  ListJobsWorker(Napi::Env env, std::string printer)
      : BackendWorker(env), printer_(std::move(printer)) {}

 protected:
  Status Run(std::vector<JobInfo>* out) override { return backend::ListJobs(printer_, out); }
  Napi::Value Convert(Napi::Env env, const std::vector<JobInfo>& result) override {
    return ToJs(env, result);
  }

 private:
  std::string printer_;
};

class CancelJobWorker final : public BackendWorker<Empty> {
 public:
  CancelJobWorker(Napi::Env env, std::string printer, int job_id)
      : BackendWorker(env), printer_(std::move(printer)), job_id_(job_id) {}

 protected:
  Status Run(Empty*) override { return backend::CancelJob(printer_, job_id_); }
  Napi::Value Convert(Napi::Env env, const Empty&) override { return env.Undefined(); }

 private:
  std::string printer_;
  int job_id_;
};

// Rejects rather than throws so that every failure mode of the public API is a
// rejected promise; a mix of sync throws and rejections is a trap for callers.
Napi::Value RejectWith(Napi::Env env, const Status& status) {
  Napi::Promise::Deferred deferred = Napi::Promise::Deferred::New(env);
  deferred.Reject(ToJsError(env, status).Value());
  return deferred.Promise();
}

template <typename Worker, typename... Args>
Napi::Value Queue(Napi::Env env, Args&&... args) {
  Worker* worker = new Worker(env, std::forward<Args>(args)...);
  Napi::Promise promise = worker->Promise();
  worker->Queue();
  return promise;
}

Status ReadPrinterAndJob(const Napi::CallbackInfo& info, std::string* printer, int* job_id) {
  if (info.Length() < 2 || !info[0].IsString() || !info[1].IsNumber()) {
    return Status::Error(code::kBackend,
                         "Internal error: expected (printer: string, jobId: number)");
  }
  *printer = info[0].As<Napi::String>().Utf8Value();
  *job_id = info[1].As<Napi::Number>().Int32Value();
  return Status::Ok();
}

Status ReadPrinter(const Napi::CallbackInfo& info, std::string* printer) {
  if (info.Length() < 1 || !info[0].IsString()) {
    return Status::Error(code::kBackend, "Internal error: expected (printer: string)");
  }
  *printer = info[0].As<Napi::String>().Utf8Value();
  return Status::Ok();
}

}  // namespace

std::mutex& BackendMutex() {
  static std::mutex mutex;
  return mutex;
}

Napi::Value StartDescribe(const Napi::CallbackInfo& info) {
  return Queue<DescribeWorker>(info.Env());
}

Napi::Value StartListPrinters(const Napi::CallbackInfo& info) {
  return Queue<ListPrintersWorker>(info.Env());
}

Napi::Value StartDefaultPrinter(const Napi::CallbackInfo& info) {
  return Queue<DefaultPrinterWorker>(info.Env());
}

Napi::Value StartPrint(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsObject()) {
    return RejectWith(env,
                      Status::Error(code::kBackend,
                                    "Internal error: expected a request object"));
  }

  PrintRequest request;
  Napi::Reference<Napi::Value> keep_alive;
  Status status = ReadPrintRequest(info[0].As<Napi::Object>(), &request, &keep_alive);
  if (!status.ok()) return RejectWith(env, status);

  return Queue<PrintWorker>(env, std::move(request), std::move(keep_alive));
}

Napi::Value StartGetJob(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  std::string printer;
  int job_id = 0;
  Status status = ReadPrinterAndJob(info, &printer, &job_id);
  if (!status.ok()) return RejectWith(env, status);
  return Queue<GetJobWorker>(env, std::move(printer), job_id);
}

Napi::Value StartListJobs(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  std::string printer;
  Status status = ReadPrinter(info, &printer);
  if (!status.ok()) return RejectWith(env, status);
  return Queue<ListJobsWorker>(env, std::move(printer));
}

Napi::Value StartCancelJob(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  std::string printer;
  int job_id = 0;
  Status status = ReadPrinterAndJob(info, &printer, &job_id);
  if (!status.ok()) return RejectWith(env, status);
  return Queue<CancelJobWorker>(env, std::move(printer), job_id);
}

}  // namespace pin
