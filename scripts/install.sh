#!/usr/bin/env bash
set -euo pipefail
umask 077

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
SOURCE="$ROOT/src/cli.ts"
BIN_DIR="${GROK_SWAP_INSTALL_BIN_DIR:-$HOME/.local/bin}"
STATE_DIR="${GROK_SWAP_INSTALL_STATE_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/grok-swap}"
TARGET="$BIN_DIR/grok-swap"
RECEIPT="$STATE_DIR/deployed-sha"
EXPECTED_ORIGIN="${GROK_SWAP_INSTALL_EXPECTED_ORIGIN:-https://github.com/possibilities/grok-swap.git}"
TMP_PATH=""

cleanup() { [[ -z "$TMP_PATH" ]] || rm -f -- "$TMP_PATH"; }
trap cleanup EXIT
die() { printf 'grok-swap install: %s\n' "$1" >&2; exit "${2:-1}"; }
usage() {
  printf '%s\n' \
    'Usage: scripts/install.sh --install|--dry-run|--help' \
    '' \
    'Runs Bun frozen install, atomically links ~/.local/bin/grok-swap to this' \
    'checkout, and records the deployed Git SHA. State and accounts are untouched.'
}
owner_uid() { stat -c %u "$1" 2>/dev/null || stat -f %u "$1"; }
file_mode() { stat -c %a "$1" 2>/dev/null || stat -f %Lp "$1"; }
file_nlink() { stat -c %h "$1" 2>/dev/null || stat -f %l "$1"; }

validate_path() {
  local path="$1" label="$2" current="" remainder component platform
  [[ -n "$path" && "$path" == /* && "$path" != "/" && "$path" != *//* && "$path" != */../* && "$path" != */./* ]] || \
    die "refusing unsafe $label path: $path"
  platform="$(uname -s)"
  remainder="${path#/}"
  while [[ -n "$remainder" ]]; do
    component="${remainder%%/*}"
    current="$current/$component"
    [[ "$remainder" == */* ]] && remainder="${remainder#*/}" || remainder=""
    if [[ "$platform" == Darwin ]]; then
      case "$current:$(readlink "$current" 2>/dev/null || true)" in
        /tmp:private/tmp|/tmp:/private/tmp|/var:private/var|/var:/private/var) continue ;;
      esac
    fi
    [[ ! -L "$current" ]] || die "refusing symlinked $label path component: $current"
  done
}

