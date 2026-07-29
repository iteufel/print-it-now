#include <cerrno>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

#include "backend.h"
#include "cups_dynamic.h"
#include "status.h"

namespace pin {
namespace backend {
namespace {

constexpr size_t kChunkSize = 64 * 1024;

// Read-only queue attributes that cupsGetNamedDest reports alongside the user's
// saved defaults. We merge the saved defaults into the job (so `lpoptions -p q -o
// sides=two-sided-long-edge` is honoured, matching `lp`), but forwarding status
// attributes as job attributes is just noise on the wire.
bool IsQueueAttribute(const char* name) {
  static constexpr const char* kPrefixes[] = {"printer-", "marker-", "device-uri",
                                              "job-sheets-supported"};
  for (const char* prefix : kPrefixes) {
    if (std::strncmp(name, prefix, std::strlen(prefix)) == 0) return true;
  }
  return false;
}

std::string QualifiedName(const cups::Dest& dest) {
  std::string name = dest.name != nullptr ? dest.name : "";
  if (dest.instance != nullptr && dest.instance[0] != '\0') {
    name += "/";
    name += dest.instance;
  }
  return name;
}

// Splits "queue/instance" as understood by lp and lpoptions.
void SplitDestination(const std::string& printer, std::string* name, std::string* instance) {
  const size_t slash = printer.find('/');
  if (slash == std::string::npos) {
    *name = printer;
    instance->clear();
    return;
  }
  *name = printer.substr(0, slash);
  *instance = printer.substr(slash + 1);
}

PrinterState ToPrinterState(const char* raw) {
  if (raw == nullptr) return PrinterState::kUnknown;
  switch (std::atoi(raw)) {
    case cups::kPrinterIdle: return PrinterState::kIdle;
    case cups::kPrinterProcessing: return PrinterState::kProcessing;
    case cups::kPrinterStopped: return PrinterState::kStopped;
    default: return PrinterState::kUnknown;
  }
}

JobState ToJobState(int raw) {
  switch (raw) {
    case cups::kJobPending: return JobState::kPending;
    case cups::kJobHeld: return JobState::kHeld;
    case cups::kJobProcessing: return JobState::kProcessing;
    case cups::kJobStopped: return JobState::kStopped;
    case cups::kJobCanceled: return JobState::kCanceled;
    case cups::kJobAborted: return JobState::kAborted;
    case cups::kJobCompleted: return JobState::kCompleted;
    default: return JobState::kUnknown;
  }
}

std::string OptionOrEmpty(const cups::Library& cups, const cups::Dest& dest, const char* name) {
  const char* value = cups.GetOption(name, dest.num_options, dest.options);
  return value != nullptr ? std::string(value) : std::string();
}

// Owns the cups_option_t array for the lifetime of one job submission.
class OptionList {
 public:
  explicit OptionList(const cups::Library& cups) : cups_(cups) {}

  OptionList(const OptionList&) = delete;
  OptionList& operator=(const OptionList&) = delete;

  ~OptionList() {
    if (options_ != nullptr) cups_.FreeOptions(count_, options_);
  }

  void Add(const char* name, const char* value) {
    count_ = cups_.AddOption(name, value, count_, &options_);
  }

  bool Has(const char* name) const {
    return cups_.GetOption(name, count_, options_) != nullptr;
  }

  int count() const { return count_; }
  cups::Option* data() const { return options_; }

 private:
  const cups::Library& cups_;
  int count_ = 0;
  cups::Option* options_ = nullptr;
};

// Releases a destination from cupsGetNamedDest, which must be freed as a
// one-element cupsFreeDests array.
class DestHandle {
 public:
  DestHandle(const cups::Library& cups, cups::Dest* dest) : cups_(cups), dest_(dest) {}

  DestHandle(const DestHandle&) = delete;
  DestHandle& operator=(const DestHandle&) = delete;

  ~DestHandle() {
    if (dest_ != nullptr) cups_.FreeDests(1, dest_);
  }

  cups::Dest* get() const { return dest_; }

