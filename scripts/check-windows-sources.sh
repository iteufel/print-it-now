#!/usr/bin/env bash
#
# Compiles the Windows backend on a non-Windows machine, using the MinGW-w64
# cross compiler, to check it still builds.
#
# Most contributors and most CI minutes are on Linux, where the Windows half of
# this package would otherwise go unbuilt until a Windows runner picked it up.
# That is a long feedback loop for the platform with the more intricate backend.
# This check is not a substitute for the real MSVC build -- it cannot link, and
# MinGW's headers lag the Windows SDK -- but it catches the ordinary mistakes
# early. It has already earned its keep: it found <winspool.h> macro-renaming a
# GetJob declaration, a device capability that does not exist, and a
# misnamespaced type.
#
# Requires: g++-mingw-w64-x86-64 (Debian/Ubuntu) or mingw-w64-gcc (Fedora).

set -euo pipefail

CXX="${MINGW_CXX:-x86_64-w64-mingw32-g++}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if ! command -v "$CXX" >/dev/null 2>&1; then
  printf 'ERROR: %s not found.\n' "$CXX" >&2
  printf 'Install it with: sudo apt-get install g++-mingw-w64-x86-64\n' >&2
  exit 1
fi

# Warnings are errors here: this check exists to be strict, and it runs against a
# fixed toolchain, so it cannot be broken by a compiler upgrade on a user's
# machine.
"$CXX" \
  -fsyntax-only \
  -std=c++17 \
  -Wall -Wextra -Werror \
  -DUNICODE -D_UNICODE -DWIN32_LEAN_AND_MEAN -DNOMINMAX -DPIN_BACKEND_WINDOWS=1 \
  -I "$ROOT/native/src" \
  -I "$ROOT/native/src/win" \
  -I "$ROOT/native/third_party/pdfium/include" \
  "$ROOT"/native/src/bitmap.cc \
  "$ROOT"/native/src/win/*.cc

printf 'Windows sources compile cleanly with %s\n' "$CXX"
