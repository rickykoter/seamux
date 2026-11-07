// Golden files for the node probes: golden.py's twin (read it for the why).
//
//   import * as golden from "../tools/golden.mjs";
//   golden.expect("board/news-0.txt", text, { [tmp]: "<T>" })  // -> [ok, want]
//   golden.same("board/news-0.txt", text, { [tmp]: "<T>" })    // -> [ok, want]
//
// expect compares, or with CREW_GOLDEN=write records text instead; same only
// ever compares.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const DIR = join(dirname(fileURLToPath(import.meta.url)), "golden");

export function norm(text, subs = {}) {
  for (const k of Object.keys(subs).sort((a, b) => b.length - a.length)) {
    if (k) text = text.split(k).join(subs[k]);
  }
  return text;
}

export function same(name, text, subs = {}) {
  text = norm(text, subs);
  let want;
  try { want = readFileSync(join(DIR, name), "utf8"); }
  catch { return [false, `(no golden at ${join(DIR, name)}; CREW_GOLDEN=write records one)`]; }
  return [text === want, want];
}

export function expect(name, text, subs = {}) {
  if (process.env.CREW_GOLDEN === "write") {
    text = norm(text, subs);
    mkdirSync(dirname(join(DIR, name)), { recursive: true });
    writeFileSync(join(DIR, name), text);
    return [true, text];
  }
  return same(name, text, subs);
}
