# seamux-mods

deep-plan, drawn inside the Claude Code terminal. It is a mod: a plugin of
function hooks, the Claude Code extension API that can draw panes, bands and
status entries. It needs Claude Code 2.1.287 or later, and it was built and
tested on **2.1.289**. The mods API is early access and may change between
releases. If an upgrade breaks this plugin, deep-plan itself keeps working,
because nothing here is load-bearing.

## What it adds

| Piece | What you see | What it runs |
| --- | --- | --- |
| `/plan-pane` | A pane listing the plan that tracks this directory, one row per increment, with `go next`, `done` and `obs` buttons. Opened focused: the hotkeys work at once and Esc returns to the prompt. | `deep-plan status --json`, then `go`, `done` or `obs check` on a press |
| The gate band | When deep-plan's gate refuses an edit, a row above the prompt shows the refusal with `go next`, `open plan` and `dismiss`. ctrl+x tab focuses it, or click it. | `deep-plan go <slug> next` |
| The status entry | `<slug> 1/7 · ▶ 2 · cache 42m` under the prompt: progress, the open increment or `gate shut`, and the prompt cache's clock | the same status call, every 5s while the state directory changes, every 30s otherwise |
| The ask toast | `Ask page: http://127.0.0.1:<port>/ask/<id>` when AskUserQuestion runs within a minute of a `deep-plan ask` for this directory | reads `~/.claude/plans/asks` |

The command is `/plan-pane` because `/plan` is a built-in, and the engine
refuses a plugin that registers a built-in's name.

The band's buttons carry letter hotkeys, never digits. A bare digit typed into
an empty prompt answers a band button, and a gate's go-ahead must not be one
stray keypress away.

## How it finds things

- **The engine:** `$DEEP_PLAN_ENGINE`, else the `root` in
  `~/.claude/deep-plan/engine.json`, which the deep-plan plugin writes at
  every session start. Until that file exists, the pane says so.
- **The refusal:** the classic gate's message opens with
  `deep-plan gate [<slug>]: `. The band matches that opening in the tool
  result. `deep-plan/hooks/decide.mjs` pins it and `deep-plan/probe.mjs`
  asserts it, so a reword that would silence the band fails the probe first.
  The classic gate stays the authority. This plugin never refuses a call; it
  only reacts to the gate's refusal.
- **The cache clock:** the facts crew's Stop hook writes through
  `cachefacts.py`, at `~/.cache/cmux-crew/cache-facts/<session id>.json`.
  Without crew there are no facts, and the entry shows the plan alone.

## Install

From the seamux marketplace, after deep-plan, which it depends on:

```bash
claude plugin install seamux-mods@seamux
```

To try it from a checkout for one session:

```bash
claude --plugin-dir ./deep-plan --plugin-dir ./seamux-mods
```

## Developing

```bash
claude plugin validate seamux-mods   # what the module hooks and calls
claude plugin test seamux-mods       # tests/*.test.ts against the engine
```

The tests stub the deep-plan engine, the filesystem and the clock beneath the
plugin. They trip a gate refusal, then press the buttons by key on the
terminal and desktop surfaces. A session started with `--plugin-dir` watches
the folder and reloads the module when a file is saved. While the module is
loaded, the engine writes this build's types into `.claude-plugin/types/`
(git-ignored), and `tsconfig.json` extends them for an editor.

## Known limits

- **Ask toast:** in a terminal session the AskUserQuestion dialog covers the
  area where toasts show. The engine logs the toast as raised, but on 2.1.289
  it was not seen on screen while the dialog was up.
- **Other surfaces:** the band is drawn on the terminal and desktop surfaces
  only, as the engine raises `AbovePrompt` nowhere else. The pane and status
  entry are drawn everywhere.
