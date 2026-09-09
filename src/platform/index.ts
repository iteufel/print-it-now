/**
 * Embeds every platform's native addon into a `bun build --compile` executable.
 *
 * Prefer a single-OS entry (`print-it-now/platform/win`, `.../macos`, or
 * `.../linux`) when you know the compile target: those keep the unused
 * binaries out of the binary. This barrel is for a build that must run on
 * more than one OS.
 *
 *   import "print-it-now/platform";
 *   import { printPdf } from "print-it-now";
 */

import "./win.js";
import "./macos.js";
import "./linux.js";

export {};

