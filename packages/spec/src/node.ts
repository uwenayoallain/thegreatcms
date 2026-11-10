/**
 * A time limit on a schema's `pattern`, for hosts on Node: the studio, where patterns run on every
 * save, and `greatcms check`, which a build waits for. One that backtracks without end costs a
 * moment, never the process. Kept out of the main entry, which runs anywhere.
 */

import { setFlagsFromString } from "node:v8";
import { createContext, Script } from "node:vm";
import type { PatternMatcher } from "./validate.js";

/** How long one value may take against one pattern. */
export const PATTERN_LIMIT_MS = 100;
/** Checks stopped in one pass before the rest are given up on, so a long list cannot add them up. */
const MAX_STOPPED = 3;

// Past a backtracking limit V8 switches to an engine that cannot hang, for the patterns it can run.
setFlagsFromString("--enable-experimental-regexp-engine-on-excessive-backtracks");
// Makes the `l` flag exist, which refuses to compile a pattern that engine cannot run.
setFlagsFromString("--enable-experimental-regexp-engine");

const linear = new Map<string, boolean>();

/** Whether V8 can fall back to linear time for a pattern: not with lookahead, backreferences or large repeat counts. */
export function runsInLinearTime(pattern: RegExp): boolean {
  let known = linear.get(pattern.source);
  if (known === undefined) {
    try {
      known = new RegExp(pattern.source, pattern.flags + "l").flags.includes("l");
    } catch {
      known = false;
    }
    if (linear.size >= 500) linear.clear();
    linear.set(pattern.source, known);
  }
  return known;
}

const sandbox: { pattern?: RegExp; value?: string } = createContext(Object.create(null));
const test = new Script("pattern.test(value)");
let stopped = 0;

/** Tests a value, stopping a pattern that V8 cannot bound by itself after `PATTERN_LIMIT_MS`. */
export const boundedMatch: PatternMatcher = (pattern, value) => {
  if (runsInLinearTime(pattern)) return pattern.test(value);
  if (stopped >= MAX_STOPPED) return null;
  sandbox.pattern = pattern;
  sandbox.value = value;
  try {
    return test.runInContext(sandbox, { timeout: PATTERN_LIMIT_MS }) === true;
  } catch {
    // Validation is one synchronous pass, so the count starts again once this one is over.
    if (stopped++ === 0) setImmediate(() => (stopped = 0));
    return null;
  } finally {
    sandbox.pattern = undefined;
    sandbox.value = undefined;
  }
};
