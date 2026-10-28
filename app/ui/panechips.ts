// The marks a pane wears beside its name: [plan] on the pane that owns a
// deep-plan plan (deep-plan's owner pane), [outside] on a pane whose cwd has
// left its workspace's pinned worktree. Other Claudes in a planned worktree
// wear nothing. Each mark is a button that focuses its pane in cmux.
import { invoke } from "@tauri-apps/api/core";

/** What a pane's marks are drawn from: a wall tile or a timeline sub-row. */
export type Marked = { surface: string; owner?: string | null; outside?: boolean; root?: string };

/** Focus the pane in cmux and put the overlay away, as the wall's Jump does. */
export async function jumpTo(surface: string): Promise<void> {
  await invoke("wall_jump", { surfaceId: surface });
  await invoke("hide_overlay").catch(() => {});
}

function chip(cls: string, text: string, title: string, surface: string, inline: boolean): HTMLElement {
  // Inside a row that is itself a button, a nested button is invalid HTML:
  // the chip is a span there, and the row's own keys still reach the pane.
  const b = document.createElement(inline ? "span" : "button");
  if (b instanceof HTMLButtonElement) b.type = "button";
  b.className = `pane-chip ${cls}`;
  b.textContent = text;
  b.title = title;
  b.addEventListener("click", (e) => {
    e.stopPropagation();
    void jumpTo(surface).catch((err) => (b.title = `${title} (${String(err)})`));
  });
  return b;
}

/** The pane's chips, none when it has neither mark. `inline` draws them as
 *  spans, for a row that is itself a button. */
export function paneChips(p: Marked, inline = false): HTMLElement[] {
  const out: HTMLElement[] = [];
  if (p.owner) out.push(chip("plan", "plan", `This pane owns plan ${p.owner}: open it`, p.surface, inline));
  if (p.outside) out.push(chip("outside", "outside", `This pane's directory is outside the workspace's worktree${p.root ? ` (${p.root})` : ""}: open it`, p.surface, inline));
  return out;
}
