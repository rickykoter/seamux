// node app/ui/bang_probe.ts — a pane's `!` commands and Claude's prompt
// (bang.ts), and where its links go (linkroute.ts), with no DOM. Node runs
// this file as TypeScript.
import { findBangs, findPrompt } from "./bang.ts";
import { DOCK_FILE, route } from "./linkroute.ts";

const checks: [string, boolean, string?][] = [];
const ok = (name: string, cond: boolean, detail = "") => checks.push([name, cond, detail]);
const cmds = (text: string, style?: string[]) => findBangs(text, style).map((b) => b.cmd);
/** A style per character: `code` marks the [from, to) span as inline code. */
const styled = (text: string, from: number, to: number) => [...text].map((_, i) => (i >= from && i < to ? "code" : "plain"));

// ---- `!` commands ---------------------------------------------------------
{
  const t = "Run `! gh auth login` to sign in.";
  ok("bang: a backticked command, up to its backtick", cmds(t).join() === "gh auth login", cmds(t).join());
  const b = findBangs(t)[0];
  ok("bang: its span covers the quotes", t.slice(b.start, b.end) === "`! gh auth login`", t.slice(b.start, b.end));
}
ok("bang: quoted without a space", cmds("type '!ls -la' here").join() === "ls -la");
{
  // Claude draws inline code in a colour and drops the backticks.
  const t = "please type ! gh auth login in the prompt";
  const s = styled(t, 12, 28);
  ok("bang: inline code ends where its colour does", cmds(t, s).join() === "gh auth login", cmds(t, s).join());
  ok("bang: plain text mid-sentence is not a command", cmds(t).length === 0, cmds(t).join());
}
ok("bang: a line of its own is the rest of the row", cmds("    ! npm install --save-dev vite").join() === "npm install --save-dev vite");
ok("bang: a list item's", cmds("  - ! cargo test").join() === "cargo test");
ok("bang: a closing full stop is not the command's", cmds("! make check.").join() === "make check");
ok("bang: exclamations in prose are not commands", cmds("Done! That worked!").length === 0 && cmds("Great!! Next").length === 0);
ok("bang: a `!` with nothing after is not a command", cmds("  ! ").length === 0 && cmds("! !").length === 0);
ok("bang: a box's side is not the command's", cmds("│ ! ls -la            │").join() === "ls -la", cmds("│ ! ls -la            │").join());
ok("bang: two on a row", cmds("either `! a` or `! b c`").join("|") === "a|b c");
ok("bang: an overlong command is not offered", cmds("! " + "x".repeat(400)).length === 0);

// ---- Claude's prompt ------------------------------------------------------
const rule = "─".repeat(40);
{
  const p = findPrompt(["output", rule, "> ", rule, "  ? for shortcuts"]);
  ok("prompt: an empty one", p.kind === "empty" && p.kind !== "none" && p.row === 2, JSON.stringify(p));
}
{
  const p = findPrompt(["x", rule, "❯ ", rule, "  ⏵⏵ auto mode on"]);
  ok("prompt: Claude Code 2's ❯", p.kind === "empty" && p.kind !== "none" && p.row === 2, JSON.stringify(p));
}
{
  const p = findPrompt(["x", rule, "❯ fix the tests", rule]);
  ok("prompt: a draft", p.kind === "draft" && "text" in p && p.text === "fix the tests", JSON.stringify(p));
}
{
  const p = findPrompt(["x", rule, '> Try "refactor foo"', rule], [-1, -1, 2, -1]);
  ok("prompt: a dim placeholder is empty", p.kind === "empty", JSON.stringify(p));
}
{
  const p = findPrompt(["x", rule, "! git status", rule]);
  ok("prompt: bash mode", p.kind === "bash" && "text" in p && p.text === "git status", JSON.stringify(p));
}
{
  const box = "╭" + "─".repeat(38) + "╮";
  const p = findPrompt(["x", box, "│ ! ls -la                            │", "╰" + "─".repeat(38) + "╯"]);
  ok("prompt: in a box", p.kind === "bash" && "text" in p && p.text === "ls -la", JSON.stringify(p));
}
ok("prompt: none on screen", findPrompt(["$ ls", "a b c"]).kind === "none");
{
  // A `>` quote in Claude's reply is not under a rule; the prompt below is.
  const p = findPrompt([rule, "> quoted", "more", rule, "> ", rule]);
  ok("prompt: the bottom one", p.kind === "empty" && p.kind !== "none" && p.row === 4, JSON.stringify(p));
}

// ---- links ----------------------------------------------------------------
const intent = "http://127.0.0.1:7777";
ok("link: a plan on the intent server is a page", route("http://127.0.0.1:7777/plan/x", intent) === "page");
ok("link: localhost names the intent server too", route("http://localhost:7777/review/r1", intent) === "page");
ok("link: lookout's own port, with its token, is a page", route("http://127.0.0.1:9123/review/r1?t=abc", intent) === "page");
ok("link: a dev server's /review is its own", route("http://localhost:3000/review/5", intent) === "local");
ok("link: agent and run pages are pages", route(`${intent}/agent/s/a1`, intent) === "page" && route(`${intent}/runs/s`, intent) === "page");
ok("link: a dev server opens in the Dock", route("http://localhost:5173/", intent) === "local" && route("http://0.0.0.0:8000", intent) === "local");
ok("link: [::1] is local", route("http://[::1]:8080/x", intent) === "local");
ok("link: the web is the browser's", route("https://github.com/a/b/pull/1", intent) === "browser" && route("https://localhost.example.com/", intent) === "browser");
ok("link: a file URL is a file", route("file:///tmp/a.png", intent) === "file");
ok("link: no intent server, a plan link is a dev page", route("http://127.0.0.1:7777/plan/x", null) === "local");
ok("link: the Dock shows images, PDFs and Markdown", ["a.png", "b.JPG", "c.pdf", "README.md"].every((f) => DOCK_FILE.test(f)) && !DOCK_FILE.test("main.rs") && !DOCK_FILE.test("x.md.rs"));

let bad = 0;
for (const [name, pass, detail] of checks) {
  if (!pass) bad++;
  console.log(`${pass ? "ok  " : "FAIL"} ${name}${pass || !detail ? "" : ` — ${detail}`}`);
}
console.log(`\n${checks.length - bad}/${checks.length} passed`);
process.exit(bad ? 1 : 0);
