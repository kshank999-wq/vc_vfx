#!/usr/bin/env bash
# Build the LGPL ffmpeg and ffprobe that ship inside the VC VFX installer.
#
#   scripts/build-ffmpeg-lgpl.sh <target> <out-dir>
#     target: darwin-arm64 | darwin-x64 (on a Mac of that arch)
#             win32-x64 (cross-compiled on Linux with mingw-w64)
#             linux-x64 (development and CI only)
#
# Why build rather than download: VC VFX is proprietary, so the ffmpeg it
# ships must be LGPL — configured without --enable-gpl and linked against
# nothing GPL. No maintained source offers static LGPL macOS builds, and
# building every target the same way from pinned sources means the
# "corresponding source" the LGPL asks us to offer is exactly the two pinned
# commits below, which the release publishes beside the binaries.
#
# What VC VFX needs from ffmpeg, all LGPL: decoding ProRes, DNxHR, H.264,
# HEVC, DPX, EXR, TIFF; encoding DPX, EXR, TIFF, PNG, MJPEG; the lut1d and
# colorchannelmixer filters; and zscale, from zimg (WTFPL, LGPL-compatible).
# Nothing autodetected is linked (--disable-autodetect), so a build machine's
# installed libraries cannot leak a GPL dependency in.
set -euo pipefail
# Arrays below may be empty; macOS's bash 3.2 calls an empty "${a[@]}"
# unbound under set -u, hence the ${a[@]+"${a[@]}"} form.

FFMPEG_TAG=n7.1
FFMPEG_COMMIT=b08d7969c550a804a59511c7b83f2dd8cc0499b8
ZIMG_TAG=release-3.0.5
ZIMG_COMMIT=e5b0de6bebbcbc66732ed5afaafef6b2c7dfef87
ZLIB_TAG=v1.3.1
ZLIB_COMMIT=51b7f2abdade71cd9bb0e7a373ef2610ec6f9daf

target=${1:?target}
out=$(mkdir -p "${2:?out-dir}" && cd "$2" && pwd)
work=$(mktemp -d)
prefix="$work/prefix"
jobs=$(getconf _NPROCESSORS_ONLN 2>/dev/null || sysctl -n hw.ncpu)

clone() { # url tag commit dir
  git -c advice.detachedHead=false clone -q --depth 1 --branch "$2" "$1" "$4"
  local got
  got=$(git -C "$4" rev-parse HEAD)
  [ "$got" = "$3" ] || { echo "$1 $2 is $got, expected $3" >&2; exit 1; }
}

clone https://github.com/sekrit-twc/zimg "$ZIMG_TAG" "$ZIMG_COMMIT" "$work/zimg"
clone https://github.com/madler/zlib "$ZLIB_TAG" "$ZLIB_COMMIT" "$work/zlib"
clone https://github.com/FFmpeg/FFmpeg "$FFMPEG_TAG" "$FFMPEG_COMMIT" "$work/ffmpeg"

cflags=""
host_args=()
zlib_env=()
# zimg is C++: libc++ on macOS, libstdc++ elsewhere.
cxxlib="-lstdc++"
ff_args=()
exe=""
case "$target" in
  darwin-arm64|darwin-x64)
    # Matches electron-builder.yml's minimumSystemVersion.
    cflags="-mmacosx-version-min=11.0"
    export MACOSX_DEPLOYMENT_TARGET=11.0
    cxxlib="-lc++"
    ;;
  win32-x64)
    host_args=(--host=x86_64-w64-mingw32)
    zlib_env=(CHOST=x86_64-w64-mingw32)
    ff_args=(--arch=x86_64 --target-os=mingw32 --cross-prefix=x86_64-w64-mingw32- --pkg-config=pkg-config --extra-ldflags=-static)
    exe=".exe"
    ;;
  linux-x64)
    ff_args=(--extra-ldflags=-static)
    ;;
  *) echo "Unknown target $target" >&2; exit 1 ;;
esac

