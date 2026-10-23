#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=receiver-entrypoint.sh
source "$SCRIPT_DIR/receiver-entrypoint.sh"

assert_eq() {
    local expected="$1"
    local actual="$2"
    local label="$3"

    if [[ "$actual" != "$expected" ]]; then
        echo "FAIL: $label" >&2
        echo "  expected: $expected" >&2
        echo "  actual:   $actual" >&2
        exit 1
    fi
}

assert_eq \
    "rtmp://rtmp-server:1935/live/stream" \
    "$(build_rtmp_target "" "")" \
    "defaults preserve the existing local RTMP target"

assert_eq \
    "rtmps://example.invalid/live/custom-key" \
    "$(build_rtmp_target "rtmps://example.invalid/live/" "/custom-key")" \
    "configured RTMP server and stream key are normalized"

if build_rtmp_target "https://example.invalid/live" "key" >/dev/null 2>&1; then
    echo "FAIL: non-RTMP server URL should be rejected" >&2
    exit 1
fi

echo "receiver RTMP target tests passed"
