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

