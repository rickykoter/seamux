#!/usr/bin/env bash
# install.sh — seamux, as Claude Code plugins.
#
#   ./install.sh [--dry-run] [--github] [--mods] [--no-crew] [--no-restack]
#                [--no-guard] [--no-lookout] [--no-apply] [--no-migrate] [--main-repo PATH]
#                [--with-jira[=SITE]] [--with-github-issues]
#                [--with-observability=STACK]
#   ./install.sh --check        what is installed, and drift in the crew tree
#   ./install.sh --uninstall    remove the plugins, the shims and the crew tree
#   ./install.sh --app [--dry-run]  build the seamux app (app/) into
#                               ~/Applications/seamux.app and link its seamux CLI
#                               into ~/.local/bin; needs cargo, node and Xcode CLT
#
# A thin bootstrap over `claude plugin`. It adds this checkout as the `seamux`
# marketplace (a folder marketplace: the plugins run from the checkout itself,
# so an edit plus /reload-plugins is live with no version bump; --github adds
# the published repo instead), installs deep-plan, restack, bash-guard, lookout
# and crew (seamux-mods with --mods), runs each engine's `setup` and `crew apply`, then
# migrates what the old installer left behind: the ~/.claude/skills copies,
# their shims, and the settings.json hook entries the plugins now carry. Every
# file it migrates is moved into ~/.claude/seamux-migrated/<time>/, never
# deleted. Safe to re-run.

set -uo pipefail

HERE="$(cd -P -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
CLAUDE_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
SETTINGS="$CLAUDE_DIR/settings.json"
DEST="$HOME/.config/cmux/crew"
LOCALBIN="$HOME/.local/bin"
GITHUB_REPO="rickykoter/seamux"
MARKET="seamux"

APPDIR="$HOME/Applications/seamux.app"
APP_BUNDLE_ID="dev.seamux.app"
DRY=0 CHECK=0 UNINSTALL=0 APP=0 GITHUB=0 MODS=0 CREW=1 RESTACK=1 GUARD=1 LOOKOUT=1 APPLY=1 MIGRATE=1 MAIN=""
WITH_JIRA="" JIRA_SITE="" WITH_GHI="" OBS_STACK=""

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY=1; shift ;;
    --check) CHECK=1; shift ;;
    --uninstall) UNINSTALL=1; shift ;;
    --app) APP=1; shift ;;
    --github) GITHUB=1; shift ;;
    --mods) MODS=1; shift ;;
    --no-crew) CREW=0; shift ;;
    --no-restack) RESTACK=0; shift ;;
    --no-guard) GUARD=0; shift ;;
    --no-lookout) LOOKOUT=0; shift ;;
    --no-apply) APPLY=0; shift ;;
    --no-migrate) MIGRATE=0; shift ;;
    --main-repo)
      case "${2:-}" in ""|-*) echo "install.sh: --main-repo needs a PATH (--help lists the options)" >&2; exit 2 ;; esac
      MAIN="$2"; shift 2 ;;
    --with-jira) WITH_JIRA=1; shift ;;
    --with-jira=*) WITH_JIRA=1; JIRA_SITE="${1#--with-jira=}"; shift ;;
    --with-github-issues) WITH_GHI=1; shift ;;
    --with-observability=*) OBS_STACK="${1#--with-observability=}"; shift ;;
    -h|--help) sed -n '2,22p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "install.sh: unknown option $1 (--help lists them)" >&2; exit 2 ;;
  esac
done

say()  { printf '  %s\n' "$*"; }
ok()   { printf '  \033[32mok\033[0m   %s\n' "$*"; }
warn() { printf '  \033[33mwarn\033[0m %s\n' "$*"; }
die()  { printf '  \033[31mfail\033[0m %s\n' "$*" >&2; exit 1; }
head_() { printf '\n\033[1m%s\033[0m\n' "$*"; }
# ok, for a step `run` only describes in a dry run: silent there.
did()  { [ "$DRY" = 1 ] || ok "$@"; }
run() {
  if [ "$DRY" = 1 ]; then printf '  \033[2mwould run:\033[0m %s\n' "$*"; return 0; fi
  eval "$@"
}
# A value spliced into a `run` command, quoted for its eval: a path or option
# value with an apostrophe or a space stays one word.
q() { printf '%q' "$1"; }

