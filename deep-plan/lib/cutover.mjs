// The portable cutover bundle: what you park in a tracker so another session —
// or another person, months later — can pick the work up cold.
//
//   <slug>.epic.html   the whole plan as ONE self-contained file. Diagrams
//                      render with no network; the quiz is stripped.
//   NN-<title>.md      one per increment. Paste into a child task.
//   README.md          what goes where.
//
// Increments are `spec.deliverables`, and the NN prefix is array position —
// never a parse of the title. Real plans title theirs "Inc 1", "Inc 2",
// "Inc 2b", "Inc 3 — client cutover", so sorting on the label would be wrong
// and position is the only stable key.
//
// THE QUIZ AND THE ANSWER KEY NEVER ENTER THIS BUNDLE. Both carry the answers,
// and a directory you attach to a ticket is the worst possible place for them.
// A probe assertion holds that line, because the bundle is built from the same
// spec that contains the quiz — the exclusion is a choice, not a side effect.

const esc = s => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;")
  .replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// Pipes inside a cell would end it. Only markdown tables need this.
const cell = s => String(s ?? "").replace(/\|/g, "\\|").replace(/\n+/g, " ").trim();

const table = (head, rows) =>
  [`| ${head.join(" | ")} |`, `|${head.map(() => "---").join("|")}|`,
    ...rows.map(r => `| ${r.join(" | ")} |`)].join("\n");

// Both shapes occur on real specs, exactly as elsewhere in this engine.
const commitText = c => typeof c === "string"
  ? c
  : `${c.sha ? String(c.sha).slice(0, 12) + " " : ""}${c.subject || c.ref || ""}`.trim();

export function kebab(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "").slice(0, 60) || "increment";
}

export function incrementFileNames(spec) {
  return (spec.deliverables || []).map((d, i) =>
    `${String(i + 1).padStart(2, "0")}-${kebab(d.title)}.md`);
}

