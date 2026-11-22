# Lessons

Rules this repo's plans learned from their misses. `deep-plan retro` adds,
merges and retires them, at most 30. Each names the paths it applies to;
a plan that touches them says how it heeds the rule (cite its id).

<!-- next: L11 -->

## L1
applies: **
from: seamux-additions inc 2 (correction cd84e8a97), 2026-11-05; seamux-additions inc 14 (correction ca4fddbf5), 2026-11-05

Never edit a plan root while any check run, detached ones included, is still going. Before the first edit, run deep-plan status: the increment you edit must be the authorized one, and the one before it done.

## L2
applies: **/probe.mjs, app/**
from: seamux-additions inc 1 (retry c4fdba2a8), 2026-11-05

When a full probe or Rust suite fails, rerun the failing section alone and on main before counting it as yours; timing tests fail under load, and a run killed for a hang still counts toward the three-failure block.

## L3
applies: **
from: dock-density-and-hopping (correction c6c47c382), 2026-11-06

A bug or idea found mid-plan becomes a deep-plan note first. It joins a plan only when the person picks its place, through deep-plan amend with the why.

## L4
applies: **
from: dock-density-and-hopping (grade c03e73c60), 2026-11-06

A quiz question names the change it asks about, never an increment number: adding or reordering increments renumbers them.

## L5
applies: app/**, crew/**
from: dock-density-and-hopping inc 1 (retry c1396a3f9), 2026-11-06

When a check fails in files the increment did not touch, find that cause and record it as a risk before retrying. Run crew's probes outside the sandbox, with SEAMUX_BACKEND, SEAMUX_PANE_ID and SEAMUX_WORKSPACE_ID unset.

## L6
applies: **
from: search-preview (correction c7fd214ad), 2026-11-06; lookout-pr-window inc 1 (correction c51db7aba), 2026-11-11

When lookout says addressed findings wait on a re-review, run the --round reviewer before resolving them; resolving first skips the round. Re-open the review on the current tree (lookout open … --base <start sha>) before lookout prompt --round: the brief seals the round on whatever tree the review last saw.

## L7
applies: app/**, crew/**, lookout/**
from: board-snooze inc 3 (force cdc2dae79), 2026-11-06; turn-ckpt inc 1 (force cd7725391), 2026-11-06; turn-ckpt inc 3 (force c06141138), 2026-11-06; notification-log (correction c16682d39), 2026-11-08; sprite-switcher inc 2 (force c42c7ea9a), 2026-11-08; sprite-switcher inc 3 (force cca2f4efe), 2026-11-08; agent-runs inc 7 (force c5af3b920), 2026-11-08; bash-guard-escalations inc 5 (correction c666e5e90), 2026-11-13

A manual check that needs the merged code waits for the merge: an app change needs the app built from main, and a plugin hook or the board's page files (board.html, render.js, intent.js, served from crew's live tree) run only from the kept checkout. A branch app install (install.sh --app --from) does not carry the board's page files either, so an in-app check that needs them is planned as after-merge from the start. install.sh --app does not refresh them even from main: before the first in-app check of a board page change, run crew apply from the kept checkout, restart the app (the board does not reload itself), and confirm the live tree has the change. A plan runs those checks after its PR merges and records them then; in a plan family, a child's wait for the parent's merge increment, and the child closes with a note naming each deferred check.

## L8
applies: deep-plan/**, tools/**
from: tmux-standalone inc 12 (retry cc6c529fc), 2026-11-11

When a timing check fails, read the load average during the run before retrying; a retry at the same load fails the same way.

## L9
applies: lookout/workflows/**, deep-plan/workflows/**
from: review-workflows inc 3 (review ccfe44dd6), 2026-11-11

In a workflow script, model-written text passed into another agent's prompt is fenced and named as data at every hand-off, not only the first. A merge of agents' outputs never drops a more severe or a distinct item without logging it.

## L10
applies: app/crates/**, crew/**
from: dock-many-prs (correction c4a0e799c), 2026-11-13

Code a branch's checks run never opens the person's real stores: point CREW_DURABLE_DIR, XDG_CACHE_HOME and HOME at a temp dir, or a branch build can migrate the live store before merge. After a schema change, verify it on the real store once the merged build is installed.