# The plugins this run is about, in install order (crew depends on deep-plan).
PLUGINS="deep-plan"
[ "$RESTACK" = 1 ] && PLUGINS="$PLUGINS restack"
[ "$GUARD" = 1 ]   && PLUGINS="$PLUGINS bash-guard"
[ "$LOOKOUT" = 1 ] && PLUGINS="$PLUGINS lookout"
[ "$CREW" = 1 ]    && PLUGINS="$PLUGINS crew"
[ "$MODS" = 1 ]    && PLUGINS="$PLUGINS seamux-mods"
ALL_PLUGINS="deep-plan restack bash-guard lookout crew seamux-mods"

# Where Claude runs a plugin from (the checkout folder for a folder marketplace).
# Through seamux once it is installed (the crew Python is retired at the
# cutover); the checkout's Python only before seamux exists, until inc4 deletes it.
plugin_root() {
  if [ -x "$LOCALBIN/seamux" ]; then "$LOCALBIN/seamux" crew-plugin-root "$1" 2>/dev/null
  else python3 "$HERE/crew/bin/crew-plugin-root" "$1" 2>/dev/null; fi
}

find_node() {
  if command -v node >/dev/null 2>&1; then echo node; return; fi
  for c in "$HOME/.asdf/shims/node" /opt/homebrew/bin/node /usr/local/bin/node; do
    [ -x "$c" ] && { echo "$c"; return; }
  done
}

# The seamux plugins Claude has installed and enabled, space-separated. The
# migration removes an old piece only when the plugin replacing it is here.
enabled_plugins() {
  claude plugin list --json 2>/dev/null | python3 -c '
import json, sys
try:
    ps = json.load(sys.stdin)
except ValueError:
    ps = []
print(" ".join(p["id"].split("@")[0] for p in ps
               if p.get("enabled") and p.get("id", "").endswith("@seamux")))'
}

# What the old installer left that this one replaces. Printed by --dry-run and
# --check, acted on by the migration.
legacy_report() {
  python3 - "$SETTINGS" "$HOME" "$LOCALBIN" <<'PY'
import json, os, sys
settings, home, localbin = sys.argv[1:4]
out = []
for name in ("deep-plan", "restack"):
    d = os.path.join(home, ".claude", "skills", name)
    if os.path.isdir(d):
        out.append(f"dir   {d}")
    shim = os.path.join(localbin, name)
    try:
        text = open(shim).read()
        if f".claude/skills/{name}/" in text and "engine.json" not in text:
            out.append(f"shim  {shim}")
    except OSError:
        pass
try:
    s = json.load(open(settings))
except Exception:
    s = {}
marks = {"deep-plan gate": "/.claude/skills/deep-plan/hooks/gate.sh",
         "bash guard": "/.claude/hooks/cmux/guard_bash.sh",
         "crew hook": "crew-hook.sh"}
for event, ms in (s.get("hooks") or {}).items():
    for m in ms:
        for h in m.get("hooks", []):
            c = h.get("command") or ""
            for label, mark in marks.items():
                if mark in c:
                    out.append(f"hook  {event}: {label}")
print("\n".join(out))
PY
}

# ---------------------------------------------------------------- app
# The seamux app (app/, Tauri) and the `seamux` CLI it carries. A mode of its
# own: it builds from this checkout and copies the bundle out, so nothing it
# installs points back here, and it leaves the plugins alone.
app_version() { sed -n 's/^version = "\(.*\)"/\1/p' "$HERE/app/Cargo.toml" | head -1; }

# The app's lines for --check; non-zero when something is off.
app_report() {
  local rc=0 v link
  if [ ! -d "$APPDIR" ]; then
    printf '  \033[2m·    seamux.app: not installed (./install.sh --app)\033[0m\n'
    return 0
  fi
  v="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$APPDIR/Contents/Info.plist" 2>/dev/null)"
  ok "seamux.app ${v:-?} in $APPDIR"
  link="$(readlink "$LOCALBIN/seamux" 2>/dev/null)"
  if [ "$link" = "$APPDIR/Contents/Resources/bin/seamux" ] && [ -x "$link" ]; then
    ok "seamux -> $link ($("$LOCALBIN/seamux" --version 2>/dev/null))"
  else
    warn "seamux is not linked to the app's CLI in $LOCALBIN (./install.sh --app)"; rc=1
  fi
  case ":$PATH:" in *":$LOCALBIN:"*) ;; *) warn "$LOCALBIN is not on PATH"; rc=1 ;; esac
  return $rc
}

