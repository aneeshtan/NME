#!/usr/bin/env bash
#
# Host tuning for a media server. Run once, as root, on the VPS.
#
# Only the file-handle limit is documented by LiveKit. The UDP buffer sizes
# below are a property of pion, the WebRTC stack LiveKit is built on: its
# default socket buffers are small, and under sustained load the kernel drops
# packets before the SFU ever sees them. The symptom is choppy audio and video
# that looks like a bandwidth problem but is not one.
#
# Everything here is reversible: delete the file it writes and reboot.
set -euo pipefail

CONF=/etc/sysctl.d/99-livekit.conf

cat > "$CONF" <<'SYSCTL'
# Larger UDP socket buffers. WebRTC is bursty, and the default ~200 KB is
# reached quickly with many concurrent streams; beyond it the kernel discards
# datagrams silently.
net.core.rmem_max = 16777216
net.core.wmem_max = 16777216
net.core.rmem_default = 4194304
net.core.wmem_default = 4194304

# Deeper backlog for bursts of new connections at the top of the hour, when
# every meeting in the calendar starts at once.
net.core.netdev_max_backlog = 16384
net.core.somaxconn = 8192
SYSCTL

sysctl -p "$CONF"

echo
echo "Applied. Current values:"
sysctl net.core.rmem_max net.core.wmem_max net.core.somaxconn

echo
echo "File handles are raised per-container in docker-compose.yml (ulimits),"
echo "so no host-level ulimit change is needed for the SFU."
