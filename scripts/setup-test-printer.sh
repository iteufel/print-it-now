#!/usr/bin/env bash
#
# Creates a CUPS print queue for the end-to-end tests, and prints the environment
# they need on stdout so it can be eval'd or appended to $GITHUB_ENV.
#
# Two flavours, because the platforms do not offer the same thing:
#
#   Linux   cups-pdf, which runs the real filter chain. Page ranges, paper sizes
#           and copies are all observable in the output, so the tests can check
#           what actually came out.
#   macOS   an ippeveprinter instance with an IPP Everywhere queue in front of it.
#           macOS removed support for raw queues, and there is no cups-pdf for it,
#           so output cannot be inspected -- but submission, enumeration, job
#           status and the error paths are all exercised against real CUPS on
#           Darwin, which is the point. The identical backend code has its output
#           verified on Linux.
#
# Usage: scripts/setup-test-printer.sh [queue-name]

set -euo pipefail

QUEUE="${1:-PrintItNowTest}"
IPPEVE_PORT="${PRINT_IT_NOW_IPPEVE_PORT:-18631}"

# Stdout is reserved for the environment lines, because the caller redirects it
# straight into $GITHUB_ENV, where one stray line breaks the whole file. Rather
# than remembering to redirect every command, the real stdout is moved to fd 3 and
# fd 1 is pointed at stderr, so anything chatty is harmless by default. apt-get
# and lpadmin both write to stdout despite -qq, which is what made a first attempt
# at this fail.
exec 3>&1
exec 1>&2

log() { printf '%s\n' "$*"; }
emit() { printf '%s\n' "$1" >&3; }

wait_for_cupsd() {
  for _ in $(seq 1 40); do
    if lpstat -r >/dev/null 2>&1; then return 0; fi
    sleep 0.5
  done
  log "ERROR: cupsd did not become ready"
  return 1
}

