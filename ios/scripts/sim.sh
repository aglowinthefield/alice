#!/usr/bin/env bash
# Build the iOS app on the Mac (visitingstar), install it on the booted simulator, launch it,
# and pull a screenshot back. Usage: ios/scripts/sim.sh [build|run|shot NAME] [launch args...]
set -euo pipefail
HOST=${MAC_HOST:-visitingstar}
HERE=$(cd "$(dirname "$0")/.." && pwd)
REMOTE=code/alice-ios
mode=${1:-run}; shift || true
rsync -az --delete --exclude build --exclude '*.xcodeproj' "$HERE/" "$HOST:$REMOTE/"
# ALICE_BOARD, ALICE_CARD and ALICE_URL fall back to their old BAKERY_ names.
ssh -o BatchMode=yes "$HOST" env ALICE_BOARD="${ALICE_BOARD:-${BAKERY_BOARD:-}}" ALICE_CARD="${ALICE_CARD:-${BAKERY_CARD:-}}" TEST_FILTER="${TEST_FILTER:-}" ALICE_URL="${ALICE_URL:-${BAKERY_URL:-}}" bash -s -- "$mode" "$@" <<'REMOTE'
set -euo pipefail
export PATH=/opt/homebrew/bin:$PATH
cd ~/code/alice-ios
mode=$1; shift
xcodegen generate --quiet
DEV=$(xcrun simctl list devices booted | grep -m1 -oE '[0-9A-F-]{36}')
if [ "$mode" = test ]; then
  # TEST_RUNNER_ vars reach the test process; ALICE_BOARD names the board the flows use.
  rm -f /tmp/alice-uitest-*.png
  TEST_RUNNER_ALICE_CARD=${ALICE_CARD:-} TEST_RUNNER_ALICE_BOARD=${ALICE_BOARD:?set ALICE_BOARD} TEST_RUNNER_ALICE_URL=${ALICE_URL:-http://mochi:4317} \
  xcodebuild -project Alice.xcodeproj -scheme Alice -sdk iphonesimulator -destination "id=$DEV" \
    -derivedDataPath build CODE_SIGNING_ALLOWED=NO ${TEST_FILTER:+-only-testing:AliceUITests/$TEST_FILTER} test 2>&1 \
    | grep -E 'error:|Test Case.*(passed|failed|skipped)|skipped|XCTAssert|TEST (SUCCEEDED|FAILED)' | head -60 || true
  exit 0
fi
xcodebuild -project Alice.xcodeproj -scheme Alice -configuration Debug -sdk iphonesimulator \
  -destination "id=$DEV" -derivedDataPath build CODE_SIGNING_ALLOWED=NO build 2>&1 \
  | grep -E 'error:|warning: unre|BUILD (SUCCEEDED|FAILED)' | grep -v '^ld: warning' | head -60
test -d build/Build/Products/Debug-iphonesimulator/Alice.app || exit 1
[ "$mode" = build ] && exit 0
xcrun simctl terminate "$DEV" dev.bakery.ios 2>/dev/null || true
xcrun simctl install "$DEV" build/Build/Products/Debug-iphonesimulator/Alice.app
if [ "$mode" = shot ]; then
  name=$1; shift
  xcrun simctl launch "$DEV" dev.bakery.ios "$@" >/dev/null
  sleep ${SHOT_WAIT:-5}
  xcrun simctl io "$DEV" screenshot "/tmp/alice-$name.png" >/dev/null 2>&1
  echo "shot /tmp/alice-$name.png"
else
  xcrun simctl launch "$DEV" dev.bakery.ios "$@"
fi
REMOTE
if [ "$mode" = test ]; then
  mkdir -p /tmp/alice-ios-shots
  ssh "$HOST" bash -c "'cd /tmp && tar cf - alice-uitest-*.png'" | tar xf - -C /tmp/alice-ios-shots || echo "no screenshots"
  exit 0
fi
if [ "$mode" = shot ]; then
  mkdir -p /tmp/alice-ios-shots
  scp -q "$HOST:/tmp/alice-$1.png" "/tmp/alice-ios-shots/$1.png"
  magick "/tmp/alice-ios-shots/$1.png" -resize 50% "/tmp/alice-ios-shots/$1.small.png" 2>/dev/null || true
  echo "/tmp/alice-ios-shots/$1.small.png"
fi
