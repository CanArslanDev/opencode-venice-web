#!/bin/sh
# opencode-venice-web installer
#
#   ./install.sh                 install, wire OpenCode, start the background service
#   ./install.sh --default       ... and make the web model OpenCode's default
#   ./install.sh --no-service    ... without launchd/systemd
#   ./install.sh --no-sync       ... without touching opencode.json
#   ./install.sh --login         ... and sign in from this terminal
#   ./install.sh --uninstall     remove code, service and the provider entry
#   ./install.sh --uninstall --purge   ... and delete the stored session
#
#   curl -fsSL https://raw.githubusercontent.com/CanArslanDev/opencode-venice-web/main/install.sh | sh -s -- --default
#
# Environment:
#   VENICE_WEB_INSTALL_DIR  where the code is copied   (default ~/.local/share/opencode-venice-web)
#   VENICE_WEB_CONFIG_DIR   where the session lives    (default ~/.config/opencode/venice-web)
#   VENICE_WEB_PORT         proxy port                 (default 3456)
#   OPENCODE_CONFIG         opencode.json to patch     (default ~/.config/opencode/opencode.json)
set -eu

REPO_URL="https://github.com/CanArslanDev/opencode-venice-web.git"
LABEL="ai.opencode.venice-web"

XDG_CONFIG="${XDG_CONFIG_HOME:-$HOME/.config}"
INSTALL_DIR="${VENICE_WEB_INSTALL_DIR:-$HOME/.local/share/opencode-venice-web}"
CONFIG_DIR="${VENICE_WEB_CONFIG_DIR:-$XDG_CONFIG/opencode/venice-web}"
CONFIG_FILE="${OPENCODE_CONFIG:-$XDG_CONFIG/opencode/opencode.json}"

SERVICE=1
SYNC=1
DO_LOGIN=0
DEFAULT=0
UNINSTALL=0
PURGE=0

for arg in "$@"; do
  case "$arg" in
    --no-service) SERVICE=0 ;;
    --no-sync) SYNC=0 ;;
    --default) DEFAULT=1 ;;
    --login) DO_LOGIN=1 ;;
    --uninstall) UNINSTALL=1 ;;
    --purge) PURGE=1 ;;
    -h|--help) sed -n '2,22p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) printf 'unknown option: %s\n' "$arg" >&2; exit 2 ;;
  esac
done

