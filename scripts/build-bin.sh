#!/usr/bin/env bash
# Fetch/build the native sidecar binaries into OUT_DIR (default ./bin), next to
# a pg/ bundle from build-pg-bundle.sh. Ship both as extraResources.
#
# Usage: build-bin.sh [OUT_DIR] [component...]
#   components: postgrest redis ollama whisper   (default: postgrest redis)
#
#   postgrest  pinned release, sha256 per asset (upstream publishes none; the
#              built-in digests were taken from the v14.15 assets); libpq
#              install name rewritten on mac to @executable_path/../pg/lib
#              (hardened runtime ignores DYLD_*). linux x64: static release.
#              windows: libpq.dll copied from pg/.
#   redis      mac/linux: built from the download.redis.io tarball (sha256
#              from redis/redis-hashes; system malloc, no TLS → only system
#              libs, relocatable). windows: Microsoft Garnet (RESP-compatible)
#              built from a pinned tag+commit, self-contained, in OUT_DIR/garnet/.
#   ollama     pinned release archive, sha256 from its sha256sum.txt; the
#              binary needs its accelerator libs in the same dir, so it is
#              extracted flat into OUT_DIR.
#   whisper    whisper.cpp built from a pinned tag+commit (no macOS server
#              binary is published); static + embedded Metal library → one
#              relocatable binary. A stamp (tag, commit, sha256) guards reuse.
#
# Every download is sha256-checked and every checkout commit-checked. The
# built-in digests belong to the default versions: overriding a
# SIDECARS_*_VERSION needs the matching SIDECARS_*_SHA256 / SIDECARS_*_COMMIT.
# Target defaults to the host; override with SIDECARS_TARGET_OS/ARCH.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=scripts/_platform.sh
source "$HERE/_platform.sh"
BIN="${1:-$PWD/bin}"
shift || true
COMPONENTS=("$@")
[ ${#COMPONENTS[@]} -eq 0 ] && COMPONENTS=(postgrest redis)
PG_DIR="${SIDECARS_PG_DIR:-$(dirname "$BIN")/pg}"
mkdir -p "$BIN"
BIN="$(cd "$BIN" && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

want() { local c; for c in "${COMPONENTS[@]}"; do [ "$c" = "$1" ] && return 0; done; return 1; }

# fetch URL OUT SHA256: download, then refuse anything but the pinned digest.
fetch() {
  [ -n "$3" ] || { echo "checksum not pinned for $(basename "$2") — set the matching SIDECARS_*_SHA256 after verifying the asset yourself" >&2; exit 1; }
  curl -sSfL -o "$2" "$1"
  echo "$3  $2" | shasum -a 256 -c - >/dev/null 2>&1 || { echo "sha256 mismatch for $1 (expected $3, got $(shasum -a 256 "$2" | cut -d' ' -f1))" >&2; exit 1; }
}

# pin_commit DIR NAME EXPECTED: a moved tag must not slip in different code.
pin_commit() {
  [ -n "$3" ] || { echo "commit not pinned for $2 — set the matching SIDECARS_*_COMMIT" >&2; exit 1; }
  local actual; actual="$(git -C "$1" rev-parse HEAD)"
  [ "$actual" = "$3" ] || { echo "$2 is $actual, expected $3" >&2; exit 1; }
}

echo "==> target: $OS/$ARCH → $BIN"

if want postgrest; then
  POSTGREST_VERSION="${SIDECARS_POSTGREST_VERSION:-v14.15}"
  echo "==> PostgREST $POSTGREST_VERSION"
  _base="https://github.com/PostgREST/postgrest/releases/download/$POSTGREST_VERSION"
  if [ ! -x "$BIN/postgrest$EXE" ]; then
    case "$OS/$ARCH" in
      mac/arm64) _asset="postgrest-$POSTGREST_VERSION-macos-aarch64.tar.xz"; _sha=c12902fbc61d5af244838c44288c4d47df488961e17be434c5533e9dcde663a8 ;;
      linux/x64) _asset="postgrest-$POSTGREST_VERSION-linux-static-x86-64.tar.xz"; _sha=4e78c7f065a6c36f350c7177f5fa9bb77ea380c67b8bf40f2fc9130d857678dc ;;
      linux/arm64) _asset="postgrest-$POSTGREST_VERSION-ubuntu-aarch64.tar.xz"; _sha=1eb007298c1536ba865e741da7eece6fba6db3da904c599abd15d9c3debe6c2f ;;
      windows/x64) _asset="postgrest-$POSTGREST_VERSION-windows-x86-64.zip"; _sha=cf1a1ca713556fd9f82f73478c23b71ef92d9a104b47103714192dc9d7c0ff99 ;;
      *) echo "no PostgREST asset for $OS/$ARCH" >&2; exit 1 ;;
    esac
    [ "$POSTGREST_VERSION" = v14.15 ] || _sha=""
    fetch "$_base/$_asset" "$WORK/$_asset" "${SIDECARS_POSTGREST_SHA256:-$_sha}"
    case "$_asset" in
      *.zip) unzip -o -q "$WORK/$_asset" -d "$BIN" ;;
      *) tar -xJf "$WORK/$_asset" -C "$BIN" ;;
    esac
    chmod +x "$BIN/postgrest$EXE" 2>/dev/null || true
  fi
  if [ "$OS" = mac ] && otool -L "$BIN/postgrest" | grep -q '/opt/homebrew/opt/libpq/lib/libpq.5.dylib'; then
    install_name_tool -change /opt/homebrew/opt/libpq/lib/libpq.5.dylib \
      @executable_path/../pg/lib/libpq.5.dylib "$BIN/postgrest"
  fi
  if [ "$OS" = windows ]; then
    _libpq="$(find "$PG_DIR" -name 'libpq*.dll' 2>/dev/null | head -1 || true)"
    [ -n "$_libpq" ] && cp "$_libpq" "$BIN/" || echo "WARN: libpq.dll not found in $PG_DIR — build pg/ first" >&2
  fi
  if [ "$OS" = mac ] && [ -d "$PG_DIR/lib" ]; then
    echo "    verify libpq resolves from pg/ without DYLD_FALLBACK:"
    env -u DYLD_FALLBACK_LIBRARY_PATH "$BIN/postgrest" --version
  fi