install_app() {
  head_ "seamux app"
  command -v cargo >/dev/null || die "cargo is required for the app (https://rustup.rs)"
  command -v npm >/dev/null || die "node and npm are required for the app's pages"
  xcode-select -p >/dev/null 2>&1 || die "the Xcode command line tools are required (xcode-select --install)"
  ok "toolchain: $(cargo --version | cut -d' ' -f1-2), node $(node --version), Xcode CLT"
  local v build stage bundle
  v="$(app_version)"; [ -n "$v" ] || die "no version in app/Cargo.toml"
  build="$HERE/app/target/release"
  run "(cd $(q "$HERE/app") && npm ci --silent && npm run build --silent >/dev/null)"
  did "pages built (app/dist)"
  run "cargo build --release --quiet --manifest-path $(q "$HERE/app/Cargo.toml") -p seamux-app -p seamux-cli"
  did "seamux-app and seamux built (release)"
  # Assemble the bundle in a fresh folder under the build output.
  if [ "$DRY" = 1 ]; then
    stage="$build/bundle.XXXXXX"
  else
    stage="$(mktemp -d "$build/bundle.XXXXXX")" || die "cannot make a staging folder in $build"
  fi
  bundle="$stage/seamux.app"
  run "mkdir -p $(q "$bundle/Contents/MacOS") $(q "$bundle/Contents/Resources/bin")"
  run "cp $(q "$build/seamux-app") $(q "$bundle/Contents/MacOS/seamux-app")"
  run "cp $(q "$build/seamux") $(q "$bundle/Contents/Resources/bin/seamux")"
  if [ "$DRY" = 1 ]; then
    say "would write: Info.plist ($APP_BUNDLE_ID $v) and AppIcon.icns from the crate's icon"
  else
    cat > "$bundle/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleIdentifier</key><string>$APP_BUNDLE_ID</string>
  <key>CFBundleName</key><string>seamux</string>
  <key>CFBundleDisplayName</key><string>seamux</string>
  <key>CFBundleExecutable</key><string>seamux-app</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>$v</string>
  <key>CFBundleVersion</key><string>$v</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>LSUIElement</key><true/>
  <key>NSHighResolutionCapable</key><true/>
</dict></plist>
PLIST
    # The icon, from the crate's PNG at the sizes an .icns wants.
    local set="$stage/AppIcon.iconset" png="$HERE/app/crates/seamux-app/icons/icon.png" px
    mkdir -p "$set"
    for px in 16 32 128 256; do
      sips -z $px $px "$png" --out "$set/icon_${px}x${px}.png" >/dev/null 2>&1
      sips -z $((px * 2)) $((px * 2)) "$png" --out "$set/icon_${px}x${px}@2x.png" >/dev/null 2>&1
    done
    iconutil -c icns "$set" -o "$bundle/Contents/Resources/AppIcon.icns" 2>/dev/null || warn "no app icon (iconutil failed)"
    ok "bundle assembled: $bundle"
  fi
  # Ad-hoc signed, so macOS treats the copied bundle as one unit. A bundle
  # that failed to build or sign never replaces a working one.
  if [ "$DRY" != 1 ]; then
    [ -x "$bundle/Contents/MacOS/seamux-app" ] && [ -x "$bundle/Contents/Resources/bin/seamux" ] \
      || die "the bundle is incomplete ($bundle); the installed app is unchanged"
  fi
  run "codesign --force --deep --sign - $(q "$bundle") >/dev/null 2>&1" \
    || die "codesign failed for $bundle; the installed app is unchanged"
  # Swap it in. A previous bundle is moved aside, never deleted, and comes
  # back if the copy fails.
  local aside=""
  if [ -d "$APPDIR" ]; then
    local tmp="${TMPDIR:-/tmp}"
    aside="${tmp%/}/seamux.app.replaced.$(date +%Y%m%d%H%M%S)"
    run "mv $(q "$APPDIR") $(q "$aside")" || die "could not move the old seamux.app aside; nothing changed"
    did "the previous seamux.app moved to $aside"
  fi
  if ! run "mkdir -p $(q "$HOME/Applications") && cp -R $(q "$bundle") $(q "$APPDIR")"; then
    [ -n "$aside" ] && mv "$APPDIR" "$aside.failed" 2>/dev/null; [ -n "$aside" ] && mv "$aside" "$APPDIR"
    die "copying the bundle to $APPDIR failed; the previous app is back in place"
  fi
  did "installed $APPDIR"
  # The CLI the hook shims call, linked into ~/.local/bin. A file that is
  # not a link at that name is someone else's, and is left alone.
  local target="$APPDIR/Contents/Resources/bin/seamux"
  if [ -e "$LOCALBIN/seamux" ] && [ ! -L "$LOCALBIN/seamux" ]; then
    warn "$LOCALBIN/seamux exists and is not a link; left it (move it aside, then re-run)"
  else
    run "mkdir -p $(q "$LOCALBIN") && ln -sfn $(q "$target") $(q "$LOCALBIN/seamux")"
    did "linked $LOCALBIN/seamux -> $target"
  fi
  case ":$PATH:" in *":$LOCALBIN:"*) ;; *) warn "$LOCALBIN is not on PATH; add it so hooks and shells find seamux" ;; esac
  head_ "next"
  say "open $(q "$APPDIR")    # then Control-Option-Space shows the overlay"
  say "quit an older copy from its tray icon first, if one is running"
  say "./install.sh --check         # the app, its version and the link"
  printf '\n'
}

