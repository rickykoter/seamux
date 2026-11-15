#!/bin/sh
# A land recipe's first stage (plan landing): the kept checkout must be on
# main with no uncommitted changes to tracked files before a merge is pulled
# into it. Untracked files (a local .seamux/lessons.md) are left alone.
b=$(git rev-parse --abbrev-ref HEAD) || exit 1
if [ "$b" != main ]; then
  echo "the kept checkout is on $b, not main: switch it back, then retry the landing" >&2
  exit 1
fi
if [ -n "$(git --no-optional-locks status --porcelain --untracked-files=no)" ]; then
  echo "the kept checkout has uncommitted changes: commit or stash them, then retry the landing" >&2
  git --no-optional-locks status --short --untracked-files=no >&2
  exit 1
fi
echo "main, clean"