fi

if want redis; then
  REDIS_VERSION="${SIDECARS_REDIS_VERSION:-7.4.2}"
  REDIS_SHA256="${SIDECARS_REDIS_SHA256:-}"
  [ -n "$REDIS_SHA256" ] || [ "$REDIS_VERSION" != 7.4.2 ] || REDIS_SHA256=4ddebbf09061cbb589011786febdb34f29767dd7f89dbe712d2b68e808af6a1f
  if [ "$OS" = windows ]; then
    _garnet_ver="${SIDECARS_GARNET_VERSION:-v2.1.5}"
    _garnet_commit="${SIDECARS_GARNET_COMMIT:-}"
    [ -n "$_garnet_commit" ] || [ "$_garnet_ver" != v2.1.5 ] || _garnet_commit=00dc848633d66e3f7212d40614c2e697152d388a
    echo "==> Garnet $_garnet_ver (windows)"
    if [ ! -f "$BIN/garnet/GarnetServer.exe" ]; then
      mkdir -p "$BIN/garnet"
      if [ -n "${SIDECARS_GARNET_WIN_URL:-}" ]; then
        fetch "$SIDECARS_GARNET_WIN_URL" "$WORK/garnet.zip" "${SIDECARS_GARNET_WIN_SHA256:-}"
        unzip -o -q "$WORK/garnet.zip" -d "$BIN/garnet"
      else
        # Release zips need a .NET runtime installed; publish self-contained instead.
        command -v dotnet >/dev/null || { echo "dotnet SDK required (or set SIDECARS_GARNET_WIN_URL)" >&2; exit 1; }
        git clone --depth 1 --branch "$_garnet_ver" https://github.com/microsoft/garnet.git "$WORK/garnet" >/dev/null 2>&1
        pin_commit "$WORK/garnet" "garnet $_garnet_ver" "$_garnet_commit"
        dotnet publish "$WORK/garnet/main/GarnetServer/GarnetServer.csproj" \
          -c Release -r win-x64 --self-contained true \
          -p:PublishSingleFile=true -p:PublishReadyToRun=true -p:IncludeNativeLibrariesForSelfExtract=false \
          -o "$BIN/garnet" >/dev/null
      fi
    fi
  else
    echo "==> Redis $REDIS_VERSION"
    if [ ! -x "$BIN/redis-server" ]; then
      fetch "https://download.redis.io/releases/redis-$REDIS_VERSION.tar.gz" "$WORK/redis.tar.gz" "$REDIS_SHA256"
      tar -xzf "$WORK/redis.tar.gz" -C "$WORK"
      make -C "$WORK/redis-$REDIS_VERSION" MALLOC=libc BUILD_TLS=no -j"$NPROC" redis-server >/dev/null 2>&1
      cp "$WORK/redis-$REDIS_VERSION/src/redis-server" "$BIN/redis-server"
    fi
    "$BIN/redis-server" --version | head -1 || true
  fi
fi

