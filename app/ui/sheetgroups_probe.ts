// node app/ui/sheetgroups_probe.ts — the side column's tab groups and the
// ⌘⇧ letter keys that jump between them (sheetgroups.ts), with no DOM, and
// that sheet.ts and shell.rs agree on those keys. Node runs this file as TypeScript.
import { readFileSync } from "node:fs";
import { face, GROUPS, groupOf, jump, ordered, WAKE } from "./sheetgroups.ts";
import { placeFor } from "./linkroute.ts";

const checks: [string, boolean, string?][] = [];
const ok = (name: string, cond: boolean, detail = "") => checks.push([name, cond, detail]);

const t = (key: string, kind: string, waiting = false) => ({ key, kind, waiting });
const asks2 = () => [t(WAKE, WAKE), t("/ask/old", "ask"), t("/ask/now", "ask", true)];
const tabs = [t(WAKE, WAKE), t("/ask/1", "ask", true), t("/review/a", "review"), t("/plan/x", "plan"), t("f.png", "file"), t("/review/b", "review"), t("/agent/s/1", "agent")];

{
  ok("groups: plans, reviews and asks are their own; everything else is other",
    groupOf("plan") === "plan" && groupOf("scenarios") === "plan" && groupOf("review") === "review" && groupOf("ask") === "ask"
      && ["file", "web", "agent", "run", "agents", "page"].every((k) => groupOf(k) === "other") && groupOf(WAKE) === WAKE);
  const keys = ordered(tabs).map((x) => x.key);
  ok("order: the Wake, then plan, lookout, ask, other, each in the order it came",
    JSON.stringify(keys) === JSON.stringify([WAKE, "/plan/x", "/review/a", "/review/b", "/ask/1", "f.png", "/agent/s/1"]), JSON.stringify(keys));
  ok("groups: each has its own letter", new Set(GROUPS.map((g) => g.key)).size === GROUPS.length);
}

{
  ok("jump: from elsewhere, to the group's first", jump(tabs, "review", WAKE, "") === "/review/a");
  ok("jump: pressed again, on to the next in the group", jump(tabs, "review", "/review/a", "") === "/review/b");
  ok("jump: and round to the first", jump(tabs, "review", "/review/b", "") === "/review/a");
  ok("jump: from elsewhere, back to the one last picked there", jump(tabs, "review", "/plan/x", "/review/b") === "/review/b");
  const asks = [t(WAKE, WAKE), t("/ask/old", "ask"), t("/ask/now", "ask", true)];
  ok("jump: one waiting on you beats the one last picked", jump(asks, "ask", WAKE, "/ask/old") === "/ask/now");
  ok("jump: pressed again on the waiting one, on round the group", jump(asks, "ask", "/ask/now", "/ask/old") === "/ask/old");
  const mixed = [t(WAKE, WAKE), t("/ask/w1", "ask", true), t("/ask/done", "ask"), t("/ask/w2", "ask", true)];
  ok("jump: pressed again, on to the next one waiting, past an answered one", jump(mixed, "ask", "/ask/w1", "") === "/ask/w2");
  ok("jump: after the waiting ones, the rest", jump(mixed, "ask", "/ask/w2", "") === "/ask/done");
  ok("jump: and from the rest, round to the first waiting", jump(mixed, "ask", "/ask/done", "") === "/ask/w1");
  ok("jump: on the only waiting one, on to the others in order", jump(asks2(), "ask", "/ask/now", "") === "/ask/old");
  ok("jump: a last pick that closed falls back to the first", jump(tabs, "review", WAKE, "/review/gone") === "/review/a");
  const two = [...tabs, t("/ask/2", "ask", false)];
  ok("jump: with no last pick, one that waits on you first", jump([t(WAKE, WAKE), t("/ask/0", "ask"), ...two.slice(1)], "ask", WAKE, "") === "/ask/1");
  ok("jump: an empty group goes nowhere", jump([t(WAKE, WAKE)], "plan", WAKE, "") === "");
  ok("jump: a group of one stays on it", jump(tabs, "plan", "/plan/x", "") === "/plan/x");
  ok("jump: other takes files, pages and agents", jump(tabs, "other", "f.png", "") === "/agent/s/1");
}

{
  ok("face: the active tab when it is in the group", face(tabs, "review", "/review/b", "/review/a") === "/review/b");
  ok("face: else the last picked there", face(tabs, "review", WAKE, "/review/b") === "/review/b");
  ok("face: one waiting on you before the last picked", face(asks2(), "ask", WAKE, "/ask/old") === "/ask/now");
  ok("face: else the first", face(tabs, "review", WAKE, "") === "/review/a");
  ok("face: none for an empty group", face([t(WAKE, WAKE)], "plan", WAKE, "") === "");
}

