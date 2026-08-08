#!/usr/bin/env bash
# Install ai-proxy-control GNOME Shell extension into the per-user
# extensions directory and compile its GSettings schema.
#
# Usage:  ./install.sh
#
# After installing, enable the extension and reload GNOME Shell:
#   gnome-extensions enable ai-proxy-control@ahati
#   # Wayland: log out and back in. X11: Alt+F2 -> r

set -euo pipefail

UUID="ai-proxy-control@ahati"
SRC_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
DEST_DIR="${HOME}/.local/share/gnome-shell/extensions/${UUID}"

if ! command -v glib-compile-schemas >/dev/null 2>&1; then
    echo "error: glib-compile-schemas not found. Install glib2 / libglib2.0-bin." >&2
    exit 1
fi

echo "Installing to ${DEST_DIR} ..."
mkdir -p "${DEST_DIR}/schemas"
cp -r \
    "${SRC_DIR}/extension.js" \
    "${SRC_DIR}/prefs.js" \
    "${SRC_DIR}/stylesheet.css" \
    "${SRC_DIR}/metadata.json" \
    "${DEST_DIR}/"
cp "${SRC_DIR}/schemas/org.gnome.shell.extensions.ai-proxy.gschema.xml" "${DEST_DIR}/schemas/"

echo "Compiling GSettings schema ..."
glib-compile-schemas "${DEST_DIR}/schemas/"

echo
echo "Done. Enable and reload:"
echo "  gnome-extensions enable ${UUID}"
echo "  # Wayland: log out and back in. X11: Alt+F2 -> r"