if [ "$APP" = 1 ]; then
  printf '\n\033[1mseamux app install\033[0m  %s\n' "$([ "$DRY" = 1 ] && echo '(dry run: nothing changes)')"
  install_app
  exit 0
fi

# ---------------------------------------------------------------- preflight
printf '\n\033[1mseamux install\033[0m  %s\n' "$([ "$DRY" = 1 ] && echo '(dry run: nothing changes)')"
command -v claude  >/dev/null || die "the claude CLI is required (https://code.claude.com) — the features ship as its plugins"
command -v python3 >/dev/null || die "python3 is required (crew, the option bridge, this script's checks)"
NODE="$(find_node)"
[ -n "$NODE" ] || die "node is required (deep-plan, restack, the board renderer)"

# crew runs as seamux since the cutover, its hooks included, and they are silent
# no-ops without it. So a crew install with no seamux yet builds the app first
# (the CLI ships inside it), before anything below resolves a plugin root
# through it. An existing seamux is left as it is: ./install.sh --app rebuilds.
if [ "$CREW" = 1 ] && [ "$CHECK" = 0 ] && [ "$UNINSTALL" = 0 ] && [ ! -x "$LOCALBIN/seamux" ]; then
  say "crew needs seamux, and $LOCALBIN/seamux is not there: building the app first"
  install_app
fi

# ---------------------------------------------------------------- check
if [ "$CHECK" = 1 ]; then
  rc=0
  head_ "marketplace"
  python3 - "$HERE" "$GITHUB_REPO" <<'PY' || rc=1
import json, subprocess, sys
here, repo = sys.argv[1:3]
try:
    ms = json.loads(subprocess.run(["claude", "plugin", "marketplace", "list", "--json"],
                                   capture_output=True, text=True).stdout or "[]")
except ValueError:
    ms = []
m = next((x for x in ms if x.get("name") == "seamux"), None)
if not m:
    print("  \033[31mfail\033[0m seamux marketplace not added — run ./install.sh"); sys.exit(1)
where = m.get("path") or m.get("repo") or m.get("url") or str(m.get("source"))
note = "" if m.get("source") != "directory" or where == here else f"  (not this checkout: {here})"
print(f"  \033[32mok\033[0m   seamux -> {where}{note}")
PY
  head_ "plugins"
  python3 - "$HERE" <<'PY' || rc=1
import json, subprocess, sys
here = sys.argv[1]
try:
    ps = json.loads(subprocess.run(["claude", "plugin", "list", "--json"],
                                   capture_output=True, text=True).stdout or "[]")
except ValueError:
    ps = []
bad = 0
for name in ("deep-plan", "restack", "bash-guard", "lookout", "crew", "seamux-mods"):
    p = next((x for x in ps if x.get("id", "").split("@")[0] == name and x.get("id", "").endswith("@seamux")), None)
    if not p:
        print(f"  \033[2m·    {name}: not installed\033[0m"); continue
    state = "enabled" if p.get("enabled") else "DISABLED"
    where = p.get("readFromFolder") or p.get("installPath") or "?"
    print(f"  \033[32mok\033[0m   {name} {p.get('version')} {state}, runs from {where}")
    bad += not p.get("enabled")
