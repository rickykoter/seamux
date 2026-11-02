// A bug source pasted into the New workspace prompt: a GitHub issue, PR or
// Actions run link, a Jira browse link, or on its own a #42 or PROJ-9. The
// card only reads the text; the new session's first message asks deep-plan
// to run `deep-plan intake` on the link, which does the fetching.
//
// The patterns mirror deep-plan's parseLink (deep-plan/lib/intake.mjs). Keep
// them in step: a link this accepts and intake refuses starts a session on
// an error.

export type SourceKind = "issue" | "pr" | "run" | "jira";

export interface Source {
  kind: SourceKind;
  /** The issue, PR or run number, or the Jira key. */
  n: string;
  /** owner/name, or "" for a bare #42 (the current repo) and for Jira. */
  repo: string;
  /** What intake is given: the URL, or the bare #42 / PROJ-9. */
  link: string;
  /** What the card shows: "GitHub issue #42 · o/r". */
  label: string;
  /** The branch the placeholder suggests: fix-issue-42. */
  branch: string;
  /** The prompt without the link, trimmed. */
  rest: string;
}

const GH = String.raw`^https?:\/\/github\.com\/([^/\s]+\/[^/\s]+)`;
const ISSUE = new RegExp(GH + String.raw`\/issues\/(\d+)`);
const PULL = new RegExp(GH + String.raw`\/pull\/(\d+)`);
const RUN = new RegExp(GH + String.raw`\/actions\/runs\/(\d+)(?:\/job\/(\d+))?`);
const JIRA_URL = /^https?:\/\/[^/\s]+\/browse\/([A-Z][A-Z0-9]+-\d+)/;
// The # is required here, though intake also takes a bare 42: a prompt of
// just "2024" is more likely prose than an issue.
const BARE_ISSUE = /^#(\d+)$/;
const BARE_JIRA = /^([A-Z][A-Z0-9]+-\d+)$/;

const URLS = /https?:\/\/\S+/g;
/** A markdown link, [label](url): it reads as its label plus the URL. */
const MD_LINK = /\[([^\]\n]*)\]\((https?:\/\/[^)\s]+)\)/g;
/** Sentence punctuation stuck to the end of a pasted URL. */
const TAIL = /[)\]>.,;:!?'"]+$/;

function make(kind: SourceKind, n: string, repo: string, link: string, rest: string): Source {
  const where = repo || "this repo";
  const label =
    kind === "issue" ? `GitHub issue #${n} · ${where}` :
    kind === "pr" ? `GitHub PR #${n} · ${where}` :
    kind === "run" ? `GitHub Actions run ${n} · ${where}` :
    `Jira ${n}`;
  return { kind, n, repo, link, label, branch: `fix-${kind === "jira" ? n.toLowerCase() : `${kind}-${n}`}`, rest };
}

function fromUrl(url: string, rest: string): Source | null {
  let m: RegExpExecArray | null;
  if ((m = ISSUE.exec(url))) return make("issue", m[2], m[1], url, rest);
  if ((m = PULL.exec(url))) return make("pr", m[2], m[1], url, rest);
  if ((m = RUN.exec(url))) return make("run", m[2], m[1], url, rest);
  if ((m = JIRA_URL.exec(url))) return make("jira", m[1], "", url, rest);
  return null;
}

/**
 * The first source in the prompt, or null. A URL counts anywhere in the
 * text; a bare #42 or PROJ-9 only when it is the whole prompt, so prose that
 * mentions an issue stays prose.
 */
export function parseSource(text: string): Source | null {
  const s = text.trim().replace(MD_LINK, "$1 $2");
  let m: RegExpExecArray | null;
  if ((m = BARE_ISSUE.exec(s))) return make("issue", m[1], "", s, "");
  if ((m = BARE_JIRA.exec(s))) return make("jira", m[1], "", s, "");
  for (const hit of s.matchAll(URLS)) {
    const url = hit[0].replace(TAIL, "");
    const at = hit.index ?? 0;
    // The punctuation stuck to the link goes with it: "see <url>, it flakes" -> "see it flakes".
    const rest = (s.slice(0, at) + s.slice(at + hit[0].length)).replace(/[ \t]{2,}/g, " ").trim();
    const found = fromUrl(url, rest);
    if (found) return found;
  }
  return null;
}

/** The new session's first message: the bug lane on the link, then the rest of the prompt. */
export function firstMessage(source: Source): string {
  const ask = `/deep-plan Run deep-plan intake on ${source.link} to gather the bug, then plan its fix in the bug lane.`;
  return source.rest ? `${ask}\n\n${source.rest}` : ask;
}
