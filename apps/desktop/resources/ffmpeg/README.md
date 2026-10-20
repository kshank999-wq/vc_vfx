`scripts/fetch-ffmpeg.mjs` puts the bundled ffmpeg and ffprobe here, one
folder per `<platform>-<arch>`, verified against pinned SHA-256s. The binaries
are not committed. electron-builder copies the folder for the arch it builds
to `Resources/ffmpeg` (see `electron-builder.yml`). See
docs/spec/addendum-03-plates-colour-viewer.md.
