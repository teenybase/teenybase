#!/bin/sh
# Fix workerd on Alpine Linux (musl).
# Downloads Ubuntu's glibc and wraps each workerd binary to use it.
# Re-run after npm install. Idempotent — re-patches stale wrappers.
set -e

grep -qi alpine /etc/os-release 2>/dev/null || { echo "Not Alpine — skipping."; exit 0; }

ARCH=$(uname -m)
GLIBC="/tmp/glibc-compat"

case "$ARCH" in
    aarch64) PLATFORM=linux-arm64; LINKER=ld-linux-aarch64.so.1; LIBDIR=aarch64-linux-gnu
             DEB_URL="http://ports.ubuntu.com/ubuntu-ports/pool/main/g/glibc/libc6_2.39-0ubuntu8_arm64.deb" ;;
    x86_64)  PLATFORM=linux-64; LINKER=ld-linux-x86-64.so.2; LIBDIR=x86_64-linux-gnu
             DEB_URL="http://archive.ubuntu.com/ubuntu/pool/main/g/glibc/libc6_2.39-0ubuntu8_amd64.deb" ;;
    *)       echo "Unsupported arch: $ARCH"; exit 1 ;;
esac

# Download glibc once
if [ ! -f "$GLIBC/$LIBDIR/$LINKER" ]; then
    echo "Downloading glibc..."
    TMP=$(mktemp -d)
    wget -q -O "$TMP/libc6.deb" "$DEB_URL"
    cd "$TMP" && ar x libc6.deb
    command -v zstd >/dev/null 2>&1 || { apk add --no-cache zstd 2>/dev/null || sudo apk add --no-cache zstd; } >/dev/null 2>&1
    zstd -d data.tar.zst && tar xf data.tar
    mkdir -p "$GLIBC" && cp -a "usr/lib/$LIBDIR" "$GLIBC/$LIBDIR"
    rm -rf "$TMP"
    echo "glibc → $GLIBC"
fi

LP="$GLIBC/$LIBDIR/$LINKER"
[ -f "$LP" ] || { echo "ERROR: $LP not found"; exit 1; }

# Find all workerd binaries
REPO=$(cd "$(dirname "$0")/.." && pwd)
BINS=$(find "${@:-$REPO}" -path "*/@cloudflare/workerd-${PLATFORM}/bin/workerd" -not -name "*.real" 2>/dev/null || true)
[ -z "$BINS" ] && { echo "No workerd binaries found."; exit 0; }

N=0
for BIN in $BINS; do
    # If already a wrapper, check if it works — skip if so, re-patch if stale
    if head -1 "$BIN" 2>/dev/null | grep -q '^#!/bin/sh'; then
        if "$BIN" --version >/dev/null 2>&1; then
            echo "ok   $BIN"; N=$((N+1)); continue
        fi
        # Stale wrapper — restore .real and re-patch
        [ -f "${BIN}.real" ] && cp "${BIN}.real" "$BIN"
    fi

    cp "$BIN" "${BIN}.real"
    printf '#!/bin/sh\nexec "%s" --library-path "%s" "${0}.real" "$@"\n' "$LP" "$GLIBC/$LIBDIR" > "$BIN"
    chmod +x "$BIN"
    N=$((N+1))

    "$BIN" --version >/dev/null 2>&1 && echo "ok   $BIN" || echo "FAIL $BIN"
done

echo "Done ($N binaries)."
