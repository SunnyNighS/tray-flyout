# Tray Flyout

A GNOME Shell extension that keeps the tray area of the panel short. Tray icons you
don't need all the time move into a flyout that opens from a chevron (^) next to the
tray, similar to "Show hidden icons" on other desktops.

- Drag icons between the panel and the flyout, or drop them on the chevron.
  Order in panel and flyout is kept.
- Choose per icon in the preferences whether it is shown in the panel.
- New icons start in the flyout (can be turned off).
- Left click opens the application, right click opens its menu, middle click and
  scrolling work as usual. Icons in the flyout keep their menus.
- Keyboard: <kbd>Super</kbd>+<kbd>B</kbd> opens the flyout, arrow keys move,
  <kbd>Enter</kbd> opens the application, <kbd>Shift</kbd>+<kbd>F10</kbd> or the
  menu key opens its menu, <kbd>Esc</kbd> closes.
- Works with the stock top bar, Dash to Panel and Zorin Taskbar; the flyout opens
  away from the panel edge.
- Buttons of other extensions next to the tray (for example a clipboard indicator)
  can be moved into the flyout as well.

## Requirements

- GNOME Shell 46
- An AppIndicator extension that shows the tray icons, for example
  [AppIndicator and KStatusNotifierItem Support](https://extensions.gnome.org/extension/615/appindicator-support/),
  Ubuntu's `ubuntu-appindicators@ubuntu.com` or Zorin OS' `zorin-appindicator@zorinos.com`.
  Tray Flyout does not show tray icons itself; it arranges the icons of that extension.

## Install from source

```bash
./build.sh install
```

Then log out and back in (on Wayland GNOME Shell loads new extensions only at login)
and enable it:

```bash
gnome-extensions enable tray-flyout@sunnynighs.github.io
```

`./build.sh pack` builds `build/tray-flyout@sunnynighs.github.io.shell-extension.zip`.

## How it works

The AppIndicator extension adds one panel button per tray icon to
`Main.panel.statusArea` (roles `appindicator-…`). Tray Flyout moves the containers of
those buttons between the panel box and the grid inside the chevron's menu, so the
icons keep all their behaviour. While an icon is in the flyout, its menu is managed by
a separate `PopupMenuManager`, so the flyout stays open below the icon's menu.

Choices are stored per application (the StatusNotifierItem `Id`), so they survive
restarts of the application.

Limitations:

- Only the panel on the primary monitor has tray icons (AppIndicator limitation).
- Panels that hide automatically may hide while an icon menu inside the flyout is open.
- Applications that use a generic, per-process Id and no title cannot be remembered.

## License

GPL-2.0-or-later
