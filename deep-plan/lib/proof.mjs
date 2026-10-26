// PR proof from passed browser runs: the run's animated replay, one
// annotated key frame per step() with its label as the caption, and
// proof.md, markdown a PR description can carry. Built under
// ~/.claude/plans/<slug>.proof/ and never committed: `deep-plan proof
// --attach` puts it on the PR through `gh pr edit --attach` (gh 2.99+), which
// uploads each file and rewrites the markdown's ./file references to the
// uploaded copies.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export const OPEN = "<!-- deep-plan proof -->";
export const CLOSE = "<!-- /deep-plan proof -->";

const onPath = bin => String(process.env.PATH || "").split(path.delimiter)
  .some(d => d && fs.existsSync(path.join(d, bin)));

// A GIF and an MP4 of the replay, when ffmpeg is on PATH. Returns the names
// made. The APNG stays the default: GitHub renders it without either.
function convert(dir, apng, base) {
  if (!onPath("ffmpeg")) return [];
  const made = [];
  const ff = (args, out) => {
    const r = spawnSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "apng", "-i", apng, ...args, out],
      { cwd: dir, encoding: "utf8", timeout: 60000 });
    if (r.status === 0 && fs.existsSync(path.join(dir, out))) made.push(out);
  };
  ff(["-vf", "fps=8,scale=960:-1:flags=lanczos"], `${base}.gif`);
  ff(["-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2", "-pix_fmt", "yuv420p"], `${base}.mp4`);
  return made;
}

// A step label or a check name is the repo's text: inert in markdown, one line.
const mdText = s => String(s || "").replace(/[\r\n]+/g, " ").replace(/([\\`*_[\]<>#|!])/g, "\\$1");

// Build the proof directory from runs: [{ n, id, name, dir (abs evidence
// dir), ev (readEvidence) }]. Returns { dir, md, files } — files are the
// names inside dir that proof.md references (what --attach uploads).
export function buildProof(slug, out, runs, { title = "" } = {}) {
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  const files = [];
  const parts = [OPEN, `### Proof${title ? `: ${mdText(title)}` : ""}`, ""];
  for (const r of runs) {
    const base = `${r.n}-${String(r.id).replace(/[^a-z0-9._-]+/gi, "_")}`;
    parts.push(`#### ${mdText(r.name || r.id)} — increment ${r.n}`, "");
    if (r.ev.animation) {
      const apng = `${base}-replay.png`;
      fs.copyFileSync(path.join(r.dir, r.ev.animation), path.join(out, apng));
      const made = convert(out, apng, base);
      const gif = made.find(f => f.endsWith(".gif"));
      const shown = gif || apng;
      files.push(shown);
      parts.push(`![${mdText(r.name || r.id)}: the whole run](./${shown})`, "");
    }
    let k = 0;
    for (const s of r.ev.steps || []) {
      k++;
      if (!s.key || !fs.existsSync(path.join(r.dir, s.key))) continue;
      const name = `${base}-${String(k).padStart(2, "0")}.png`;
      fs.copyFileSync(path.join(r.dir, s.key), path.join(out, name));
      files.push(name);
      parts.push(`${k}. **${mdText(s.label)}**${s.status === "fail" ? " (failed here)" : ""}`, "",
        `   ![${mdText(s.label)}](./${name})`, "");
    }
  }
  parts.push(CLOSE);
  const md = parts.join("\n") + "\n";
  fs.writeFileSync(path.join(out, "proof.md"), md);
  return { dir: out, md, files };
}

// The PR body with its proof section replaced, or the section appended.
export function withProof(body, md) {
  const b = String(body || "");
  const i = b.indexOf(OPEN), j = b.indexOf(CLOSE);
  const section = md.trim();
  if (i >= 0 && j > i) return b.slice(0, i) + section + b.slice(j + CLOSE.length);
  return (b.trim() ? b.replace(/\s+$/, "") + "\n\n" : "") + section + "\n";
}

// Does this gh upload files into a PR body? `--attach` arrived in 2.99.
export function ghCanAttach() {
  const r = spawnSync("gh", ["pr", "edit", "--help"], { encoding: "utf8", timeout: 20000 });
  return r.status === 0 && /--attach\b/.test((r.stdout || "") + (r.stderr || ""));
}

export function gh(args, { cwd } = {}) {
  const r = spawnSync("gh", args, { cwd, encoding: "utf8", timeout: 180000 });
  return { ok: r.status === 0, out: (r.stdout || "").trim(), err: (r.stderr || "").trim() };
}
