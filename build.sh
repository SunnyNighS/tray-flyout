#!/bin/bash
# SPDX-License-Identifier: GPL-2.0-or-later
#
# ./build.sh install   compile schemas + translations, link src/ into the user's extensions
# ./build.sh pack      build build/<uuid>.shell-extension.zip for extensions.gnome.org/GitHub
# ./build.sh pot       regenerate po/<uuid>.pot (needs gettext)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="$ROOT/src"
UUID="$(python3 -c 'import json, sys; print(json.load(open(sys.argv[1]))["uuid"])' "$SRC/metadata.json")"

compile_translations() {
    local po lang out
    for po in "$ROOT"/po/*.po; do
        [ -e "$po" ] || continue
        lang="$(basename "$po" .po)"
        out="$SRC/locale/$lang/LC_MESSAGES"
        mkdir -p "$out"
        if command -v msgfmt >/dev/null; then
            msgfmt --check -o "$out/$UUID.mo" "$po"
        else
            python3 "$ROOT/tools/msgfmt.py" "$po" "$out/$UUID.mo"
        fi
    done
}

case "${1:-}" in
install)
    glib-compile-schemas --strict "$SRC/schemas"
    compile_translations
    dest="$HOME/.local/share/gnome-shell/extensions/$UUID"
    if [ -e "$dest" ] && [ ! -L "$dest" ]; then
        echo "$dest exists and is not a symlink; remove it first: gnome-extensions uninstall $UUID" >&2
        exit 1
    fi
    mkdir -p "$(dirname "$dest")"
    ln -sfnT "$SRC" "$dest"
    echo "Linked $UUID -> $SRC"
    echo "Log out and back in (Wayland), then: gnome-extensions enable $UUID"
    ;;
pack)
    glib-compile-schemas --strict --dry-run "$SRC/schemas"
    compile_translations
    mkdir -p "$ROOT/build"
    python3 - "$SRC" "$ROOT/build/$UUID.shell-extension.zip" <<'PY'
import pathlib, sys, zipfile
src, out = pathlib.Path(sys.argv[1]), sys.argv[2]
files = ['metadata.json', 'extension.js', 'prefs.js', 'stylesheet.css']
files += [str(p.relative_to(src)) for d in ('lib', 'icons', 'locale') for p in sorted((src / d).rglob('*')) if p.is_file()]
files += [str(p.relative_to(src)) for p in sorted((src / 'schemas').glob('*.gschema.xml'))]
with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as z:
    for f in files:
        z.write(src / f, f)
print(out)
PY
    ;;
pot)
    xgettext --from-code=UTF-8 --language=JavaScript --keyword=_ \
        -o "$ROOT/po/$UUID.pot" "$SRC"/*.js "$SRC"/lib/*.js
    ;;
*)
    echo "usage: $0 install|pack|pot" >&2
    exit 1
    ;;
esac
