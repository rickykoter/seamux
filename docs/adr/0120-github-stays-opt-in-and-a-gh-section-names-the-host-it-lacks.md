# 0120. GitHub stays opt-in, and a gh section names the host it lacks

Date: 2026-11-23

## Status

Accepted

## Context

With no sandbox block in bosun.json the Bosun reaches no host, and the starter reports' Pull requests section uses cmd:gh. Once gh can verify TLS, adding the GitHub hosts lets gh write to GitHub too (a gist, a PR comment), and permission rules can't fully stop that.

## Decision

The person's call: gh acts with their token, so reaching GitHub is theirs to turn on. A report section that needs gh says up front that api.github.com is missing from sandbox.allowedDomains, rather than failing when the Bosun tries.

## Consequences

No default hosts. The source check for cmd:gh is up only when gh is on PATH and api.github.com is covered by the running sandbox's allowedDomains (an exact entry, *.github.com, or *), read from the settings.json the Bosun launched with; otherwise the section reads Not checked with that reason. An edit to bosun.json counts once the Bosun restarts. A GitHub Enterprise user gets a false Not checked until the check learns other hosts.