say() { printf '%s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
UNIT="$XDG_CONFIG/systemd/user/$LABEL.service"

stop_service() {
  if [ "$(uname -s)" = "Darwin" ] && have launchctl; then
    launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
    # launchd unloads asynchronously; bootstrapping too early fails with EIO.
    i=0
    while launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1; do
      i=$((i + 1))
      [ "$i" -gt 20 ] && break
      sleep 0.25
    done
  elif have systemctl; then
    systemctl --user disable --now "$LABEL.service" 2>/dev/null || true
  fi
}

start_service() {
  if [ "$(uname -s)" = "Darwin" ] && have launchctl; then
    launchctl bootstrap "gui/$(id -u)" "$PLIST" 2>/dev/null && return 0
    sleep 1
    launchctl bootstrap "gui/$(id -u)" "$PLIST" 2>/dev/null && return 0
    launchctl load -w "$PLIST" 2>/dev/null && return 0
    return 1
  fi
  systemctl --user enable --now "$LABEL.service"
}

# ------------------------------------------------------------------- uninstall

if [ "$UNINSTALL" = "1" ]; then
  stop_service
  rm -f "$PLIST" "$UNIT"
  if [ "$SYNC" = "1" ] && [ -f "$INSTALL_DIR/src/sync.mjs" ]; then
    node "$INSTALL_DIR/src/sync.mjs" --remove --config "$CONFIG_FILE" || true
  fi
  rm -rf "$INSTALL_DIR"
  if [ "$PURGE" = "1" ]; then
    rm -rf "$CONFIG_DIR"
    say "removed $INSTALL_DIR and $CONFIG_DIR"
  else
    say "removed $INSTALL_DIR (session kept in $CONFIG_DIR)"
  fi
  exit 0
fi

# ------------------------------------------------------------------- checks

have node || die "node 22+ is required (https://nodejs.org)"
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
[ "$NODE_MAJOR" -ge 22 ] || die "node 22+ is required (found $(node -v))"
NODE_BIN=$(command -v node)

# ------------------------------------------------------------------- copy code

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
SOURCE_DIR="$SCRIPT_DIR"
if [ ! -f "$SOURCE_DIR/src/proxy.mjs" ]; then
  have git || die "git is required when installing from a pipe"
  CLONE_DIR=$(mktemp -d)
  say "cloning $REPO_URL"
  git clone --depth 1 "$REPO_URL" "$CLONE_DIR" >/dev/null 2>&1 || die "clone failed"
  SOURCE_DIR="$CLONE_DIR"
fi

mkdir -p "$INSTALL_DIR" "$CONFIG_DIR"
for item in src packaging docs package.json README.md CLAUDE.md LICENSE; do
  [ -e "$SOURCE_DIR/$item" ] || continue
  rm -rf "$INSTALL_DIR/$item"
  cp -R "$SOURCE_DIR/$item" "$INSTALL_DIR/$item"
done
say "installed code in $INSTALL_DIR"

# ------------------------------------------------------------------- opencode

if [ "$SYNC" = "1" ]; then
  if [ "$DEFAULT" = "1" ]; then
    node "$INSTALL_DIR/src/sync.mjs" --config "$CONFIG_FILE" --default
  else
    node "$INSTALL_DIR/src/sync.mjs" --config "$CONFIG_FILE"
  fi
else
  say "skipped opencode.json (--no-sync)"
fi

# ------------------------------------------------------------------- service

if [ "$SERVICE" = "1" ]; then
  if [ "$(uname -s)" = "Darwin" ] && have launchctl; then
    mkdir -p "$HOME/Library/LaunchAgents"
    sed -e "s|__NODE__|$NODE_BIN|g" \
        -e "s|__PROXY__|$INSTALL_DIR/src/proxy.mjs|g" \
        -e "s|__LOG__|$CONFIG_DIR/proxy.log|g" \
        "$INSTALL_DIR/packaging/$LABEL.plist" > "$PLIST"
    stop_service
    start_service || die "could not start the launchd service ($LABEL); start it manually: launchctl load -w $PLIST"
    say "background service installed ($LABEL)"
  elif have systemctl; then
    mkdir -p "$(dirname "$UNIT")"
    sed -e "s|__NODE__|$NODE_BIN|g" \
        -e "s|__PROXY__|$INSTALL_DIR/src/proxy.mjs|g" \
        -e "s|__LOG__|$CONFIG_DIR/proxy.log|g" \
        "$INSTALL_DIR/packaging/$LABEL.service" > "$UNIT"
    systemctl --user daemon-reload
    start_service || say "start it with: systemctl --user start $LABEL"
    say "background service installed ($LABEL)"
  else
    say "no launchd/systemd found; run it manually: node $INSTALL_DIR/src/proxy.mjs"
  fi
else
  say "skipped background service (--no-service)"
fi

# ------------------------------------------------------------------- sign in

if [ "$DO_LOGIN" = "1" ] || [ ! -f "$CONFIG_DIR/session.json" ]; then
  say ""
  say "signing in - reads the venice.ai cookie out of your browser"
  node "$INSTALL_DIR/src/login.mjs" || die "sign-in failed: open venice.ai in your browser, then run node $INSTALL_DIR/src/login.mjs"
fi

say ""
say "finished. verify with:  node $INSTALL_DIR/src/doctor.mjs"
say "then restart OpenCode and choose a model such as venice-web/deepseek-v4-1-flash-free"
