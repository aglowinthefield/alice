#!/usr/bin/env bash
# Keeps /Applications/Bakery.app built from origin/main on a Mac.
#   scripts/install-desktop.sh            build and install the app if desktop code changed since the last install
#   scripts/install-desktop.sh --force    build and install even if nothing changed
#   scripts/install-desktop.sh --launchd  install a launchd job that runs this every hour, then run it once
# It builds in a throwaway worktree, so the checkout it lives in is never touched. A running app keeps its old code
# until you quit and reopen it; this never quits it for you.
set -euo pipefail
[[ $(uname) == Darwin ]] || { echo "install-desktop.sh builds the macOS app; run it on a Mac." >&2; exit 2; }
repo=$(cd "$(dirname "$0")/.." && pwd)
app=${BAKERY_DESKTOP_APP:-/Applications/Bakery.app}
state=${XDG_STATE_HOME:-$HOME/.local/state}/bakery
label=dev.bakery.desktop-update
mkdir -p "$state"

if [[ ${1:-} == --launchd ]]; then
  plist=$HOME/Library/LaunchAgents/$label.plist
  log=$HOME/Library/Logs/bakery-desktop-update.log
  # launchd starts jobs with a bare PATH, so keep the one that finds node, npm and cargo now.
  cat > "$plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$label</string>
  <key>ProgramArguments</key><array><string>/bin/bash</string><string>$repo/scripts/install-desktop.sh</string></array>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>$PATH</string></dict>
  <key>StartInterval</key><integer>3600</integer>
  <key>RunAtLoad</key><true/>
  <key>LowPriorityIO</key><true/>
  <key>Nice</key><integer>10</integer>
  <key>StandardOutPath</key><string>$log</string>
  <key>StandardErrorPath</key><string>$log</string>
</dict>
</plist>
PLIST
  launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$plist"
  echo "Installed $plist; it logs to $log."
  exit 0
fi

# One build at a time: launchd and a manual run can overlap.
lock=$state/desktop-install.lock
mkdir "$lock" 2>/dev/null || { echo "Another install is running ($lock)."; exit 0; }
work=""
cleanup() { [[ -n $work ]] && git -C "$repo" worktree remove --force "$work" >/dev/null 2>&1; rm -rf "$lock"; }
trap cleanup EXIT

# launchd runs this while the SSH agent may be locked (1Password then refuses the key), so fetch a GitHub ssh
# remote over https with gh's token. The user@ in the URL also keeps an `insteadOf https://github.com/` rewrite
# from sending it back to ssh.
remote=$(git -C "$repo" remote get-url origin)
if [[ $remote =~ ^git@github\.com:(.+)$ ]] && gh_user=$(gh config get -h github.com user 2>/dev/null) && [[ -n $gh_user ]]; then
  git -C "$repo" -c credential.helper= -c 'credential.helper=!gh auth git-credential' \
    fetch -q "https://$gh_user@github.com/${BASH_REMATCH[1]}" +refs/heads/main:refs/remotes/origin/main
else
  git -C "$repo" fetch -q origin main
fi
# The app bundles only the Tauri shell and the connection page; the board UI comes from the server.
commit=$(git -C "$repo" log -1 --format=%H origin/main -- src-tauri desktop)
stamp=$state/desktop-commit
if [[ ${1:-} != --force && -d $app && -f $stamp && $(cat "$stamp") == "$commit" ]]; then exit 0; fi

echo "$(date '+%F %T') building Bakery.app at ${commit:0:7}"
work=$(mktemp -d "${TMPDIR:-/tmp}/bakery-desktop.XXXXXX")
git -C "$repo" worktree add -q --detach "$work" origin/main
cd "$work"
npm ci --no-audit --no-fund --silent
# A shared target directory keeps Cargo's incremental build between runs.
CARGO_TARGET_DIR=$state/desktop-target npm run desktop:build -- --bundles app
built=$state/desktop-target/release/bundle/macos/Bakery.app

# Swap the bundle in one rename, so a launch never sees a half-copied app.
staged=$(dirname "$app")/.Bakery.app.new
rm -rf "$staged"
ditto "$built" "$staged"
old=""
if [[ -d $app ]]; then old=$(mktemp -d "${TMPDIR:-/tmp}/bakery-old.XXXXXX"); mv "$app" "$old/"; fi
mv "$staged" "$app"
[[ -n $old ]] && rm -rf "$old"
echo "$commit" > "$stamp"
echo "$(date '+%F %T') installed $app at ${commit:0:7}$(pgrep -qf "$app/Contents/MacOS" && echo "; quit and reopen Bakery to use it")"
