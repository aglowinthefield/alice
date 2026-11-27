#!/bin/sh
# The bakery plugin's pane: bakery-cli running --watch, which q or Ctrl-C closes. When it cannot start (not on PATH,
# BAKERY_URL wrong) the pane stays open on the error until Enter, since Herdr closes a pane whose command exits.
if ! command -v bakery-cli >/dev/null 2>&1; then
  echo "bakery-cli is not on PATH. Run npm link in your Bakery checkout, then toggle this pane again."
elif bakery-cli running --watch; then
  exit 0
fi
echo "Press Enter to close."
read -r _
exit 1
