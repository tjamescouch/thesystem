#!/bin/bash
# nukewormhole.sh — Soft-deletes wormhole files to a trash dir
# Run on metal. Moves files to trash first, then purge trash separately.

set -e

WORMHOLE_DIR="${WORMHOLE_DIR:-$HOME/dev/claude/wormhole}"
TRASH_DIR="${TRASH_DIR:-$HOME/dev/claude/wormhole-trash}"

if [ ! -d "$WORMHOLE_DIR" ]; then
  echo "Wormhole dir not found: $WORMHOLE_DIR"
  exit 1
fi

# Show current usage
echo "Current wormhole usage:"
du -sh "$WORMHOLE_DIR"/*/ 2>/dev/null | sort -rh
echo ""
du -sh "$WORMHOLE_DIR" 2>/dev/null
echo ""

if [ -d "$TRASH_DIR" ]; then
  echo "Trash usage:"
  du -sh "$TRASH_DIR" 2>/dev/null
  echo ""
fi

# Commands
case "${1:-}" in
  --confirm)
    # Move wormhole contents to trash
    TIMESTAMP=$(date +%Y%m%d_%H%M%S)
    DEST="$TRASH_DIR/$TIMESTAMP"
    mkdir -p "$DEST"

    for dir in "$WORMHOLE_DIR"/*/; do
      agent=$(basename "$dir")
      echo "Moving $agent to trash..."
      mkdir -p "$DEST/$agent"
      find "$dir" -type f -exec mv {} "$DEST/$agent/" \; 2>/dev/null
      echo "  Done."
    done

    echo ""
    echo "Wormhole cleaned. Files moved to: $DEST"
    echo "New wormhole usage:"
    du -sh "$WORMHOLE_DIR" 2>/dev/null
    echo "Trash usage:"
    du -sh "$TRASH_DIR" 2>/dev/null
    ;;

  --purge-trash)
    # Actually delete the trash
    if [ -d "$TRASH_DIR" ]; then
      echo "Purging trash..."
      rm -rf "$TRASH_DIR"
      echo "Trash purged."
    else
      echo "No trash to purge."
    fi
    ;;

  *)
    echo "Dry run. Commands:"
    echo "  --confirm      Move wormhole files to trash"
    echo "  --purge-trash  Permanently delete trash"
    ;;
esac
