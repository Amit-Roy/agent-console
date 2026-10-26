#!/bin/sh
# Stub for VAULT_IRON_SSH: records argv and stdin under $STUB_DIR; answers status/set/token from files there.
[ -e "$STUB_DIR/down" ] && exit 255
echo "$@" >> "$STUB_DIR/argv.log"
case "$1" in
  status) cat "$STUB_DIR/status" ;;
  set) cat > "$STUB_DIR/stdin.log"; echo "ok $2" ;;
  token) cat "$STUB_DIR/token" ;;
  *) exit 2 ;;
esac
