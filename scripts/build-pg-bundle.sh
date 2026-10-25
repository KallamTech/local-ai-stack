#!/usr/bin/env bash
# Assemble a self-contained, relocatable Postgres 15 + pgvector bundle
# (ship it as Resources/pg). Usage: build-pg-bundle.sh [OUT_DIR] (default ./pg).
# Per-platform:
#   1. fetch the relocatable zonky-lineage PG15 binaries via the matching
#      @embedded-postgres/<os-arch> package (server-only: postgres/initdb/pg_ctl
#      + libpq).
#   2. hydrate the package's symlink manifest, if present (unix packages ship
#      pg-symlinks.json; Windows has no symlinks).
#   3. add pgvector: mac/linux build vector.so from source (needs a PG15 dev
#      install at BUILD time only, via PG_CONFIG); Windows uses a prebuilt
#      vector.dll (SIDECARS_PGVECTOR_DLL) — building it needs MSVC + nmake against
#      PG15 headers, done on a Windows host.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=scripts/_platform.sh
source "$HERE/_platform.sh"
OUT="${1:-$PWD/pg}"
PG_PKG_VERSION="${SIDECARS_PG_PKG_VERSION:-15.18.0-beta.17}"
PGVECTOR_VERSION="${SIDECARS_PGVECTOR_VERSION:-v0.8.0}"
PGVECTOR_COMMIT="${SIDECARS_PGVECTOR_COMMIT:-}"
[ -n "$PGVECTOR_COMMIT" ] || [ "$PGVECTOR_VERSION" != v0.8.0 ] || PGVECTOR_COMMIT=2627c5ff775ae6d7aef0c430121ccf857842d2f2
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# @embedded-postgres package + default dev PG_CONFIG + extension layout per OS.
case "$OS/$ARCH" in
  mac/arm64) PG_PKG="darwin-arm64"; PG_CONFIG="${PG_CONFIG:-/opt/homebrew/opt/postgresql@15/bin/pg_config}" ;;
  linux/x64) PG_PKG="linux-x64"; PG_CONFIG="${PG_CONFIG:-/usr/lib/postgresql/15/bin/pg_config}" ;;
  linux/arm64) PG_PKG="linux-arm64"; PG_CONFIG="${PG_CONFIG:-/usr/lib/postgresql/15/bin/pg_config}" ;;
  windows/x64) PG_PKG="windows-x64"; PG_CONFIG="" ;;
  *) echo "no @embedded-postgres package for $OS/$ARCH" >&2; exit 1 ;;
esac
if [ "$OS" = windows ]; then
  EXT_LIB="$OUT/lib"; EXT_SHARE="$OUT/share/extension"
else
  EXT_LIB="$OUT/lib/postgresql"; EXT_SHARE="$OUT/share/postgresql/extension"
fi

echo "==> fetching @embedded-postgres/$PG_PKG@$PG_PKG_VERSION"
( cd "$WORK" && npm pack "@embedded-postgres/$PG_PKG@$PG_PKG_VERSION" >/dev/null )
tar -xzf "$WORK"/embedded-postgres-"$PG_PKG"-*.tgz -C "$WORK"
NATIVE="$WORK/package/native"

if [ -f "$NATIVE/pg-symlinks.json" ]; then
  echo "==> hydrating symlink manifest"
  node -e '
  const fs=require("fs"),path=require("path"),root=process.argv[1];
  for(const {source,target} of JSON.parse(fs.readFileSync(path.join(root,"pg-symlinks.json")))){
    const abs=path.join(root,"..",target); const dir=path.dirname(abs);
    const rel=path.relative(dir, path.join(root,"..",source));
    try{fs.unlinkSync(abs)}catch{}; fs.symlinkSync(rel,abs);
  }' "$NATIVE"
fi

echo "==> assembling bundle at $OUT"
rm -rf "$OUT"; mkdir -p "$OUT"
cp -R "$NATIVE/bin" "$NATIVE/lib" "$NATIVE/share" "$OUT/"
mkdir -p "$EXT_LIB" "$EXT_SHARE"

echo "==> pgvector $PGVECTOR_VERSION"
if [ "$OS" = windows ]; then
  # vector.dll must be built with MSVC/nmake against PG15 headers on a Windows
  # host. Provide it via SIDECARS_PGVECTOR_DLL (+ a
  # SIDECARS_PGVECTOR_SQLDIR holding vector.control + vector--*.sql).
  # SIDECARS_PGVECTOR_SQLDIR is the pgvector SOURCE root (vector.control at the
  # top, the versioned scripts under sql/), i.e. the checkout nmake ran in.
  : "${SIDECARS_PGVECTOR_DLL:?set SIDECARS_PGVECTOR_DLL to a PG15-built vector.dll}"
  : "${SIDECARS_PGVECTOR_SQLDIR:?set SIDECARS_PGVECTOR_SQLDIR to the pgvector source root}"
  cp "$SIDECARS_PGVECTOR_DLL" "$EXT_LIB/vector.dll"
  cp "$SIDECARS_PGVECTOR_SQLDIR/vector.control" "$EXT_SHARE/"
  cp "$SIDECARS_PGVECTOR_SQLDIR"/sql/vector--*.sql "$EXT_SHARE/"
else
  [ -x "$PG_CONFIG" ] || { echo "ERROR: PG_CONFIG not found ($PG_CONFIG). Install postgresql-15 dev or set PG_CONFIG." >&2; exit 1; }
  git clone --depth 1 --branch "$PGVECTOR_VERSION" https://github.com/pgvector/pgvector.git "$WORK/pgvector" >/dev/null 2>&1
  [ -n "$PGVECTOR_COMMIT" ] || { echo "commit not pinned for pgvector $PGVECTOR_VERSION — set SIDECARS_PGVECTOR_COMMIT" >&2; exit 1; }
  _commit="$(git -C "$WORK/pgvector" rev-parse HEAD)"
  [ "$_commit" = "$PGVECTOR_COMMIT" ] || { echo "pgvector $PGVECTOR_VERSION is $_commit, expected $PGVECTOR_COMMIT" >&2; exit 1; }
  make -C "$WORK/pgvector" PG_CONFIG="$PG_CONFIG" >/dev/null
  cp "$WORK/pgvector/vector.so" "$EXT_LIB/vector.so"
  cp "$WORK/pgvector/vector.control" "$EXT_SHARE/"
  cp "$WORK/pgvector"/sql/vector--*.sql "$EXT_SHARE/"
  [ "$OS" = mac ] && { echo "    vector.so deps:"; otool -L "$EXT_LIB/vector.so" | tail -n +2; }
fi

echo "==> done. bundle: $OUT"
echo "    postgres: $("$OUT/bin/postgres$EXE" --version 2>/dev/null || echo '(cannot exec on this host)')"
echo "    pgvector: $(ls "$EXT_SHARE"/vector--*.sql 2>/dev/null | tail -1 | xargs basename 2>/dev/null || echo missing)"
