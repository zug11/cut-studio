#!/bin/bash
# The portable archive and source checkout share this launcher.
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
cd -- "$(dirname -- "$0")" || exit 1
fail() {
  printf '\n%s\n' "$1"
  if [ -t 0 ]; then read -r -p 'Press Return to close. ' unused_reply; fi
  exit 1
}
if ! command -v node >/dev/null 2>&1; then
  fail 'CUT Studio needs Node.js 22 or later. Install it from https://nodejs.org/ and launch again.'
fi
node -e 'if (Number(process.versions.node.split(".")[0]) < 22) process.exit(1)' || fail 'CUT Studio needs Node.js 22 or later. Update Node.js and launch again.'
for tool in ffmpeg ffprobe; do
  command -v "$tool" >/dev/null 2>&1 || fail 'CUT Studio needs FFmpeg and FFprobe. Install FFmpeg from https://ffmpeg.org/download.html and launch again.'
done
if [ -f runtime/server.cjs ]; then
  exec node runtime/server.cjs "$@"
fi
if [ ! -f dist/server.cjs ]; then
  [ -f package.json ] && [ -f src/standalone/server.ts ] && [ -f scripts/build.mjs ] || fail 'The CUT Studio runtime is missing. Extract the complete standalone archive and launch it again.'
  command -v npm >/dev/null 2>&1 || fail 'The source checkout needs npm for its first build. Install Node.js with npm, then launch again.'
  if [ ! -d node_modules/esbuild ]; then
    printf 'Preparing CUT Studio for its first launch…\n'
    npm ci || fail 'CUT Studio could not install its build dependencies. Check your internet connection and try again.'
  fi
  npm run build || fail 'CUT Studio could not build. Review the build output above.'
fi
exec node dist/server.cjs "$@"