if want ollama; then
  OLLAMA_VERSION="${SIDECARS_OLLAMA_VERSION:-v0.40.11}"
  echo "==> Ollama $OLLAMA_VERSION"
  if [ ! -x "$BIN/ollama$EXE" ]; then
    _base="https://github.com/ollama/ollama/releases/download/$OLLAMA_VERSION"
    case "$OS/$ARCH" in
      mac/*) _asset=ollama-darwin.tgz; _sha=aea7d3f2e32371b7644a6e2ec8d4f26820a0e3965918cce8a46cef3e947f6291 ;;
      linux/x64) _asset=ollama-linux-amd64.tar.zst; _sha=7bedab90dd122661be78798e9f0edf37fccf0cccf2699d2c58ea1a3afdc04b6d ;;
      linux/arm64) _asset=ollama-linux-arm64.tar.zst; _sha=77b278837b9e62c172f77d703675be4c52c8054e9075639031a9a6d5a53f1924 ;;
      windows/x64) _asset=ollama-windows-amd64.zip; _sha=bda4a493ba8a7c24d57263cd843cd68cee84f44aed4299eeed532acad7eda12a ;;
      *) echo "no Ollama asset for $OS/$ARCH" >&2; exit 1 ;;
    esac
    [ "$OLLAMA_VERSION" = v0.40.11 ] || _sha=""
    fetch "$_base/$_asset" "$WORK/$_asset" "${SIDECARS_OLLAMA_SHA256:-$_sha}"
    case "$_asset" in
      *.zip) unzip -o -q "$WORK/$_asset" -d "$BIN" ;;
      *.tar.zst) tar --zstd -xf "$WORK/$_asset" -C "$BIN" ;;
      *) tar -xzf "$WORK/$_asset" -C "$BIN" ;;
    esac
    chmod +x "$BIN/ollama$EXE" 2>/dev/null || true
  fi
  echo "    $("$BIN/ollama$EXE" --version 2>/dev/null | head -1 || echo unknown)"
fi

if want whisper; then
  WHISPER_CPP_VERSION="${SIDECARS_WHISPER_CPP_VERSION:-v1.9.4}"
  WHISPER_CPP_COMMIT="${SIDECARS_WHISPER_CPP_COMMIT:-927cfce34f31707e17f2bff35c349632fb9e2c3a}"
  CMAKE_VERSION="${SIDECARS_CMAKE_VERSION:-4.4.3}"
  WHISPER_BIN="$BIN/whisper-server$EXE"
  WHISPER_STAMP="$BIN/whisper-server.stamp"
  echo "==> whisper-server $WHISPER_CPP_VERSION"
  stamp_ok() {
    [ -x "$WHISPER_BIN" ] && [ -f "$WHISPER_STAMP" ] || return 1
    [ "$WHISPER_CPP_VERSION $WHISPER_CPP_COMMIT $(shasum -a 256 "$WHISPER_BIN" | cut -d' ' -f1)" = "$(cat "$WHISPER_STAMP")" ]
  }
  if [ "$OS" = windows ]; then
    echo "    not supported on Windows yet" >&2
  elif stamp_ok; then
    echo "    reusing stamped build"
  else
    rm -f "$WHISPER_BIN" "$WHISPER_STAMP"
    if command -v uvx >/dev/null; then
      CMAKE=(uvx --from "cmake==$CMAKE_VERSION" cmake)
    elif command -v cmake >/dev/null; then
      echo "    uv not found — using system cmake, not the pinned $CMAKE_VERSION" >&2
      CMAKE=(cmake)
    else
      echo "uv or cmake is required to build whisper-server" >&2
      exit 1
    fi
    _src="$WORK/whisper.cpp"
    git clone -q --depth 1 --branch "$WHISPER_CPP_VERSION" https://github.com/ggml-org/whisper.cpp.git "$_src"
    pin_commit "$_src" "whisper.cpp $WHISPER_CPP_VERSION" "$WHISPER_CPP_COMMIT"
    _flags=(-DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF -DGGML_NATIVE=OFF
      -DGGML_OPENMP=OFF -DWHISPER_BUILD_EXAMPLES=ON -DWHISPER_BUILD_SERVER=ON
      -DWHISPER_BUILD_TESTS=OFF -DWHISPER_SDL2=OFF -DWHISPER_CURL=OFF)
    if [ "$OS" = mac ]; then
      _flags+=(-DGGML_METAL=ON -DGGML_METAL_EMBED_LIBRARY=ON
        "-DCMAKE_OSX_ARCHITECTURES=$([ "$ARCH" = arm64 ] && echo arm64 || echo x86_64)")
    fi
    "${CMAKE[@]}" -S "$_src" -B "$_src/build" "${_flags[@]}" >/dev/null
    "${CMAKE[@]}" --build "$_src/build" --config Release --target whisper-server -j"$NPROC" >/dev/null
    cp "$_src/build/bin/whisper-server" "$WHISPER_BIN"
    echo "$WHISPER_CPP_VERSION $WHISPER_CPP_COMMIT $(shasum -a 256 "$WHISPER_BIN" | cut -d' ' -f1)" >"$WHISPER_STAMP"
  fi
fi

echo "✓ done: $BIN"