# CI images do not all ship CUPS, and a developer setting up the repository for
# the first time will not have cups-pdf. Installing here keeps the two identical.
install_linux_packages() {
  local wanted=()
  command -v cupsd >/dev/null 2>&1 || [ -x /usr/sbin/cupsd ] || wanted+=(cups-daemon)
  command -v lpstat >/dev/null 2>&1 || wanted+=(cups-client)
  ls /usr/share/ppd/cups-pdf/*.ppd >/dev/null 2>&1 || wanted+=(printer-driver-cups-pdf)
  # The addon resolves libcups at runtime, so the shared library has to be there
  # even though nothing links against it.
  ldconfig -p 2>/dev/null | grep -q 'libcups\.so\.2' || wanted+=(libcups2t64)

  if [ "${#wanted[@]}" -eq 0 ]; then
    log "CUPS is already installed"
    return 0
  fi

  if ! command -v apt-get >/dev/null 2>&1; then
    log "ERROR: missing ${wanted[*]} and this is not a Debian-family system."
    log "       Install the equivalents for your distribution and re-run."
    return 1
  fi

  log "installing ${wanted[*]}"
  sudo apt-get update -qq
  # libcups2t64 is the Ubuntu 24.04 name; older releases call it libcups2.
  if ! sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "${wanted[@]}" 2>/dev/null; then
    local fallback=("${wanted[@]/libcups2t64/libcups2}")
    sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "${fallback[@]}"
  fi
}

start_cupsd() {
  if lpstat -r >/dev/null 2>&1; then
    log "cupsd is already running"
    return 0
  fi

  if command -v systemctl >/dev/null 2>&1 && sudo systemctl start cups 2>/dev/null; then
    log "started cupsd via systemctl"
  else
    # Containers and CI images usually have no working init, so cupsd is started
    # directly. It has to outlive this script, hence the background launch.
    log "starting cupsd directly"
    sudo /usr/sbin/cupsd -f >/dev/null 2>&1 &
  fi
  wait_for_cupsd
}

setup_linux() {
  local ppd=/usr/share/ppd/cups-pdf/CUPS-PDF_opt.ppd
  [ -f "$ppd" ] || ppd=/usr/share/ppd/cups-pdf/CUPS-PDF_noopt.ppd
  if [ ! -f "$ppd" ]; then
    log "ERROR: no cups-pdf PPD found even after installing printer-driver-cups-pdf"
    return 1
  fi

  sudo lpadmin -p "$QUEUE" -v cups-pdf:/ -E -P "$ppd"
  sudo lpadmin -d "$QUEUE"
  sudo cupsenable "$QUEUE"
  sudo cupsaccept "$QUEUE"

  # cups-pdf writes into the submitting user's ${HOME}/PDF by default. Reading the
  # configured value keeps this working if the packaging ever changes it.
  local out
  out="$(sed -n 's/^[[:space:]]*Out[[:space:]]\+//p' /etc/cups/cups-pdf.conf 2>/dev/null | head -1)"
  out="${out:-\$\{HOME\}/PDF}"
  out="${out//\$\{HOME\}/$HOME}"
  mkdir -p "$out"

  emit "PRINT_IT_NOW_TEST_PRINTER=$QUEUE"
  emit "PRINT_IT_NOW_TEST_OUTPUT_DIR=$out"
  # The full filter chain runs, so page selection, paper size and copies are all
  # observable in the output.
  emit "PRINT_IT_NOW_TEST_RENDERS=1"
  emit "PRINT_IT_NOW_TEST_COPIES=1"
}

setup_macos() {
  local ippeve
  ippeve="$(command -v ippeveprinter || true)"
  [ -n "$ippeve" ] || [ ! -x /usr/sbin/ippeveprinter ] || ippeve=/usr/sbin/ippeveprinter
  if [ -z "$ippeve" ]; then
    log "ERROR: ippeveprinter was not found. It ships with CUPS 2.3 and later, and"
    log "       is needed because macOS no longer supports raw queues and has no"
    log "       cups-pdf, leaving no other way to create a queue with no hardware."
    return 1
  fi

  local spool="${TMPDIR:-/tmp}/print-it-now-ippeve"
  rm -rf "$spool"
  mkdir -p "$spool"

  log "starting ippeveprinter on port $IPPEVE_PORT"
  "$ippeve" -d "$spool" -p "$IPPEVE_PORT" -f application/pdf "$QUEUE" \
    >"$spool/ippeveprinter.log" 2>&1 &

  # The queue cannot be created until the printer answers, because the everywhere
  # model asks it for its capabilities over IPP.
  local ready=0
  for _ in $(seq 1 40); do
    if ipptool -q "ipp://localhost:$IPPEVE_PORT/ipp/print" get-printer-attributes.test \
      >/dev/null 2>&1; then
      ready=1
      break
    fi
    sleep 0.5
  done
  if [ "$ready" -ne 1 ]; then
    log "ERROR: ippeveprinter did not start. Log:"
    sed 's/^/       /' "$spool/ippeveprinter.log" >&2 || true
    return 1
  fi

  sudo lpadmin -p "$QUEUE" -v "ipp://localhost:$IPPEVE_PORT/ipp/print" -E -m everywhere
  sudo lpadmin -d "$QUEUE"
  sudo cupsenable "$QUEUE"
  sudo cupsaccept "$QUEUE"

  emit "PRINT_IT_NOW_TEST_PRINTER=$QUEUE"
  # ippeveprinter reports jobs as complete without keeping a predictable output
  # file, so the tests assert on submission rather than on bytes. Deliberately not
  # setting _RENDERS or _COPIES either: nothing here applies print options.
  emit "PRINT_IT_NOW_TEST_NO_OUTPUT=1"
}

main() {
  case "$(uname -s)" in
    Linux)
      install_linux_packages
      start_cupsd
      sudo lpadmin -x "$QUEUE" 2>/dev/null || true
      setup_linux
      ;;
    Darwin)
      start_cupsd
      sudo lpadmin -x "$QUEUE" 2>/dev/null || true
      setup_macos
      ;;
    *)
      log "ERROR: $(uname -s) is not supported by this script. On Windows the tests use"
      log "       the built-in \"Microsoft Print to PDF\" driver and need no setup."
      return 1
      ;;
  esac

  log "queue \"$QUEUE\" is ready"
}

main "$@"