 private:
  const cups::Library& cups_;
  cups::Dest* dest_;
};

Status WriteAll(const cups::Library& cups, const char* bytes, size_t length) {
  size_t offset = 0;
  while (offset < length) {
    const size_t chunk = length - offset < kChunkSize ? length - offset : kChunkSize;
    if (cups.WriteRequestData(nullptr, bytes + offset, chunk) != cups::kHttpContinue) {
      return cups::LastErrorStatus(cups, "Failed to send document data to CUPS");
    }
    offset += chunk;
  }
  return Status::Ok();
}

Status StreamFile(const cups::Library& cups, const std::string& path) {
  std::FILE* file = std::fopen(path.c_str(), "rb");
  if (file == nullptr) {
    return Status::Error(code::kInvalidPdf, "Could not open \"" + path + "\" for reading", errno);
  }

  std::vector<char> buffer(kChunkSize);
  Status status = Status::Ok();
  while (true) {
    const size_t read = std::fread(buffer.data(), 1, buffer.size(), file);
    if (read == 0) {
      if (std::ferror(file) != 0) {
        status = Status::Error(code::kInvalidPdf, "Error reading \"" + path + "\"", errno);
      }
      break;
    }
    status = WriteAll(cups, buffer.data(), read);
    if (!status.ok()) break;
  }
  std::fclose(file);
  return status;
}

}  // namespace

Status Describe(BackendInfo* out) {
  out->backend = "cups";
  Status status;
  if (cups::Load(&status) == nullptr) return status;
  out->cups_library = cups::LoadedPath();
  return Status::Ok();
}

Status ListPrinters(std::vector<PrinterInfo>* out) {
  Status status;
  const cups::Library* cups = cups::Load(&status);
  if (cups == nullptr) return status;

  cups::Dest* dests = nullptr;
  const int count = cups->GetDests2(nullptr, &dests);
  if (count < 0) {
    return cups::LastErrorStatus(*cups, "Failed to enumerate CUPS destinations");
  }

  out->reserve(static_cast<size_t>(count));
  for (int i = 0; i < count; ++i) {
    const cups::Dest& dest = dests[i];
    PrinterInfo info;
    info.name = QualifiedName(dest);
    info.display_name = OptionOrEmpty(*cups, dest, "printer-info");
    info.is_default = dest.is_default != 0;
    info.state = ToPrinterState(cups->GetOption("printer-state", dest.num_options, dest.options));
    info.state_reason = OptionOrEmpty(*cups, dest, "printer-state-reasons");
    info.location = OptionOrEmpty(*cups, dest, "printer-location");
    info.driver = OptionOrEmpty(*cups, dest, "printer-make-and-model");
    info.uri = OptionOrEmpty(*cups, dest, "device-uri");
    const std::string accepting = OptionOrEmpty(*cups, dest, "printer-is-accepting-jobs");
    info.accepting_jobs = accepting.empty() || accepting == "true";
    // "none" is CUPS' way of saying "nothing to report"; surfacing it as a
    // reason would make every healthy queue look like it had something wrong.
    if (info.state_reason == "none") info.state_reason.clear();
    out->push_back(std::move(info));
  }

  cups->FreeDests(count, dests);
  return Status::Ok();
}

Status DefaultPrinter(std::string* out) {
  Status status;
  const cups::Library* cups = cups::Load(&status);
  if (cups == nullptr) return status;

  DestHandle dest(*cups, cups->GetNamedDest(nullptr, nullptr, nullptr));
  if (dest.get() == nullptr) {
    out->clear();
    return Status::Ok();
  }
  *out = QualifiedName(*dest.get());
  return Status::Ok();
}

Status Print(const PrintRequest& request, PrintResult* out) {
  Status status;
  const cups::Library* cups = cups::Load(&status);
  if (cups == nullptr) return status;

  std::string name;
  std::string instance;
  SplitDestination(request.printer, &name, &instance);

  DestHandle dest(*cups,
                  cups->GetNamedDest(nullptr, name.c_str(),
                                     instance.empty() ? nullptr : instance.c_str()));
  if (dest.get() == nullptr) {
    return Status::Error(code::kPrinterNotFound,
                         "Printer \"" + request.printer + "\" was not found");
  }

  OptionList options(*cups);
  for (const auto& entry : request.ipp) {
    options.Add(entry.first.c_str(), entry.second.c_str());
  }
  // The caller's options win; whatever the user saved with lpoptions fills the
  // gaps, which is the behaviour `lp` has always had.
  const cups::Dest& resolved = *dest.get();
  for (int i = 0; i < resolved.num_options; ++i) {
    const cups::Option& option = resolved.options[i];
    if (option.name == nullptr || option.value == nullptr) continue;
    if (IsQueueAttribute(option.name)) continue;
    if (options.Has(option.name)) continue;
    options.Add(option.name, option.value);
  }

  const int job_id = cups->CreateJob(nullptr, resolved.name, request.job_name.c_str(),
                                     options.count(), options.data());
  if (job_id <= 0) {
    return cups::LastErrorStatus(
        *cups, "CUPS rejected the job for printer \"" + request.printer + "\"");
  }

  const std::string document_name =
      request.job_name.empty() ? std::string("document.pdf") : request.job_name;
  if (cups->StartDocument(nullptr, resolved.name, job_id, document_name.c_str(),
                          cups::kFormatPdf, 1) != cups::kHttpContinue) {
    Status failure = cups::LastErrorStatus(*cups, "CUPS refused the document");
    cups->CancelJob2(nullptr, resolved.name, job_id, 0);
    return failure;
  }

  status = request.data != nullptr
               ? WriteAll(*cups, reinterpret_cast<const char*>(request.data),
                          request.data_length)
               : StreamFile(*cups, request.file_path);

  // FinishDocument has to run even after a write failure: it is what closes out
  // the IPP request. Cancelling afterwards keeps a half-sent document from
  // reaching paper.
  const int finish = cups->FinishDocument(nullptr, resolved.name);
  if (!status.ok()) {
    cups->CancelJob2(nullptr, resolved.name, job_id, 0);
    return status;
  }
  if (finish != cups::kStatusOk) {
    return cups::LastErrorStatus(*cups, "CUPS failed to accept the document");
  }

  out->job_id = job_id;
  out->printer = request.printer;
  out->job_name = request.job_name;
  // Deliberately left unset: CUPS expands `page-ranges` server-side, so the
  // number of sheets is not knowable here without parsing the PDF ourselves.
  return Status::Ok();
}

Status QueryJob(const std::string& printer, int job_id, JobInfo* out, bool* found) {
  *found = false;
  Status status;
  const cups::Library* cups = cups::Load(&status);
  if (cups == nullptr) return status;

  std::string name;
  std::string instance;
  SplitDestination(printer, &name, &instance);

  cups::Job* jobs = nullptr;
  const int count = cups->GetJobs2(nullptr, &jobs, name.c_str(), 0, cups::kWhichJobsAll);
  if (count < 0) {
    return cups::LastErrorStatus(*cups, "Failed to list jobs for printer \"" + printer + "\"");
  }

  for (int i = 0; i < count; ++i) {
    if (jobs[i].id != job_id) continue;
    const cups::Job& job = jobs[i];
    out->job_id = job.id;
    out->printer = job.dest != nullptr ? job.dest : printer;
    out->job_name = job.title != nullptr ? job.title : "";
    out->state = ToJobState(job.state);
    out->raw_state = std::to_string(job.state);
    // cups_job_t reports kilobytes.
    out->size = static_cast<int64_t>(job.size) * 1024;
    if (job.creation_time > 0) out->created_at = static_cast<int64_t>(job.creation_time);
    *found = true;
    break;
  }

  cups->FreeJobs(count, jobs);
  return Status::Ok();
}

Status CancelJob(const std::string& printer, int job_id) {
  Status status;
  const cups::Library* cups = cups::Load(&status);
  if (cups == nullptr) return status;

  std::string name;
  std::string instance;
  SplitDestination(printer, &name, &instance);

  const int result = cups->CancelJob2(nullptr, name.c_str(), job_id, 0);
  if (result == cups::kStatusOk) return Status::Ok();
  if (result == cups::kStatusErrorNotFound || result == cups::kStatusErrorNotPossible) {
    return Status::Error(code::kJobNotFound,
                         "Job " + std::to_string(job_id) + " was not found on printer \"" +
                             printer + "\"",
                         result);
  }
  return cups::LastErrorStatus(*cups, "Failed to cancel job " + std::to_string(job_id));
}

}  // namespace backend
}  // namespace pin