{
  const shell = readFileSync(new URL("../crates/seamux-app/src/shell.rs", import.meta.url), "utf8");
  const sheet = readFileSync(new URL("./sheet.ts", import.meta.url), "utf8");
  for (const g of GROUPS) {
    ok(`keys: shell.rs registers ⌘⇧${g.key} as group:${g.id}`, shell.includes(`("CmdOrCtrl+Shift+Key${g.key}", "group:${g.id}")`));
  }
  ok("keys: shell.rs registers ⌘⇧E to hide the side column", shell.includes(`("CmdOrCtrl+Shift+KeyE", "hide")`));
  ok("keys: the sheet no longer picks tabs with bare 1–9", !/e\.key >= "1" && e\.key <= "9"/.test(sheet));
  // A page opens beside its pane, never over the stage: one sheet, the Dock's.
  const ui = (f: string) => readFileSync(new URL(`./${f}`, import.meta.url), "utf8");
  const makers = ["dock.ts", "main.ts", "wake.ts", "panelinks.ts", "palette.ts", "review.ts", "sheet.ts"].filter((f) => /new Sheet\(/.test(ui(f)));
  ok("one sheet: only the Dock makes one, and nothing makes an overlay", JSON.stringify(makers) === '["dock.ts"]' && !/export function (sheet|openPage)\(/.test(sheet), JSON.stringify(makers));
  ok("one sheet: the Wake opens through the sheet it is a tab of", /constructor\(readonly root: HTMLElement, private host: Sheet\)/.test(ui("wake.ts")) && !/\bsheet\(\)/.test(ui("wake.ts")));
  ok("one sheet: a lookout page framed beside the terminal opens its GitHub links in the browser, from its own frame and origin only",
    /d\.lookout !== "open"/.test(sheet) && /\^https:\\\/\\\/github\\\.com\\\//.test(sheet) &&
    /x\.contentWindow === e\.source/.test(sheet) && /e\.origin !== new URL\(f\.src, location\.href\)\.origin/.test(sheet));
  ok("one sheet: a pane's link goes to the Dock's column, bringing the Dock forward", /seamux:show-dock/.test(sheet) && /seamux:show-dock/.test(ui("main.ts")));
  ok("order: every tab opened here goes through addTab, so ⌘] steps in the strip's order", !/this\.tabs\.push\(/.test(sheet) && /this\.tabs = ordered\(/.test(sheet));
  // Another workspace starts its Wake without the last one's preview.
  const wk = ui("wake.ts");
  const showDir = wk.slice(wk.indexOf("  showDir("), wk.indexOf("  clearPreview("));
  const picker = wk.slice(wk.indexOf('this.picker.addEventListener("change"'), wk.indexOf('this.q.type = "search"'));
  const reset = sheet.slice(sheet.indexOf("  private reset(): void {"), sheet.indexOf("  private syncTabs(): void {"));
  ok("preview: a workspace change clears it (the Dock's pick, the Wake's own picker)",
    /dir !== this\.ws\) \{\s*this\.clearPreview\(\)/.test(showDir) && /this\.clearPreview\(\)/.test(picker) && /this\.wake\?\.clearPreview\(\)/.test(reset));
  // One word, one place: the top bar's Lookout runs reviews everywhere; the chip is this workspace's.
  ok("names: the review chip says Review, not the top bar's Lookout", GROUPS.find((g) => g.id === "review")?.label === "Review");
  const tabs = readFileSync(new URL("./tabs.ts", import.meta.url), "utf8");
  ok("names: the top bar has no Wake view; the Dock's strip is the Wake",
    !/\{ id: "wake"/.test(tabs) && !/id="wake"/.test(readFileSync(new URL("./index.html", import.meta.url), "utf8")));
}

// A link opens in the workspace it belongs to (linkroute.ts placeFor).
{
  const panes = [
    { workspace: "api", cwd: "/t/coupons-api", agent: "claude" },
    { workspace: "api-shell", cwd: "/t/coupons-api", agent: null },
    { workspace: "docs", cwd: "/t/coupons-api/docs", agent: null },
    { workspace: "ui", cwd: "/t/coupons-ui/", agent: "claude" },
  ];
  const pages = [
    { ws: "api", path: "/plan/demo-coupons" },
    { ws: "search", path: "/review/rv-41" },
  ];
  ok("place: a page belongs to the workspace that has it open", placeFor({ page: "/plan/demo-coupons" }, panes, pages) === "api");
  ok("place: a page's query does not change whose it is", placeFor({ page: "/review/rv-41?t=ab12" }, panes, pages) === "search");
  ok("place: a page nobody has open belongs to nobody", placeFor({ page: "/plan/elsewhere" }, panes, pages) === undefined);
  ok("place: a file belongs to the pane whose folder holds it, an agent's first", placeFor({ file: "/t/coupons-api/src/a.ts" }, panes, pages) === "api");
  ok("place: the deepest folder wins", placeFor({ file: "/t/coupons-api/docs/x.md" }, panes, pages) === "docs");
  ok("place: a trailing slash on a pane's folder still holds its files", placeFor({ file: "/t/coupons-ui/notes.md" }, panes, pages) === "ui");
  ok("place: a sibling folder with the same prefix is not inside", placeFor({ file: "/t/coupons-api-old/a.ts" }, panes, pages) === undefined);
  const sheet = readFileSync(new URL("./sheet.ts", import.meta.url), "utf8");
  ok("place: linkSheet asks the link's own place before the Dock's, and moves the Dock there",
    /docked\.placeOfLink\(target\) \?\? place\.workspace/.test(sheet) && /docked\.goTo\(own\)/.test(sheet) && /this\.onPlace\(ws\)/.test(sheet));
  const main = readFileSync(new URL("./main.ts", import.meta.url), "utf8");
  ok("place: a link that opens puts the Bosun's drop-down away", /seamux:show-dock[\s\S]{0,120}bosunView\.setDrop\(false\)/.test(main));
}

let failed = 0;
for (const [name, pass, detail] of checks) {
  if (!pass) failed++;
  console.log(`  ${pass ? "ok  " : "FAIL"} ${name}${pass || !detail ? "" : `\n       ${detail}`}`);
}
console.log(`sheetgroups probe: ${checks.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