sys.exit(1 if bad else 0)
PY
  head_ "app"
  app_report || rc=1
  head_ "left by the old installer"
  left="$(legacy_report)"
  if [ -z "$left" ]; then ok "nothing"; else printf '%s\n' "$left" | sed 's/^/  warn /'; rc=1; fi
  if [ -x "$DEST/bin/crew" ]; then
    head_ "crew tree"
    out="$("$DEST/bin/crew" drift 2>&1)"; drc=$?
    if [ "$drc" = 0 ]; then ok "$out"; else printf '%s\n' "$out" | sed 's/^/  warn /'; rc=1; fi
  fi
  printf '\n'
  exit $rc
fi

# ---------------------------------------------------------------- uninstall
# The exit door. Kept: plan state and keys (~/.claude/deep-plan, ~/.claude/plans),
# each repo's .seamux/restack.json, ~/.config/cmux/crew-local, the crew backups,
# and the old ~/.claude/hooks/cmux/guard_bash.sh if it is there.
if [ "$UNINSTALL" = 1 ]; then
  if [ -x "$DEST/bin/crew" ]; then
    run "$(q "$DEST/bin/crew") uninstall" || warn "crew uninstall failed — continuing"
  fi
  if [ -d "$DEST" ]; then
    BAK="$HOME/.config/cmux/crew-backups/crew.uninstalled.$(date +%Y%m%d-%H%M%S)"
    run "mkdir -p $(q "$(dirname "$BAK")") && mv $(q "$DEST") $(q "$BAK")" && did "crew tree moved aside -> ${BAK/#$HOME/~}"
  fi
  for p in $ALL_PLUGINS; do
    if claude plugin list --json 2>/dev/null | grep -q "\"$p@$MARKET\""; then
      run "claude plugin uninstall '$p@$MARKET' >/dev/null" && did "uninstalled $p"
    fi
  done
  for name in deep-plan restack lookout; do
    f="$LOCALBIN/$name"
    if [ -f "$f" ] && grep -q "engine.json" "$f" 2>/dev/null; then
      run "rm -f $(q "$f")" && did "removed the $name shim"
    fi
  done
  run "claude plugin marketplace remove '$MARKET' >/dev/null 2>&1" && did "removed the seamux marketplace"
  say "kept: ~/.claude/deep-plan (plan state, keys, the engine pointer), ~/.claude/plans"
  say "      (reviews included), ~/.claude/lookout (its pointer and highlight.js),"
  say "      each repo's .seamux/restack.json, ~/.config/cmux/crew-local, crew backups"
  printf '\n'
  exit 0
fi

# ---------------------------------------------------------------- platform
if [ "$CREW" = 1 ]; then
  [ "$(uname -s)" = "Darwin" ] || { warn "not macOS — skipping crew (cmux is mac-only); --no-crew silences this"; CREW=0; PLUGINS="${PLUGINS/ crew/}"; }
fi
if [ "$CREW" = 1 ]; then
  CMUX="$(command -v cmux || "$HERE/crew/bin/crew-cmux-bin" 2>/dev/null || true)"
  if [ -n "$CMUX" ]; then ok "cmux at $CMUX"; else warn "cmux not found — crew installs, but nothing drives it until cmux runs"; fi
  command -v gh      >/dev/null && ok "gh present (PR chips, checks)" || warn "no gh — PR and check chips stay blank"
  command -v ccusage >/dev/null && ok "ccusage present (usage windows)" || warn "no ccusage — the status line says so (npm i -g ccusage)"
fi
if [ "$MODS" = 1 ]; then
  v="$(claude --version 2>/dev/null | sed -n 's/^\([0-9][0-9.]*\).*/\1/p')"
  python3 -c 'import sys;v=tuple(int(x) for x in sys.argv[1].split("."));sys.exit(0 if v>=(2,1,287) else 1)' "${v:-0}" 2>/dev/null \
    || warn "seamux-mods needs Claude Code 2.1.287 or later (this is ${v:-unknown}); it installs but will not load"
fi

# ---------------------------------------------------------------- plugins
head_ "plugins"
SOURCE="$HERE"
[ "$GITHUB" = 1 ] && SOURCE="$GITHUB_REPO"
# Adding again re-points an existing `seamux` marketplace at this source, and
# installed plugins follow it; nothing is uninstalled.
run "claude plugin marketplace add $(q "$SOURCE") >/dev/null" && did "marketplace seamux -> $SOURCE" \
  || die "could not add the seamux marketplace from $SOURCE — nothing else was changed"