# zlib (EXR's ZIP compression), built here so every target links the same one.
(
  cd "$work/zlib"
  env ${zlib_env[@]+"${zlib_env[@]}"} CFLAGS="$cflags -O2" ./configure --static --prefix="$prefix" >/dev/null
  make -s -j"$jobs" install >/dev/null
)

(
  cd "$work/zimg"
  ./autogen.sh >/dev/null
  CFLAGS="$cflags" CXXFLAGS="$cflags" ./configure -q ${host_args[@]+"${host_args[@]}"} --prefix="$prefix" --disable-shared --enable-static
  make -s -j"$jobs" install
)

(
  cd "$work/ffmpeg"
  PKG_CONFIG_PATH="$prefix/lib/pkgconfig" ./configure \
    --prefix="$prefix" \
    --disable-gpl --disable-nonfree --disable-version3 \
    --enable-static --disable-shared \
    --disable-autodetect --disable-doc --disable-ffplay --disable-debug --disable-network \
    --enable-libzimg --enable-zlib \
    --pkg-config-flags=--static \
    --extra-cflags="-I$prefix/include $cflags" \
    --extra-ldflags="-L$prefix/lib $cflags" \
    --extra-libs="$cxxlib -lm" \
    ${ff_args[@]+"${ff_args[@]}"} >/dev/null || { tail -30 ffbuild/config.log >&2; exit 1; }
  make -s -j"$jobs"
  cp "ffmpeg$exe" "ffprobe$exe" "$out/"
  cp COPYING.LGPLv2.1 "$out/LICENSE"
)

cat > "$out/README" <<EOF
FFmpeg $FFMPEG_TAG ($FFMPEG_COMMIT), built for VC VFX ($target).
Licensed under the GNU Lesser General Public License v2.1 (see LICENSE).
Configured without --enable-gpl, --enable-nonfree or --enable-version3.
Statically linked with zimg $ZIMG_TAG ($ZIMG_COMMIT), WTFPL, and
zlib $ZLIB_TAG ($ZLIB_COMMIT), zlib licence.

Corresponding source:
  https://github.com/FFmpeg/FFmpeg/tree/$FFMPEG_COMMIT
  https://github.com/sekrit-twc/zimg/tree/$ZIMG_COMMIT
  https://github.com/madler/zlib/tree/$ZLIB_COMMIT
Build script: apps/desktop/scripts/build-ffmpeg-lgpl.sh in VC VFX.

VC VFX runs these as separate programs. You may replace them with your own
build of FFmpeg in VC VFX's Settings (ffmpeg path).
EOF

# Refuse to hand over anything that is not what we meant to build. A
# cross-compiled Windows binary cannot run here, so it is checked by its
# configuration string instead.
if [ -z "$exe" ]; then
  # Captured first: grep -q closing a pipe early would fail it under pipefail.
  conf=$("$out/ffmpeg" -hide_banner -buildconf)
  lic=$("$out/ffmpeg" -hide_banner -L)
  encoders=$("$out/ffmpeg" -hide_banner -encoders)
  filters=$("$out/ffmpeg" -hide_banner -filters)
  grep -q "Lesser General Public" <<<"$lic" || { echo "Not LGPL" >&2; exit 1; }
  for e in exr dpx tiff png; do
    grep -qE "^ V[^ ]* $e " <<<"$encoders" || { echo "No $e encoder" >&2; exit 1; }
  done
  for f in zscale lut1d colorchannelmixer; do
    grep -qE "^ [^ ]+ $f " <<<"$filters" || { echo "No $f filter" >&2; exit 1; }
  done
else
  conf=$(grep -a -o 'FFMPEG_CONFIGURATION "[^"]*' "$work/ffmpeg/config.h" || true)
fi
case "$conf" in *enable-gpl*|*enable-nonfree*) echo "GPL or nonfree in configuration" >&2; exit 1 ;; esac

rm -rf "$work"
echo "Built LGPL ffmpeg for $target in $out"