// One self-contained page. `body` is the caller's rendered plan body, so the
// epic shows the same content as every other surface rather than a second
// spelling of it that can drift.
export function epicHtml({ spec, body, b64, hasDiagrams }) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(spec.title)}</title>
<style>
:root{color-scheme:light dark;--bg:#fff;--fg:#111;--dim:#666;--line:#ddd;--card:#fafafa;--card2:#f4f4f4}
@media (prefers-color-scheme:dark){
  :root{--bg:#16181d;--fg:#e8e8ea;--dim:#9aa0a6;--line:#2c3038;--card:#1c1f26;--card2:#22262e}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);
  font:15px/1.65 system-ui,-apple-system,"Segoe UI",sans-serif}
.wrap{max-width:920px;margin:0 auto;padding:32px 24px 64px}
h1{font-size:25px;line-height:1.3;margin:0 0 4px}
h2{font-size:17px;margin:28px 0 8px;padding-bottom:5px;border-bottom:1px solid var(--line)}
p{margin:0 0 10px}
code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12.5px;
  background:var(--card2);padding:1px 4px;border-radius:4px}
ul,ol{margin:0 0 12px;padding-left:22px}
li{margin:0 0 5px}
.dim{color:var(--dim)}
.sub{color:var(--dim);font-size:13px;margin:0 0 20px}
.inc{border:1px solid var(--line);border-radius:8px;padding:12px;margin:12px 0;background:var(--card)}
.mermaid{background:var(--card2);border:1px solid var(--line);border-radius:8px;
  padding:12px;margin:12px 0;overflow-x:auto}
table{border-collapse:collapse;width:100%;margin:0 0 12px;font-size:14px}
th,td{text-align:left;vertical-align:top;padding:7px 9px;border:1px solid var(--line)}
th{background:var(--card2);font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:var(--dim)}
</style></head>
<body><div class="wrap">
<p class="sub">Parked plan, self-contained: diagrams render with no network, and
the alignment check is deliberately not in this file. Each increment below has
its own file in this bundle carrying the same context.</p>
${body}
</div>
${hasDiagrams ? `<script src="data:text/javascript;base64,${b64}"></script>
<script>mermaid.initialize({startOnLoad:true,theme:
  window.matchMedia&&matchMedia("(prefers-color-scheme: dark)").matches?"dark":"default"});</script>` : ""}
</body></html>`;
}

// One increment, as a standalone brief.
//
// Context, decisions, verified facts and non-goals are repeated in EVERY
// increment file, deliberately. A child task is read on its own, by someone who
// will not open the epic first — deduplicating the context is precisely what
// makes handoff docs useless.
export function incrementMd({ spec, index, total }) {
  const d = (spec.deliverables || [])[index] || {};
  const out = [];
  out.push(`# ${spec.title} — Increment ${index + 1} of ${total}: ${d.title || ""}`, "");
  out.push("> Parked context for a fresh session. Everything needed to start this",
    "> increment cold is in this file — you should not need the epic.", "");

  if (spec.context) out.push("## Why this exists", "", String(spec.context).trim(), "");

  if ((spec.decisions || []).length) {
    out.push("## Decisions locked", "");
    out.push("These are settled. Do not re-litigate them; if one looks wrong, say so",
      "before writing code.", "");
    out.push(table(["Decision", "Why"],
      spec.decisions.map(x => [cell(x.decision), cell(x.why)])), "");
  }
  if ((spec.verifiedFacts || []).length) {
    out.push("## Verified facts this rests on", "");
    out.push(table(["Claim", "Evidence"],
      spec.verifiedFacts.map(f => [cell(f.claim), "`" + cell(f.evidence) + "`"])), "");
  }
  if ((spec.nonGoals || []).length) {
    out.push("## Out of scope", "");
    for (const g of spec.nonGoals) out.push(`- ${typeof g === "string" ? g : g.nonGoal || ""}`);
    out.push("");
  }

  out.push(`## This increment — ${d.title || ""}`, "");
  if (d.body) out.push(String(d.body).trim(), "");
  if ((d.files || []).length) {
    out.push("### Files", "");
    for (const f of d.files) out.push(`- \`${f}\``);
    out.push("");
  }
  // Only when the spec attributes commits to THIS increment. Absent, the
  // plan-wide list belongs to the epic, and repeating all of it here would
  // misstate this task's scope.
  if ((d.commits || []).length) {
    out.push("## Commits", "");
    d.commits.forEach((c, i) => out.push(`${i + 1}. \`${commitText(c)}\``));
    out.push("");
  }
  if ((d.observability && d.observability.checks || []).length) {
    out.push("## Observability — this increment is not done until these pass", "");
    for (const c of d.observability.checks) {
      out.push(`- **[${c.system || "?"}] ${c.name || ""}**`);
      if (c.query) out.push(`  - query: \`${c.query}\``);
      if (c.expect) out.push(`  - expect: ${c.expect}`);
      if (c.note) out.push(`  - note: ${c.note}`);
    }
    out.push("");
  }

  // Per-increment verification when the spec has it, else the plan-wide list
  // with a warning — an unqualified whole-change checklist read as this task's
  // definition of done is how an increment gets called finished early.
  const own = (d.verification || []).length;
  const ver = own ? d.verification : (spec.verification || []);
  if (ver.length) {
    out.push("## Verification", "");
    if (!own) out.push("_Whole-change verification; not all of it applies to this increment alone._", "");
    for (const v of ver) out.push(`- ${v}`);
    out.push("");
  }
  if ((spec.risks || []).length) {
    out.push("## Risks and things to confirm", "");
    for (const r of spec.risks) {
      const o = typeof r === "string" ? { risk: r } : r;
      const d = o.disposition ? ` — ${o.disposition}${o.deliverableRef ? ": " + o.deliverableRef :
        o.ticketRef ? ": ticket " + o.ticketRef + (o.note ? " — " + o.note : "") : o.note ? ": " + o.note : ""}` : "";
      out.push(`- ${o.risk || ""}${d}`);
    }
    out.push("");
  }

  out.push("## Regenerating the full plan", "");
  out.push("The archived spec is the source of truth. To get the diagrams, the",
    "alignment check and the review surface back:", "");
  out.push("```bash", `deep-plan rehydrate ${spec.slug}`, "```", "");
  return out.join("\n");
}

export function bundleReadme({ spec, files }) {
  const out = [];
  out.push(`# ${spec.title} — cutover bundle`, "");
  out.push("How to park this:", "");
  out.push(`1. Create the epic. Attach **\`${spec.slug}.epic.html\`** — one`);
  out.push("   self-contained file; diagrams render offline and it carries no quiz.");
  out.push("2. Create one child task per increment and paste the matching file as");
  out.push("   its description. Each is written to be read alone.");
  out.push("");
  out.push(table(["Increment", "File"], files.map((f, i) => [
    `${i + 1}. ${cell(((spec.deliverables || [])[i] || {}).title)}`,
    "`" + f + "`",
  ])), "");
  out.push("The answer key and the alignment check are deliberately absent — both",
    "carry the answers, so they stay in the keys tree and never travel.", "");
  out.push("To rebuild everything, including the review surface:", "");
  out.push("```bash", `deep-plan rehydrate ${spec.slug}`, "```", "");
  return out.join("\n");
}
