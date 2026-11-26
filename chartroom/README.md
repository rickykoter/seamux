# chartroom: charts you review beside the terminal

Part of [seamux](../README.md). Install and setup are in the [main README](../README.md#setup).

Ask Claude to mock up a screen, draw an architecture, or map a domain's
words, and chartroom has it draw a chart: plain HTML files kept with the
repo, shown in a studio page beside the terminal. You flip between options
and versions, pin a comment on any element, reply in threads, and pick the
option you want. The Claude session hears each comment and pick as you make
them, and works from them.

It needs only Claude Code, `node` and `git`. It has no tie to the rest of
seamux, so it works the same on a work laptop with nothing else installed.
Nothing leaves the machine unless you say yes to publishing a chart.

## Install it alone

On any machine, in Claude Code:

```
/plugin marketplace add rickykoter/seamux
/plugin install chartroom@seamux
```

Then start a new session. With seamux's own `./install.sh`, chartroom comes
with the rest; `--no-chartroom` leaves it out.

## What it draws

| ask for | chartroom draws | you |
|---|---|---|
| "mock up three layouts for the settings page" | a **UX** chart: two to four whole options on tabs | compare, pin comments, pick one |
| "show me how the orders service fits together" | an **architecture** chart: context, containers, a sequence, a data flow | pin questions on a box or an arrow |
| "map the words billing uses" | a **domain** chart: a searchable glossary, each term with its source, and a map of how terms relate | correct definitions in comments |

Each kind has a playbook Claude reads and a starter page it copies
(`chartroom template <kind> <file>`), so charts come out with real content,
stable places to pin on, and nothing loaded from the network.

## The studio

`chartroom open` prints the studio's address. In cmux it opens beside the
terminal; in the seamux app, clicking the link opens it in the Dock; in Claude
desktop it opens in the browser pane; anywhere else, open it in a browser.

The register on the left lists the repo's charts. The stage in the middle
shows one option or view at a time. Threads and notes are on the right.

| key | does |
|---|---|
| `1` to `9` | show that option or view |
| hold `Space` | show the previous version, with what changed outlined |
| `[` and `]` | previous or next version |
| `j` and `k` | next or previous chart |
| `c` | pin a comment: the next click on the chart drops the pin |
| `Cmd+Enter` | save the comment or send the reply you are writing |
| `Esc` | stop pinning, close the keys panel, or (pressed twice) drop what you wrote |
| `?` | the keys |

A thread that waits on you (Claude spoke last) is amber, and amber means
nothing else. A pin whose element is gone in a newer version says so in its
thread instead of landing on something else. **Pick** marks the chart
chosen and records the decision.

The session hears what you wrote at its next prompt, or at once when Claude
has `chartroom wait` running in the background.

## Where charts live

In a git repo, charts sit in a hidden `.chartroom/` folder at the top of the
main checkout. `.git/info/exclude` keeps git from seeing it, so a work repo
shows no change, and every worktree of the repo uses the same folder.

- `chartroom share on` makes the folder visible to git, so you can commit it
  and pull it on another laptop. Comments and picks are committed with the
  charts. `chartroom share off` hides it again.
- A team can commit `.chartroom.json` with `{"dir": "docs/charts"}` to keep
  charts in a visible folder instead.
- Outside git, charts sit under `~/.claude/chartroom/`.

Each chart is a folder: `chart.json`, `threads.json`, and one HTML file per
option or view in each version folder (`v1/`, `v2/`, ...).

## Publishing

To look at a chart on your phone or show it to someone, Claude asks first,
every time. On your yes it runs `chartroom export`, publishes the page to
claude.ai as a private Artifact, and records the link on the chart. The
published page is the same studio, with pins, threads and picks. Its
comments come back with `chartroom pull`, marked as coming from the published
page, since anyone you share it with can write there. Someone with
view-only access sees no comment or pick controls, because their copy
can't save.

## Commands

```
chartroom new <ux|arch|domain> <title> [--purpose TEXT]
chartroom template <kind> [file.html]     a starter page to edit
chartroom add <id> <pane>...              a new version; a pane is FILE.html or KEY:Label=FILE.html
chartroom open [id]                       the studio's address
chartroom wait [id]                       wait for the next comment or pick
chartroom threads <id>                    chartroom reply <id> <t#> <text>
chartroom resolve|reopen <id> <t#>        chartroom status <id> <exploring|chosen|superseded>
chartroom list | show <id>                chartroom share [on|off|status]
chartroom export <id> | link <id> <url> | pull <id> <rows>
chartroom serve [--status|--stop]         chartroom doctor
```

Every command takes `--json`. Claude's side of the loop is in
[SKILL.md](SKILL.md).

## Developing it

`node chartroom/probe.mjs` tests the store, the server and its guards, the
comment hook, export and pull, and the templates, in a throwaway home and
repo. The skill's evals are the `evals-chartroom` recipe
(`python3 tools/skill_evals.py compare chartroom --model opus --model haiku`),
which costs real model spend.
