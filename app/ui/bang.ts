// `!` commands in a Claude pane, read from its rows with no DOM (bang_probe.ts
// checks them under node). Claude suggests one in its reply ("run
// `! gh auth login`"), and a `!` typed first in Claude's prompt is its bash
// mode. native.ts offers to run either: in the chat, or in the ⌘J shell.

/** A `!` command on a row: the text offsets it covers (the `!` included)
 *  and the command after it. */
export type Bang = { start: number; end: number; cmd: string };

/** What Claude's prompt holds: nothing (its placeholder at most), a draft,
 *  a bash-mode command, or no prompt found on screen. `row` is its 0-based
 *  row in the rows given. */
export type Prompt = { kind: "empty" | "draft" | "bash"; row: number; text: string } | { kind: "none" };

const MAX = 300;
/** What may come right before a `!` that starts a command. */
const LEAD = /[\s`'"(\[]/;
/** A command's first character. */
const FIRST = /[\w./~$-]/;
/** A rule line: Claude's prompt sits between two (or in a ╭─╮ box). */
const RULE = /^\s*[╭╰]?─{10,}[╮╯]?\s*$/;
const QUOTES: Record<string, string> = { "`": "`", "'": "'", '"': '"' };

/** A command as offered: trimmed, without the sentence's last full stop. */
function tidy(cmd: string): string {
  return cmd.trim().replace(/[.,;:]+$/, "").trim();
}

/** The `!` commands on one row of text. `style` gives each character's
 *  style (its colour), when known: an unquoted command is the run of text
 *  in the `!`'s own style, as Claude draws inline code. Plain text counts
 *  only when the `!` leads its row (a code block's line). */
export function findBangs(text: string, style?: readonly string[]): Bang[] {
  const out: Bang[] = [];
  // A box's side (│) is not the command's.
  const lineEnd = (() => {
    const b = text.indexOf("│", 1);
    return b > 0 ? b : text.length;
  })();
  for (let i = 0; i < lineEnd; i++) {
    if (text[i] !== "!") continue;
    const prev = i === 0 ? " " : text[i - 1];
    if (!LEAD.test(prev)) continue;
    const quote = QUOTES[prev];
    // `! cmd`, or `!cmd` only inside quotes (`!ls`).
    let from = i + 1;
    if (text[from] === " ") from++;
    else if (!quote) continue;
    if (!FIRST.test(text[from] ?? "")) continue;
    // Drawn in its own colour, as Claude draws inline code: that colour's
    // run is the command, wherever it sits on the row.
    const coded = !!style && style[i] !== undefined && style[i] !== plainOf(style, text);
    let end: number;
    if (quote) {
      // Quoted: up to the closing quote.
      end = text.indexOf(quote, from);
      if (end < 0 || end > lineEnd) continue;
    } else if (coded) {
      end = from;
      while (end < lineEnd && style![end] === style![i]) end++;
    } else if (/^\s*│?\s*(?:[-*•⎿]\s+)?$/.test(text.slice(0, i))) {
      // A line of its own (a code block's, a list item's): the rest of the row.
      end = lineEnd;
    } else continue;
    const cmd = tidy(text.slice(from, end));
    if (!cmd || cmd.length > MAX || !FIRST.test(cmd[0])) continue;
    // A whole row taken as a command must read as one: "! menu: hover …"
    // (a heading about `!`) starts with a word that ends a phrase.
    if (!quote && !coded && /[:,;]$/.test(cmd.split(/\s+/)[0])) continue;
    // The covered span ends where the command's text does.
    const stop = from + text.slice(from, end).indexOf(cmd) + cmd.length;
    out.push({ start: quote ? i - 1 : i, end: quote ? Math.min(end + 1, text.length) : stop, cmd });
    i = end;
  }
  return out;
}

/** The row's plain text's style: the terminal's default colour where the
 *  row has it (panelinks.ts keys a cell `<colour mode>:<colour>`, mode 0
 *  the default), else its most common style. */
function plainOf(style: readonly string[], text?: string): string {
  // The most common default-colour style among the row's shown characters:
  // a blank cell's style says nothing of the prose's.
  const shown = style.filter((s, i) => !text || (text[i] ?? " ").trim() !== "");
  const dflt = new Map<string, number>();
  for (const s of shown) if (s.startsWith("0:")) dflt.set(s, (dflt.get(s) ?? 0) + 1);
  if (dflt.size) return [...dflt].sort((a, b) => b[1] - a[1])[0][0];
  const n = new Map<string, number>();
  for (const s of style) n.set(s, (n.get(s) ?? 0) + 1);
  let best = "";
  let most = -1;
  for (const [s, c] of n) if (c > most) [best, most] = [s, c];
  return best;
}

/** Claude's prompt, found from the bottom: the first row under a rule line
 *  that starts with `❯` (`>` before Claude Code 2, `!` in bash mode), in or out of a ╭─╮ box.
 *  `dim` says, per row, from which text offset on everything is dim (the
 *  placeholder), or -1. */
export function findPrompt(rows: readonly string[], dim?: readonly number[]): Prompt {
  for (let r = rows.length - 1; r > 0; r--) {
    if (!RULE.test(rows[r - 1])) continue;
    const m = rows[r].match(/^(\s*│?\s*)([❯>!])\s?(.*?)\s*│?\s*$/);
    if (!m) continue;
    const at = m[1].length + 2;
    const d = dim?.[r] ?? -1;
    const text = (d >= 0 && d <= at ? "" : m[3]).replace(/ /g, " ").trim();
    if (m[2] === "!") return { kind: "bash", row: r, text };
    return { kind: text ? "draft" : "empty", row: r, text };
  }
  return { kind: "none" };
}