validate_directory() {
  local dir="$1" label="$2" exact_mode="${3:-}" mode
  validate_path "$dir" "$label"
  [[ -d "$dir" && ! -L "$dir" ]] || die "refusing non-directory $label: $dir"
  [[ "$(owner_uid "$dir")" == "$(id -u)" ]] || die "refusing foreign $label: $dir"
  mode="$(file_mode "$dir")"
  [[ "$mode" =~ ^[0-7]{3,4}$ ]] || die "cannot validate $label permissions: $dir"
  (( (8#$mode & 0022) == 0 )) || die "refusing unsafe writable $label: $dir"
  [[ -z "$exact_mode" || "$mode" == "$exact_mode" ]] || die "refusing $label with permissions $mode (expected $exact_mode): $dir"
}

ensure_directory() {
  local dir="$1" label="$2" create_mode="$3"
  validate_path "$dir" "$label"
  if [[ ! -e "$dir" ]]; then mkdir -p -- "$dir"; chmod "$create_mode" "$dir"; fi
  validate_directory "$dir" "$label"
}

validate_source() {
  [[ -f "$SOURCE" && ! -L "$SOURCE" && -x "$SOURCE" ]] || die "source command is not a safe executable: $SOURCE"
  [[ "$(owner_uid "$SOURCE")" == "$(id -u)" ]] || die "source command has a foreign owner: $SOURCE"
  local top origin normalized expected_normalized
  top="$(git -C "$ROOT" rev-parse --show-toplevel 2>/dev/null)" || die "source is not a Git checkout: $ROOT"
  [[ "$(cd "$top" && pwd -P)" == "$ROOT" ]] || die "source is not the checkout root: $ROOT"
  if [[ -n "$(git -C "$ROOT" status --porcelain)" && "${GROK_SWAP_INSTALL_ALLOW_DIRTY:-0}" != 1 ]]; then
    die "source checkout has uncommitted changes: $ROOT"
  fi
  DEPLOYED_SHA="$(git -C "$ROOT" rev-parse --verify HEAD)"
  [[ "$DEPLOYED_SHA" =~ ^[0-9a-f]{40}$ ]] || die "could not derive deployed Git SHA"
  origin="$(git -C "$ROOT" remote get-url origin 2>/dev/null)" || die "source checkout has no origin"
  normalized="${origin%.git}"; normalized="${normalized#git@github.com:}"; normalized="${normalized#https://github.com/}"
  expected_normalized="${EXPECTED_ORIGIN%.git}"; expected_normalized="${expected_normalized#git@github.com:}"; expected_normalized="${expected_normalized#https://github.com/}"
  [[ "$normalized" == "$expected_normalized" ]] || die "source checkout has foreign origin: $origin"
}

validate_receipt() {
  [[ -f "$RECEIPT" && ! -L "$RECEIPT" ]] || die "refusing unsafe deployed receipt: $RECEIPT"
  [[ "$(owner_uid "$RECEIPT")" == "$(id -u)" && "$(file_nlink "$RECEIPT")" == 1 && "$(file_mode "$RECEIPT")" == 600 ]] || \
    die "refusing unsafe deployed receipt: $RECEIPT"
  IFS= read -r RECEIPT_SHA <"$RECEIPT" || die "refusing malformed deployed receipt: $RECEIPT"
  [[ "$RECEIPT_SHA" =~ ^[0-9a-f]{40}$ ]] || die "refusing malformed deployed receipt: $RECEIPT"
  printf '%s\n' "$RECEIPT_SHA" | cmp -s - "$RECEIPT" || die "refusing malformed deployed receipt: $RECEIPT"
}

classify_target() {
  TARGET_KIND=absent
  TARGET_ROOT=""
  if [[ ! -e "$TARGET" && ! -L "$TARGET" ]]; then return; fi
  if [[ -L "$TARGET" ]]; then
    local destination root origin normalized
    destination="$(readlink "$TARGET")"
    [[ "$destination" == /*/src/cli.ts ]] || die "refusing foreign command symlink: $TARGET"
    root="${destination%/src/cli.ts}"
    [[ -d "$root/.git" && -f "$destination" ]] || die "refusing stale command symlink: $TARGET"
    origin="$(git -C "$root" remote get-url origin 2>/dev/null)" || die "refusing unmanaged command symlink: $TARGET"
    normalized="${origin%.git}"; normalized="${normalized#git@github.com:}"; normalized="${normalized#https://github.com/}"
    [[ "$normalized" == "possibilities/grok-swap" ]] || die "refusing foreign command symlink: $TARGET"
    TARGET_SHA="$(git -C "$root" rev-parse --verify HEAD 2>/dev/null)"
    [[ "$TARGET_SHA" =~ ^[0-9a-f]{40}$ ]] || die "refusing command symlink without a deployed SHA: $TARGET"
    TARGET_KIND=managed
    TARGET_ROOT="$(cd "$root" && pwd -P)"
    return
  fi
  # Migrate only the marker used by the pre-release wrapper.
  if [[ -f "$TARGET" ]] && grep -q '^# grok-swap-installer-owned:v1$' "$TARGET"; then TARGET_KIND=legacy; return; fi
  die "refusing foreign command path: $TARGET"
}

install_grok_swap() {
  command -v bun >/dev/null 2>&1 || die "Bun is required but was not found"
  local bun_version
  bun_version="$(bun --version)"
  [[ "$(printf '%s\n%s\n' 1.3.14 "$bun_version" | sort -t. -k1,1n -k2,2n -k3,3n | head -1)" == 1.3.14 ]] || \
    die "Bun >= 1.3.14 is required (found $bun_version)"
  validate_source
  ensure_directory "$BIN_DIR" bin 755
  ensure_directory "$STATE_DIR" state 700
  validate_directory "$STATE_DIR" state 700
  classify_target
  if [[ -e "$RECEIPT" || -L "$RECEIPT" ]]; then
    [[ "$TARGET_KIND" != absent ]] || die "refusing uncorroborated deployed receipt: $RECEIPT"
    validate_receipt
    if [[ "$TARGET_KIND" == managed && "$TARGET_ROOT" != "$ROOT" && "$RECEIPT_SHA" != "$TARGET_SHA" ]]; then
      die "deployed receipt does not match the managed command"
    fi
  fi
  (cd "$ROOT" && bun install --frozen-lockfile)

  TMP_PATH="$BIN_DIR/.grok-swap-link.$$.$RANDOM"
  [[ ! -e "$TMP_PATH" && ! -L "$TMP_PATH" ]] || die "temporary command path already exists"
  ln -s -- "$SOURCE" "$TMP_PATH"
  mv -f -- "$TMP_PATH" "$TARGET"
  TMP_PATH=""
  [[ -L "$TARGET" && "$(readlink "$TARGET")" == "$SOURCE" ]] || die "installed command failed verification"

  TMP_PATH="$(mktemp "$STATE_DIR/.deployed-sha.XXXXXX")"
  chmod 600 "$TMP_PATH"
  printf '%s\n' "$DEPLOYED_SHA" >"$TMP_PATH"
  mv -f -- "$TMP_PATH" "$RECEIPT"
  TMP_PATH=""
  validate_receipt
  printf 'Installed %s at %s\n' "$TARGET" "$DEPLOYED_SHA"
}

case "${1:---install}" in
  --install) [[ $# -eq 1 ]] || die 'expected one installer option' 2; install_grok_swap ;;
  --dry-run)
    [[ $# -eq 1 ]] || die 'expected one installer option' 2
    validate_source
    printf 'Would frozen-install dependencies, link %s to %s, and record %s\n' "$TARGET" "$SOURCE" "$DEPLOYED_SHA"
    ;;
  --help|-h) usage ;;
  *) usage >&2; exit 2 ;;
esac
