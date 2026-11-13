// Where a pane's links and `!` commands go, decided with no DOM, so
// links_probe.ts can check it under node. panelinks.ts and bang.ts act on it.

/** Files the Dock shows itself (links_app.rs dock_kind); others go to VS Code. */
export const DOCK_FILE = /\.(png|jpe?g|gif|webp|svg|pdf|md|markdown)$/i;
/** seamux's pages, by path, wherever they are served. */
const SEAMUX_PAGE = /^\/(plan|review|ask|agent|run|runs)\/[^/]+/;
/** A page on this machine. */
const LOCAL = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(:\d+)?(\/|$|\?|#)/i;

/** Where a link goes: a file, a seamux page, another page on this machine
 *  (a dev server), or the browser. `intent` is the intent server's origin. */
export function route(uri: string, intent: string | null): "file" | "page" | "local" | "browser" {
  if (uri.startsWith("file://")) return "file";
  if (!LOCAL.test(uri)) return "browser";
  const u = new URL(uri.replace("//0.0.0.0", "//127.0.0.1"));
  const norm = uri.replace("//localhost:", "//127.0.0.1:");
  if (intent && norm.startsWith(intent + "/") && SEAMUX_PAGE.test(u.pathname)) return "page";
  // lookout serve's own port (its review link carries its token): the same
  // page the intent server proxies. A dev server's /review/ is its own.
  if (/^\/review\/[^/]+/.test(u.pathname) && u.searchParams.has("t")) return "page";
  return "local";
}


/** A character a path can break on: Claude wraps a long one mid-word. */
const PATH_CH = /[\w@.+~\/-]/;
/** How many rows a wrapped path may run on, each way. */
const WRAP_ROWS = 4;

/** Whether `top` ran into the right edge in the middle of a path that
 *  `next` carries on: `top` reaches within 3 columns of `cols`, its last
 *  word has a `/` and ends on a path character (prose that fills a row
 *  does not), and `next` starts (past its indent) with a path character. */
function wrapsInto(top: string, next: string, cols: number): boolean {
  const t = top.trimEnd();
  const n = next.trimStart();
  const word = t.slice(t.lastIndexOf(" ") + 1);
  // A list item's bullet ("- next") starts a line of its own, not a path's tail.
  if (/^[-*•+]\s/.test(n)) return false;
  return t.length >= cols - 3 && word.includes("/") && PATH_CH.test(t[t.length - 1] ?? "") && PATH_CH.test(n[0] ?? "");
}

/** Row `at` of `rows`, joined with the rows a path wrapped from or onto,
 *  as one line of text: `at` gives, per character, its row (an index into
 *  `rows`) and its offset in that row. A continuation row's indent is left
 *  out. `cols` is the terminal's width. */
export function joinWrapped(rows: readonly string[], at: number, cols: number): { text: string; at: { row: number; i: number }[] } {
  let first = at;
  while (first > 0 && at - first < WRAP_ROWS && wrapsInto(rows[first - 1], rows[first], cols)) first--;
  let last = at;
  while (last + 1 < rows.length && last - at < WRAP_ROWS && wrapsInto(rows[last], rows[last + 1], cols)) last++;
  let text = "";
  const pos: { row: number; i: number }[] = [];
  for (let r = first; r <= last; r++) {
    const row = r < last ? rows[r].trimEnd() : rows[r];
    const skip = r > first ? row.length - row.trimStart().length : 0;
    for (let i = skip; i < row.length; i++) {
      text += row[i];
      pos.push({ row: r, i });
    }
  }
  return { text, at: pos };
}
