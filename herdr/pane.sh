#!/bin/sh
# The alice plugin's pane: alice running --watch, which q or Ctrl-C closes. When it cannot start (not on PATH,
# ALICE_URL wrong) the pane stays open on the error until Enter, since Herdr closes a pane whose command exits.
if ! command -v alice >/dev/null 2>&1; then
  echo "alice is not on PATH. Run npm link in your Alice checkout, then toggle this pane again."
elif alice running --watch; then
  exit 0
fi
echo "Press Enter to close."
read -r _
exit 1