for p in $PLUGINS; do
  run "claude plugin install '$p@$MARKET' >/dev/null" && did "installed $p" \
    || die "could not install $p@$MARKET — stopping before the migration, so the old wiring stays"
done

# crew's options, from the flags (the same values /plugin configure crew@seamux sets).
if [ "$CREW" = 1 ] && { [ -n "$WITH_JIRA" ] || [ -n "$WITH_GHI" ] || [ -n "$OBS_STACK" ] || [ -n "$MAIN" ]; }; then
  VALUES="$(python3 - "$JIRA_SITE" "$WITH_GHI" "$OBS_STACK" "$MAIN" <<'PY'
import json, sys
site, ghi, stack, main = sys.argv[1:5]
v = {}
if site: v["jira_site"] = site
if ghi: v["github_issues"] = "true"
if stack: v["observability_stack"] = stack
if main: v["main_repo"] = main
print(json.dumps(v))
PY
)"
  [ -n "$WITH_JIRA" ] && [ -z "$JIRA_SITE" ] && warn "--with-jira needs a site now (--with-jira=yourco.atlassian.net): Jira is on when jira_site is set"
  if [ "$VALUES" != "{}" ]; then
    run "printf '%s' $(q "$VALUES") | claude plugin configure crew@$MARKET --values-stdin >/dev/null" && did "crew options: $VALUES"
  fi
fi

# ---------------------------------------------------------------- engines
# Each engine's own setup: the ~/.local/bin shim, the engine pointer, and the
# pinned bundle it renders with — deep-plan's mermaid (copied from the old
# skills copy when it matches the pin, so this runs before the migration moves
# that copy) and lookout's highlight.js.
head_ "engines"
for pair in deep-plan:deep_plan.mjs restack:restack.mjs lookout:lookout.mjs; do
  name="${pair%%:*}"; script="${pair#*:}"
  case " $PLUGINS " in *" $name "*) ;; *) continue ;; esac
  root="$(plugin_root "$name")"
  if [ "$DRY" = 1 ]; then
    extra=""; [ "$name" = deep-plan ] && extra=", mermaid"; [ "$name" = lookout ] && extra=", highlight.js"
    say "would run: $name setup (shim, engine pointer$extra)"; continue
  fi
  if [ -z "$root" ] || [ ! -f "$root/$script" ]; then warn "$name: plugin root not found — run \`$name setup\` inside Claude"; continue; fi
  out="$("$NODE" "$root/$script" setup 2>&1)"; src=$?
  printf '%s\n' "$out" | sed "s/^  /  $name /"
  [ "$src" = 0 ] || warn "$name setup reported a problem (above)"
done

# ---------------------------------------------------------------- crew
if [ "$CREW" = 1 ] && [ "$APPLY" = 1 ]; then
  head_ "crew"
  root="$(plugin_root crew)"
  if [ "$DRY" = 1 ]; then
    crew_bin="$HERE/crew/bin/crew"; [ -n "$root" ] && crew_bin="$root/bin/crew"
    # Same override as the real apply, so "would bake" names the --main-repo path.
    if [ -n "$MAIN" ]; then CREW_MONOLITH="$MAIN" "$crew_bin" apply --dry-run
    else "$crew_bin" apply --dry-run; fi | sed 's/^/  /'
  elif [ -z "$root" ] || [ ! -x "$root/bin/crew" ]; then
    warn "crew: plugin root not found — run \`crew apply\` inside Claude"
  else
    # Only --main-repo overrides: an empty CREW_MONOLITH would hide an exported one.
    if [ -n "$MAIN" ]; then CREW_MONOLITH="$MAIN" "$root/bin/crew" apply; else "$root/bin/crew" apply; fi \
      || warn "crew apply reported a problem (above)"
  fi
elif [ "$CREW" = 1 ]; then
  say "skipped crew apply (--no-apply) — run it yourself: crew apply"
fi

# ---------------------------------------------------------------- migration
head_ "migration from the old installer"
left="$(legacy_report)"
if [ -z "$left" ]; then
  ok "nothing to migrate"
elif [ "$MIGRATE" = 0 ]; then
  printf '%s\n' "$left" | sed 's/^/  left  /'
  warn "--no-migrate: the above stays; hooks may fire twice until it is removed"
