#!/usr/bin/env bash
#
# Creates a CUPS queue that prints to a file, so the end-to-end tests can check
# what actually came out rather than only that submission succeeded.
#
# Two flavours, because they verify different things:
#
#   pdf  (Linux)  cups-pdf runs the real filter chain, so page ranges, paper
#                 sizes and copies are observable in the output.
#   file (macOS)  a raw file: queue passes the bytes through untouched, which
#                 verifies submission and byte fidelity. cups-pdf is not
#                 packaged for macOS, and the filter chain there depends on a
#                 PPD we would have to ship.
#
# Prints the environment the test suite needs on stdout, so it can be eval'd or
# appended to $GITHUB_ENV.
#
# Usage: scripts/setup-test-printer.sh [queue-name]

set -euo pipefail

QUEUE="${1:-PrintItNowTest}"

log() { printf '%s\n' "$*" >&2; }

emit() { printf '%s\n' "$1"; }

wait_for_cupsd() {
  for _ in $(seq 1 40); do
    if lpstat -r >/dev/null 2>&1; then return 0; fi
    sleep 0.5
  done
  log "ERROR: cupsd did not become ready"
  return 1
}

start_cupsd() {
  if lpstat -r >/dev/null 2>&1; then
    log "cupsd is already running"
    return 0
  fi

  if command -v systemctl >/dev/null 2>&1 && systemctl start cups 2>/dev/null; then
    log "started cupsd via systemctl"
  else
    # Containers usually have no init system, so cupsd is started directly. It
    # has to keep running after this script exits, hence the background launch.
    log "starting cupsd directly"
    sudo /usr/sbin/cupsd -f >/dev/null 2>&1 &
  fi
  wait_for_cupsd
}

setup_linux() {
  local ppd=/usr/share/ppd/cups-pdf/CUPS-PDF_opt.ppd
  if [ ! -f "$ppd" ]; then
    ppd=/usr/share/ppd/cups-pdf/CUPS-PDF_noopt.ppd
  fi
  if [ ! -f "$ppd" ]; then
    log "ERROR: no cups-pdf PPD found. Install printer-driver-cups-pdf."
    return 1
  fi

  sudo lpadmin -p "$QUEUE" -v cups-pdf:/ -E -P "$ppd"
  sudo lpadmin -d "$QUEUE"
  sudo cupsenable "$QUEUE"
  sudo cupsaccept "$QUEUE"

  # cups-pdf writes into the submitting user's ${HOME}/PDF by default. Reading
  # the configured value keeps this working if the packaging changes it.
  local out
  out="$(sed -n 's/^[[:space:]]*Out[[:space:]]\+//p' /etc/cups/cups-pdf.conf | head -1)"
  out="${out:-\$\{HOME\}/PDF}"
  out="${out//\$\{HOME\}/$HOME}"
  mkdir -p "$out"

  emit "PRINT_IT_NOW_TEST_PRINTER=$QUEUE"
  emit "PRINT_IT_NOW_TEST_OUTPUT_DIR=$out"
  # cups-pdf runs the full filter chain, so page selection, paper size and copies
  # are all observable in the output.
  emit "PRINT_IT_NOW_TEST_RENDERS=1"
  emit "PRINT_IT_NOW_TEST_COPIES=1"
}

setup_macos() {
  local out="${TMPDIR:-/tmp}/print-it-now-test"
  mkdir -p "$out"

  # The file: backend refuses to run unless it has been explicitly enabled.
  if ! grep -qi '^FileDevice Yes' /etc/cups/cups-files.conf 2>/dev/null; then
    log "enabling the CUPS file: backend"
    printf '\nFileDevice Yes\n' | sudo tee -a /etc/cups/cups-files.conf >/dev/null
    sudo launchctl stop org.cups.cupsd 2>/dev/null || true
    sleep 2
    wait_for_cupsd
  fi

  # A raw queue passes the document through untouched, so the output file is
  # byte-for-byte the PDF that was submitted.
  sudo lpadmin -p "$QUEUE" -v "file://$out/output.pdf" -E -m raw
  sudo lpadmin -d "$QUEUE"
  sudo cupsenable "$QUEUE"
  sudo cupsaccept "$QUEUE"

  emit "PRINT_IT_NOW_TEST_PRINTER=$QUEUE"
  # A raw queue overwrites one fixed path rather than naming a file per job.
  emit "PRINT_IT_NOW_TEST_OUTPUT_FILE=$out/output.pdf"
  # Deliberately not setting PRINT_IT_NOW_TEST_RENDERS or _COPIES: a raw queue
  # applies no options, so those assertions would be checking nothing.
}

main() {
  start_cupsd

  # Re-running should be harmless, so any previous queue of this name goes first.
  sudo lpadmin -x "$QUEUE" 2>/dev/null || true

  case "$(uname -s)" in
    Linux) setup_linux ;;
    Darwin) setup_macos ;;
    *)
      log "ERROR: $(uname -s) is not supported by this script. On Windows the tests use"
      log "       the built-in \"Microsoft Print to PDF\" driver and need no setup."
      return 1
      ;;
  esac

  log "queue \"$QUEUE\" is ready"
}

main "$@"
