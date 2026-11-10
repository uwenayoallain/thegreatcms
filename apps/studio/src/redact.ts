/** What a message says to someone who is not an owner: nothing about where things are on this server. */

import { realpathSync } from "node:fs";

const ELSEWHERE = "(a path on this server)";
// A slash that starts a path: not one inside a relative path, a web address or `origin/main`.
const ABSOLUTE =
  /(?<![\w.:/@~+-])\/(?!\/)[\w.@~+-][^\s'"`<>|;,)\]]*|(?<![A-Za-z])[A-Za-z]:\\[^\s'"`<>|;,)\]]+/g;

/** A folder as it was given and as the system resolves it, since an error may name either. */
function spellings(root: string): string[] {
  const given = root.replace(/[\\/]+$/, "");
  if (!given) return [];
  try {
    const real = realpathSync(given);
    return real === given ? [given] : [given, real];
  } catch {
    return [given];
  }
}

/** Paths under one of the folders become relative to it; every other absolute path is taken out. */
export function withoutServerPaths(message: string, roots: string[] = []): string {
  if (!/[\\/]/.test(message)) return message;
  let text = message;
  const folders = roots.flatMap(spellings).toSorted((a, b) => b.length - a.length);
  for (const folder of folders) {
    const exact = folder.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    text = text
      .replace(new RegExp(`${exact}[\\\\/](?=[^\\s'"\`])`, "g"), "")
      .replace(new RegExp(`${exact}[\\\\/]?(?![\\w.-])`, "g"), "the site's folder");
  }
  text = text.replace(ABSOLUTE, ELSEWHERE);
  return text.startsWith("the site's folder") ? `T${text.slice(1)}` : text;
}
