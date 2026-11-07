// The Dock's board for the demo: this checkout's crew/board page with the
// shop cast inlined, the way board-preview.py builds it. Intent port 0, so a
// chip that would ask crew-board-intent does nothing; framed by the app, row
// clicks and the reclaim chip still post to it as the real board does.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { boardCast } from "./world.mjs";

const BOARD = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "crew", "board");

export function boardPage() {
  const read = (name) => readFileSync(join(BOARD, name), "utf8");
  const snap = boardCast(Math.floor(Date.now() / 1000));
  const data = JSON.stringify(snap).replace(/<\//g, "<\\/");
  const inject =
    "<script>\n" + read("render.js") + "\n" + read("intent.js") +
    // Whoever frames the demo board is the app: trust that origin, as the
    // real intent server trusts the app's (its frame-ancestors list), so the
    // board's "selected" handshake and the reclaim chip reach the app.
    "\nvar DEMO_PARENTS = (location.ancestorOrigins && location.ancestorOrigins.length) ? [location.ancestorOrigins[0]] : [];" +
    `\nvar SNAP = ${data};\n__boardRender(SNAP);\n__boardIntent({port: 0, token: "demo", parents: DEMO_PARENTS});\n</script>\n`;
  // A function, so "$&" and friends in render.js stay as they are.
  return read("board.html").replace("</body>", () => inject + "</body>");
}
