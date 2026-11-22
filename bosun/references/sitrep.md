# Sitrep: where things stand across the root

A sitrep is a short, sourced report on every repo under the code root:
branches in flight, open PRs, live workspaces and recent deploys. It is an
answer like any other, so it follows the answers rules and is logged.

## Gather

Repos are the primary checkouts under the root: folders whose `.git` is a
directory. Their worktrees sit beside them in `<repo>.worktrees/`.

| What | Read it with | Notes |
|---|---|---|
| branches in flight | `git --no-optional-locks -C <repo> worktree list` and `git --no-optional-locks -C <repo> for-each-ref --sort=-committerdate --count=10 --format='%(refname:short) %(committerdate:relative)' refs/heads` | local refs only: never fetch, it writes under the root |
| open PRs | `gh pr list -R <owner/repo> --state open --json number,title,author,isDraft,reviewDecision,statusCheckRollup` | `<owner/repo>` from `git -C <repo> remote get-url origin` |
| live workspaces | `seamux workspaces list-json` | the Bosun's own row is left out |
| recent deploys | `gh api 'repos/<owner/repo>/deployments?per_page=5'`, else `gh release list -R <owner/repo> --limit 3`, else the Datadog or Splunk MCP's deploy events | name the source you used |

Run independent reads side by side. Skip a repo with no remote for PRs and
deploys, and say so.

## Report

One block per repo, busiest first, with each line citing where it came
from:

```text
shop
  - 3 open PRs: #412 "retry cap" (review requested, checks green), ...   [gh pr list -R acme/shop]
  - 2 live workspaces: retry-cap, search-index                           [seamux workspaces list-json]
  - last deploy: v2.31 to production, 3 hours ago                        [gh api repos/acme/shop/deployments]
```

End with **Not checked**: each source that failed, the error in a few
words, and which `bosun.json` sandbox list would let it through. Then log
the sitrep with `seamux bosun log add` (question "sitrep", every command as
a `command` source).
