#!/bin/bash
set -u

DEFAULT_RTMP_SERVER="rtmp://rtmp-server:1935/live"
DEFAULT_STREAM_KEY="stream"

build_rtmp_target() {
    local rtmp_server="${1:-$DEFAULT_RTMP_SERVER}"
    local stream_key="${2:-$DEFAULT_STREAM_KEY}"

    case "$rtmp_server" in
        rtmp://*|rtmps://*) ;;
        *)
            echo "RTMP_SERVER must start with rtmp:// or rtmps://" >&2
            return 64
            ;;
    esac

    printf '%s/%s\n' "${rtmp_server%/}" "${stream_key#/}"
}

main() {
    local rtmp_server="${RTMP_SERVER:-$DEFAULT_RTMP_SERVER}"
    local stream_key="${STREAM_KEY:-$DEFAULT_STREAM_KEY}"
    local rtmp_target

    if rtmp_target="$(build_rtmp_target "$rtmp_server" "$stream_key")"; then
        :
    else
        return $?
    fi

    echo "Starting UDP to RTMP receiver..."
    echo "UDP listening on: 0.0.0.0:1234"
    echo "RTMP server: ${rtmp_server%/}"
    echo "Stream key: configured"

    echo "Testing FFmpeg..."
    ffmpeg -version

    while true; do
        echo "[$(date)] Waiting for UDP stream..."
        ffmpeg -avoid_negative_ts make_zero -fflags '+genpts' \
            -i 'udp://0.0.0.0:1234?timeout=0&buffer_size=6291456' \
            -c copy -copyts -vsync passthrough -async 1 \
            -f flv "$rtmp_target"

        echo "[$(date)] FFmpeg exited, restarting in 5 seconds..."
        sleep 5
    done
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
    main "$@"
fi