else
  MIG="$CLAUDE_DIR/seamux-migrated/$(date +%Y%m%d-%H%M%S)"
  printf '%s\n' "$left" | sed 's/^/  /'
  # Each old piece goes only once the plugin that replaces it is installed and
  # enabled: a machine must never be left with no gate or no guard.
  if [ "$DRY" = 1 ]; then ON="$PLUGINS"; else ON=" $(enabled_plugins) "; fi
  replaced() { case " $ON " in *" $1 "*) return 0 ;; esac; return 1; }
  KEEP=""
  replaced deep-plan  || KEEP="$KEEP deep-plan"
  replaced restack    || KEEP="$KEEP restack"
  replaced bash-guard || KEEP="$KEEP bash-guard"
  replaced crew       || KEEP="$KEEP crew"
  [ -n "$KEEP" ] && warn "not installed or not enabled:$KEEP — their old pieces stay"
  if [ "$DRY" = 1 ]; then
    say "would move the dirs and shims above into ${MIG/#$HOME/~}/ and remove the hook"
    say "entries from settings.json after backing it up there"
  else
    mkdir -p "$MIG"
    printf '%s\n' "$left" | while read -r kind what; do
      case "$kind" in
        dir|shim)
          case "$what" in *deep-plan*) replaced deep-plan || continue ;; *restack*) replaced restack || continue ;; esac
          dst="$MIG/$(printf '%s' "$what" | sed "s|^$HOME/||; s|/|__|g")"
          mv "$what" "$dst" && ok "moved $what -> ${dst/#$HOME/~}" ;;
      esac
    done
    MARKS=""
    replaced deep-plan  && MARKS="$MARKS /.claude/skills/deep-plan/hooks/gate.sh"
    replaced bash-guard && MARKS="$MARKS /.claude/hooks/cmux/guard_bash.sh"
    replaced crew       && MARKS="$MARKS crew-hook.sh"
    if printf '%s\n' "$left" | grep -q '^hook' && [ -n "$MARKS" ]; then
      cp "$SETTINGS" "$MIG/settings.json" && ok "backed up settings.json -> ${MIG/#$HOME/~}/settings.json"
      python3 - "$SETTINGS" $MARKS <<'PY' && ok "removed the old hook entries the installed plugins replace:$MARKS"
import json, os, sys, tempfile
p = os.path.realpath(sys.argv[1])
s = json.load(open(p, encoding="utf-8"))
marks = tuple(sys.argv[2:])
hooks = s.get("hooks") or {}
for event, ms in list(hooks.items()):
    for m in ms:
        m["hooks"] = [h for h in m.get("hooks", []) if not any(k in (h.get("command") or "") for k in marks)]
    hooks[event] = [m for m in ms if m.get("hooks")]
    if not hooks[event]:
        del hooks[event]
# Atomically: a temp file beside it, then a rename, so an interrupted write
# never leaves settings.json truncated. realpath above keeps a symlink a symlink.
fd, tmp = tempfile.mkstemp(dir=os.path.dirname(p), prefix=".settings.", suffix=".tmp")
try:
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        json.dump(s, fh, indent=2, ensure_ascii=False)
        fh.write("\n")
    os.chmod(tmp, os.stat(p).st_mode & 0o7777)
    os.replace(tmp, p)
except BaseException:
    os.unlink(tmp)
    raise
PY
    fi
    # The engines' shims, if a migrated old one left the name free.
    for pair in deep-plan:deep_plan.mjs restack:restack.mjs; do
      name="${pair%%:*}"; script="${pair#*:}"
      root="$(plugin_root "$name")"
      [ -f "$LOCALBIN/$name" ] || { [ -n "$root" ] && "$NODE" "$root/$script" setup >/dev/null 2>&1 && ok "reinstalled the $name shim"; }
    done
  fi
fi

# ---------------------------------------------------------------- next
head_ "next"
say "Start new Claude sessions: hooks bind at session start, so a running one keeps"
say "whatever it started with."
[ "$CREW" = 1 ] && say "crew doctor                  # must be green"
say "./install.sh --check         # plugins, leftovers, drift in the crew tree"
say "claude plugin list           # each seamux plugin, read from $([ "$GITHUB" = 1 ] && echo 'its cached copy' || echo 'this checkout')"
[ "$GITHUB" = 0 ] && say "edit a plugin here, then /reload-plugins in a session: no version bump needed"
printf '\n'
