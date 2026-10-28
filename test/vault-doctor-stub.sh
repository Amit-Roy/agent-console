#!/bin/sh
# Stub for VAULT_DOCTOR_BIN: prints $STUB_OUT (a file) verbatim, optional sleep, exit $STUB_EXIT.
echo "$@" > "$STUB_ARGV"
[ -n "$STUB_SLEEP" ] && sleep "$STUB_SLEEP"
cat "$STUB_OUT"
exit "${STUB_EXIT:-0}"
