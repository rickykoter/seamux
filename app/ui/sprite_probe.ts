// node app/ui/sprite_probe.ts — the shelf sprites the app draws: the generated
// grids' shape, the saved choice and the pane sprite's moves, with no DOM.
// Node runs this file as TypeScript.
import { Choice, HOP_AFTER_MS, KEY, catMove, pick } from "./sprite.ts";
import { DEFAULT_SPRITE, FRAMES, H, SPRITES, SPRITE_IDS, W } from "./sprites.gen.ts";

const checks: [string, boolean, string?][] = [];
const ok = (name: string, cond: boolean, detail = "") => checks.push([name, cond, detail]);

// ---- the generated grids ---------------------------------------------------
{
  const bad: string[] = [];
  for (const id of SPRITE_IDS) {
    const s = SPRITES[id];
    for (const f of FRAMES) {
      const rows = s.frames[f];
      if (!rows || rows.length !== H) bad.push(`${id}/${f}: ${rows?.length} rows`);
      rows?.forEach((r, y) => {
        if (r.length !== W) bad.push(`${id}/${f} row ${y}: ${r.length} cells`);
        for (const c of r) if (c !== "." && !s.palette[c]) bad.push(`${id}/${f} row ${y}: ${c}`);
      });
    }
  }
  ok("sprites: every sprite has all 18 frames, 24x15, every cell in its palette", FRAMES.length === 18 && bad.length === 0, bad.slice(0, 5).join("; "));
  ok("sprites: five of them, the tuxedo first and the default",
    SPRITE_IDS.length === 5 && SPRITE_IDS[0] === "tuxedo" && DEFAULT_SPRITE === "tuxedo");
  // In the pane only the top of a peeking sprite shows: its face has to be there.
  const faceLow = SPRITE_IDS.filter((id) => SPRITES[id].frames.sit.slice(0, 9).every((r) => /^\.+$/.test(r)));
  ok("sprites: each sitting sprite starts in its top 9 rows, where the peek shows it", faceLow.length === 0, faceLow.join(", "));
}

// ---- the saved choice ------------------------------------------------------
{
  const ids = ["tuxedo", "owl", "robot"] as const;
  ok("pick: a saved sprite is kept", pick("owl", ids, "tuxedo") === "owl");
  ok("pick: nothing saved, or a sprite that is gone, is the default",
    pick(null, ids, "tuxedo") === "tuxedo" && pick("dragon", ids, "tuxedo") === "tuxedo");

  const mem = new Map<string, string>();
  const store = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v), removeItem: (k: string) => void mem.delete(k) };
  const c = new Choice(ids, "tuxedo", store);
  const heard: string[] = [];
  c.listen((id) => heard.push(id));
  ok("choice: with nothing saved it is the default", c.get() === "tuxedo");
  c.set("owl");
  ok("choice: a pick is saved and told", c.get() === "owl" && mem.get(KEY) === "owl" && heard.join() === "owl");
  ok("choice: it is read back by the next app start", new Choice(ids, "tuxedo", store).get() === "owl");
  c.set("dragon");
  ok("choice: a name that is not a sprite changes nothing", c.get() === "owl" && heard.length === 1);
  c.set("owl");
  ok("choice: picking the same one again tells no one", heard.length === 1);
  c.set("tuxedo");
  ok("choice: going back to the default forgets the saved value", c.get() === "tuxedo" && !mem.has(KEY) && heard.join() === "owl,tuxedo");
  const refusing = { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("denied"); }, removeItem: () => {} };
  const r = new Choice(ids, "tuxedo", refusing);
  r.set("robot");
  ok("choice: storage that refuses still gives the default, and a pick lasts the session", r.get() === "robot");
  ok("choice: no storage at all is the default", new Choice(ids, "tuxedo", null).get() === "tuxedo");
}

// ---- the pane sprite's moves ----------------------------------------------
ok("move: a long turn ending in a question hops", catMove("working", "needs_input", HOP_AFTER_MS) === "hop");
ok("move: a short turn ending in a question only peeks", catMove("working", "needs_input", HOP_AFTER_MS - 1) === "peek");
ok("move: a long turn ending idle hops, then goes", catMove("working", "idle", HOP_AFTER_MS * 2) === "hop");
ok("move: a session that ended does not hop", catMove("working", "ended", HOP_AFTER_MS * 2) === "away");
ok("move: back to work, out of sight", catMove("needs_input", "working", 0) === "away");

let failed = 0;
for (const [name, pass, detail] of checks) {
  if (!pass) failed++;
  console.log(`  ${pass ? "ok  " : "FAIL"} ${name}${pass || !detail ? "" : `\n       ${detail}`}`);
}
console.log(`sprite probe: ${checks.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
