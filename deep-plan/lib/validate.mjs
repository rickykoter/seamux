// Surface validation: real mermaid parsing plus formatting lint, shared by
// `deep-plan render` (refuse-first, before any file is written) and
// `deep-plan validate <slug>` (re-check surfaces already on disk).
//
// Mermaid is validated with the vendored bundle itself — the same parser the
// page runs — loaded once under minimal DOM shims. No shims, no vendor file,
// or a bundle that will not load in this node degrade to "skip", never to a
// false pass/fail: the checks that CAN run still run.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import vm from "node:vm";

const VENDOR_CANDIDATES = [
  process.env.DEEP_PLAN_MERMAID ||
    path.join(path.dirname(new URL(import.meta.url).pathname), "..", "vendor", "mermaid.min.js"),
  path.join(os.homedir(), ".claude", "skills", "deep-plan", "vendor", "mermaid.min.js"),
];

let _mermaid; // undefined = not tried, null = unavailable
function loadMermaid() {
  if (_mermaid !== undefined) return _mermaid;
  const file = VENDOR_CANDIDATES.find(p => { try { return fs.existsSync(p); } catch { return false; } });
  if (!file) return (_mermaid = null);
  try {
    const noop = () => {};
    const el = () => ({
      style: {}, setAttribute: noop, appendChild: noop, insertBefore: noop,
      remove: noop, addEventListener: noop, getAttribute: () => null,
      classList: { add: noop, remove: noop },
    });
    // The bundle assumes browser globals and that top-level `var` is global —
    // vm.runInThisContext gives it both. The DOM shims below are exactly what
    // DOMPurify's support probe reads: document.nodeType === 9, a window
    // Element class with a real parentNode getter on its prototype, and
    // implementation.createHTMLDocument. Short of any one of these it exports
    // a stub with no addHook, and every diagram with a quoted label
    // "env-fails" — which silently skipped ALL realistic flowcharts on the
    // validator's first live run.
    class FakeNode {
      get parentNode() { return null; } get childNodes() { return []; }
      get nextSibling() { return null; } get nodeType() { return 1; }
      cloneNode() { return this; }
      appendChild(c) { return c; } removeChild(c) { return c; } insertBefore(c) { return c; }
    }
    class FakeElement extends FakeNode {
      get attributes() { return []; }
      setAttribute() {} getAttribute() { return null; }
      hasAttribute() { return false; } removeAttribute() {}
    }
    const fakeDoc = () => ({
      nodeType: 9, currentScript: null,
      createElement: el, createTextNode: el, body: el(), head: el(),
      documentElement: el(), getElementsByTagName: () => [], importNode: x => x,
      querySelectorAll: () => [], querySelector: () => null,
      addEventListener: noop, removeEventListener: noop,
      implementation: { createHTMLDocument: () => fakeDoc() },
    });
    globalThis.window = globalThis;
    globalThis.addEventListener ||= noop;
    globalThis.removeEventListener ||= noop;
    globalThis.Node ||= FakeNode;
    globalThis.Element ||= FakeElement;
    globalThis.HTMLTemplateElement ||= class extends FakeElement {
      get content() { return { ownerDocument: fakeDoc() }; }
    };
    globalThis.DocumentFragment ||= class extends FakeNode {};
    globalThis.HTMLFormElement ||= class extends FakeElement {};
    globalThis.NamedNodeMap ||= class {};
    globalThis.NodeFilter ||= { SHOW_ELEMENT: 1, SHOW_COMMENT: 128, SHOW_TEXT: 4 };
    globalThis.document ||= fakeDoc();
    globalThis.location ||= { href: "http://localhost/" };
    vm.runInThisContext(fs.readFileSync(file, "utf8"), { filename: path.basename(file) });
    _mermaid = globalThis.mermaid && typeof globalThis.mermaid.parse === "function"
      ? globalThis.mermaid : null;
  } catch { _mermaid = null; }
  return _mermaid;
}

// Validate diagram sources (spec-side). Returns [{label, error}]; empty = clean.
// `skipped` is signalled by a single {label: "mermaid", error: null} sentinel —
// callers may warn but must not refuse on it.
// A real syntax problem in the diagram source, as opposed to the shimmed
// environment falling short (some diagram types pull DOM machinery — e.g.
// DOMPurify for sequence diagrams — that parse() alone shouldn't need but
// does). Environment failures classify as "skip": refusing a valid spec
// because node isn't a browser would be a false positive, and those are the
// gate family's cardinal sin.
const isParseError = msg =>
  /parse error|lexical error|syntax error|unknown diagram|expecting|got '/i.test(msg);

export async function validateDiagrams(diagrams) {
  const m = loadMermaid();
  if (!m) return [{ label: "mermaid", error: null }];
  const bad = [];
  for (let i = 0; i < diagrams.length; i++) {
    const d = diagrams[i];
    try { await m.parse(d.mermaid); }
    catch (e) {
      const msg = String(e && e.message || e).split("\n").slice(0, 3).join(" ");
      if (isParseError(msg))
        bad.push({ label: `diagram ${i + 1} ("${(d.question || "").slice(0, 40)}")`, error: msg });
      else
        bad.push({ label: `diagram ${i + 1}`, error: null }); // env-limited: skip, don't refuse
    }
  }
  return bad;
}

const unescapeHtml = s => s
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
  .replace(/&#39;/g, "'").replace(/&amp;/g, "&");

// Lint a rendered surface (HTML or md). Returns [{label, error}].
export async function validateSurface(file) {
  const problems = [];
  let text;
  try { text = fs.readFileSync(file, "utf8"); } catch (e) {
    return [{ label: file, error: "unreadable: " + e.message }];
  }
  const name = path.basename(file);

  if (name.endsWith(".md")) {
    const fences = (text.match(/^```/gm) || []).length;
    if (fences % 2) problems.push({ label: name, error: "unbalanced ``` code fences" });
    return problems;
  }

  // Mermaid blocks, parsed with the page's own parser.
  const blocks = [...text.matchAll(/<pre class="mermaid">([\s\S]*?)<\/pre>/g)]
    .map(mt => unescapeHtml(mt[1]));
  const bad = await validateDiagrams(blocks.map(b => ({ mermaid: b, question: b.split("\n")[0] })));
  for (const b of bad) if (b.error !== null) problems.push({ label: `${name}: ${b.label}`, error: b.error });

  // Formatting lint: each of these has bitten a rendered page at least once.
  // Only the placeholders pages actually substitute at serve/apply time.
  // __DATA__ and __MAIN_REPO__ are deliberately absent: plan prose about this
  // codebase names them legitimately, and the first live run of this check
  // false-positived on exactly that.
  if (/__(TOKEN|SLUG|INTENT_PORT|HOME)__/.test(text))
    problems.push({ label: name, error: "unsubstituted placeholder (__NAME__) left in the page" });
  if (/&amp;(lt|gt|quot|amp|#39);/.test(text))
    problems.push({ label: name, error: "double-escaped HTML entities (&amp;lt; …)" });
  if (/>\s*undefined\s*</.test(text) || />\s*NaN\s*</.test(text))
    problems.push({ label: name, error: "literal undefined/NaN rendered as content" });
  for (const tag of ["pre", "code", "script", "textarea"]) {
    const open = (text.match(new RegExp(`<${tag}[\\s>]`, "g")) || []).length;
    const close = (text.match(new RegExp(`</${tag}>`, "g")) || []).length;
    if (open !== close)
      problems.push({ label: name, error: `unbalanced <${tag}> tags (${open} open, ${close} close)` });
  }
  return problems;
}
