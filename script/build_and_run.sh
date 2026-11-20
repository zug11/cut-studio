#!/bin/bash
set -euo pipefail
MODE="${1:-run}"
TASK_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$TASK_ROOT"
if pgrep -x CUTStudio >/dev/null 2>&1; then
  # Let the normal unsaved-change gate run. Never force-close a user's edit.
  osascript -e 'tell application id "studio.cut.app" to quit'
  for _ in $(seq 1 100); do
    if ! pgrep -x CUTStudio >/dev/null 2>&1; then break; fi
    sleep 0.1
  done
  if pgrep -x CUTStudio >/dev/null 2>&1; then echo 'CUT Studio is still open. Save or cancel your edit before rebuilding.' >&2; exit 1; fi
fi
npm run package:mac
APP_BUNDLE="$TASK_ROOT/dist/CUT Studio.app"
case "$MODE" in
  run) /usr/bin/open -n "$APP_BUNDLE" ;;
  --verify|verify) /usr/bin/open -n "$APP_BUNDLE"; sleep 1; pgrep -x CUTStudio >/dev/null ;;
  --logs|logs|--telemetry|telemetry) /usr/bin/open -n "$APP_BUNDLE"; /usr/bin/log stream --info --style compact --predicate 'process == "CUTStudio"' ;;
  --debug|debug) /usr/bin/open -n "$APP_BUNDLE"; sleep 1; lldb -p "$(pgrep -x CUTStudio | head -1)" ;;
  *) echo 'Usage: ./script/build_and_run.sh [run|--verify|--logs|--telemetry|--debug]' >&2; exit 2 ;;
esac
