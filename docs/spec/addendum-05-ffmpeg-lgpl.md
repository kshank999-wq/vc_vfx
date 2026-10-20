# Addendum 05 — LGPL ffmpeg

Addendum 03 bundled the static ffmpeg builds that `ffmpeg-static` installs.
Those are GPL. VC VFX is proprietary, so from this change the installer ships
an ffmpeg built LGPL-only, by this repository, from pinned sources.

## What is built

`apps/desktop/scripts/build-ffmpeg-lgpl.sh <target> <out>` clones, by tag and
checked commit:

| Source | Version | Licence |
| --- | --- | --- |
| FFmpeg | n7.1 (`b08d7969…`) | LGPL v2.1 |
| zimg | release-3.0.5 (`e5b0de6b…`) | WTFPL |
| zlib | v1.3.1 (`51b7f2ab…`) | zlib |

and configures FFmpeg with `--disable-gpl --disable-nonfree --disable-version3
--disable-autodetect --disable-network --enable-libzimg --enable-zlib`,
statically linked. `--disable-autodetect` means nothing installed on the build
machine can be linked in by accident. The script refuses its own output unless
it reports the LGPL, has the EXR/DPX/TIFF/PNG encoders and the zscale, lut1d
and colorchannelmixer filters, and its configuration has no `--enable-gpl` or
`--enable-nonfree`.

Nothing VC VFX uses is lost. The GPL-only parts of ffmpeg are encoders such as
x264/x265 (writing H.264/HEVC), which plates never need; decoding ProRes,
DNxHR, H.264 and HEVC is native and LGPL.

Verified here: linux-x64 built and passed every real-ffmpeg plate and viewer
test (`colour-pipeline.test.ts`, including LogC3 grey → ACEScg 0.18);
win32-x64 cross-built with mingw-w64 and imports only Windows system DLLs.
macOS builds on GitHub's runners (macos-14 for arm64, macos-15-intel for
x64) and passes the script's own LGPL/encoder/filter checks there; both
binaries link only Apple system libraries (CoreFoundation, CoreMedia,
CoreVideo, libSystem, libc++). Published as release `ffmpeg-lgpl-n7.1-1`
(workflow run 39491427112) and pinned; the colour-pipeline tests pass on the
published linux-x64 build. Not yet run on a real Mac or Windows machine, nor
signed/notarised inside the app.

## How it reaches the installer

1. `.github/workflows/ffmpeg-lgpl.yml` (run by hand) builds darwin-arm64,
   darwin-x64, win32-x64 and linux-x64 and publishes release
   `ffmpeg-lgpl-n7.1-1` with the gzipped binaries, each target's LICENSE and
   README, and `SHA256SUMS` of the files as installed.
2. The sums are copied into `LGPL_PINNED` in `scripts/fetch-ffmpeg.mjs`.
   Until they are, `package:mac` and `package:win` stop with an instruction
   rather than ship anything else.
3. linux-x64 (development and CI only, never shipped) uses the same LGPL
   release.

## Obligations, and where each is met

- **Notice and licence text.** Each target ships `LICENSE.txt` (LGPL v2.1)
  and `README.txt` (versions, commits, configuration) beside the binaries.
  The About box and the download page name FFmpeg and the LGPL.
- **Corresponding source.** The release notes and README link the exact
  FFmpeg, zimg and zlib commits and this repository's build script.
- **Replaceable.** ffmpeg runs as a separate program and Settings accepts any
  ffmpeg path.

This is the engineering side; a lawyer should confirm it before launch.
