#!/bin/bash
# diskmonitor.sh — Posts disk usage to #general via agentchat
# Run on metal via cron or manually

set -e

# Overall disk usage
DISK=$(df -h / | tail -1 | awk '{print "Disk: "$3" used / "$2" total ("$5" full)"}')

# Per-container wormhole usage (adjust path as needed)
WORMHOLE_DIR="${WORMHOLE_DIR:-$HOME/dev/claude/wormhole}"
if [ -d "$WORMHOLE_DIR" ]; then
  WORM=$(du -sh "$WORMHOLE_DIR"/*/ 2>/dev/null | sort -rh | head -10)
  WORM_TOTAL=$(du -sh "$WORMHOLE_DIR" 2>/dev/null | awk '{print $1}')
else
  WORM="(wormhole dir not found)"
  WORM_TOTAL="?"
fi

# Container disk usage
if command -v podman &>/dev/null; then
  CONTAINERS=$(podman ps --format '{{.Names}}' 2>/dev/null | while read name; do
    echo "  $name"
  done)
elif command -v docker &>/dev/null; then
  CONTAINERS=$(docker ps --format '{{.Names}}' 2>/dev/null | while read name; do
    echo "  $name"
  done)
fi

MSG="📊 Disk Report
$DISK
Wormhole total: $WORM_TOTAL
$WORM"

echo "$MSG"

# Post to #general if agentchat CLI is available
# Uncomment and adjust the command below for your setup:
# claude -p "connect to wss://agentchat-server.fly.dev and send this to #general: $MSG"
