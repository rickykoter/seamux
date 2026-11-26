// lookout's copy of ui/bpmnlayout.ts: the layout for BPMN files that store no
// diagram positions, bundled with esbuild as the global SeamuxBpmnLayout into
// lookout/vendor/bpmn-js/bpmn-layout.min.js, which lookout pins by sha256.
//
//   node ui-checks/lookout-bundle.mjs          write the bundle (npm run vendor:lookout)
//   node ui-checks/lookout-bundle.mjs --check  fail when the shipped bundle is not
//                                              what the source builds (npm run build)
//
// A source edit without a rebuild fails the check; a rebuild changes the
// bundle's sha256, which then fails lookout's pin until lookout/lib/vendor.mjs
// carries the new one.
import fs from "node:fs";
import { build } from "esbuild";

const out = new URL("../../lookout/vendor/bpmn-js/bpmn-layout.min.js", import.meta.url);
const r = await build({
  entryPoints: [new URL("../ui/bpmnlayout.ts", import.meta.url).pathname],
  bundle: true,
  minify: true,
  format: "iife",
  globalName: "SeamuxBpmnLayout",
  legalComments: "none",
  write: false,
  logLevel: "silent",
});
const text = r.outputFiles[0].text;

if (process.argv.includes("--check")) {
  const shipped = fs.existsSync(out) ? fs.readFileSync(out, "utf8") : "";
  if (shipped !== text) {
    console.error("lookout-bundle: lookout/vendor/bpmn-js/bpmn-layout.min.js is not what ui/bpmnlayout.ts builds; run `npm run vendor:lookout` in app/ and update its pin in lookout/lib/vendor.mjs");
    process.exit(1);
  }
} else {
  fs.writeFileSync(out, text);
  console.log("wrote " + out.pathname + " (" + text.length + " bytes)");
}
