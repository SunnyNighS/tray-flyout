# Tray Flyout – Design

Windows-11-style "Show hidden icons" for GNOME Shell: a chevron in the panel opens a
flyout with a grid of tray icons. Icons can be moved between panel and flyout by drag
and drop or in the preferences.

Target: GNOME Shell 46 (tested), code kept compatible with 45–48 APIs where cheap.
Tray icons come from an existing AppIndicator extension (upstream
`appindicatorsupport@rgcjonas.gmail.com`, Ubuntu's `ubuntu-appindicators@ubuntu.com`,
Zorin's `zorin-appindicator@zorinos.com`). Tray Flyout does **not** implement a
StatusNotifierWatcher; it borrows the panel buttons those extensions create.

## Terms

- **Item**: a `PanelMenu.Button` in `Main.panel.statusArea` that we manage.
  - `sni`: AppIndicator/KStatusNotifierItem icon, role `appindicator-*`, has `_indicator`.
  - `xembed`: legacy tray icon of the AppIndicator extension, role `appindicator-*`,
    no `_indicator`, has `_icon.wm_class`.
  - `ext`: a button of another extension in the same panel box as the tray
    (e.g. clipboard indicator). System roles are never managed.
- **Key**: stable identity used for persistence.
  - `sni:<Id>`; for generic Ids (`chrome_status_icon_N`, `systray_N`, empty)
    `sni-title:<Title>`, or `sni-id:<Id>` without a title. Electron Ids
    `<App>_status_icon_<N>` count up per tray icon of a process, the counter is
    dropped (`sni:<App>_status_icon`); keys saved with a counter are migrated.
  - `xembed:<wm_class>`
  - `ext:<statusArea role>`
  Never the bus name, object path or uniqueId (they change per run).
- **Promoted** = shown in the panel. **Hidden** = lives in the flyout.
- **Tray box**: the `Main.panel` box that holds the AppIndicator icons (`tray-pos`
  of the AppIndicator extension), `_rightBox` by default.

## Behaviour (Windows parity)

1. Chevron sits directly before the leftmost managed item in the tray box.
   Accessible name "Show hidden icons". Own symbolic SVG glyph, pointing away from the
   panel edge (up for a bottom panel, down for a top panel).
2. The chevron is hidden when no hidden item is visible (Passive SNI items do not
   count). An open flyout closes when it becomes empty.
3. The flyout is the chevron's `PopupMenu` (so Zorin Taskbar / Dash to Panel /
   stock BoxPointer give it the right side automatically). It contains one grid.
   Columns = `max-columns` if > 0, else `ceil(sqrt(n))` (near-square, as Windows).
4. Light dismiss: outside click, Esc, chevron click, and any change of the focused
   window close the flyout.
5. Clicks (panel and flyout behave the same, like on Windows):
   - SNI, left click: with `left-click-activates` (default on) `Activate` on release
     (the flyout closes first, so the application gets focus); items without
     Activate (`supportsActivation === false`, `ItemIsMenu`) open their menu instead.
     The second click of a double click is ignored. With the option off: native
     AppIndicator behaviour.
   - Right click, middle click, scroll: native.
   - XEmbed: native; the flyout closes after the release so the X11 client gets input.
   - ext: menu toggles on release (press is used for drag detection).
   Item menus open anchored to the icon inside the flyout; the flyout stays open
   underneath. Choosing a menu entry or clicking outside closes the flyout too;
   Escape or a click on another flyout icon only closes the icon menu.
   Icon menus in the flyout do not follow the pointer to other icons (no hover
   switching, as on Windows); the next click closes the open menu.
   Hovering or focusing an icon in the flyout shows its name as a tooltip.
6. New SNI/XEmbed items go to the flyout (`new-icons-hidden`, default on, Windows
   default). New ext items stay in the panel. First run: when `known-items` is empty,
   every icon that appears within the first minute stays in the panel, so enabling
   the extension (or the first login with it) does not hide everything at once.
7. Drag and drop (own implementation, see below): panel → chevron or open flyout
   (hide), flyout → panel (promote at drop position), reorder in panel and flyout.
   Order is persisted.
8. Preferences list every known item with a switch "Show in panel" (= Windows
   "Other system tray icons"), plus:
   - `show-hidden-icon-menu` (Win11 "Hidden icon menu"): off → no chevron, hidden
     items are invisible.
   - `show-all-icons` (Win10 "Always show all icons"): everything in the panel, no
     chevron.
   - `max-columns`, `left-click-activates`, `new-icons-hidden`,
     `manage-extension-buttons`, keyboard shortcut.
9. Keyboard: `focus-tray-shortcut` (default `<Super>b`) opens the flyout and focuses
   the first icon, or closes it; it does nothing while no icon is hidden or while
   another menu is open.
   In the flyout, arrow keys move with wrap-around, Enter/Space act like left click,
   Shift+F10/Menu opens the item menu, Esc closes and returns focus to the chevron.

## Architecture

```
extension.js        enable/disable, owns Controller
lib/items.js        item classification and key derivation
lib/controller.js   tracking of statusArea, placement, settings, menu managers
lib/chevron.js      ChevronButton (PanelMenu.Button) + FlyoutGrid + Tooltip
lib/drag.js         drag and drop (button events up to the threshold, then
                    Main.pushModal on an own actor + geometric hit-testing; no dnd.js)
prefs.js            Adw preferences
```

### Tracking

- On enable: scan `Main.panel.statusArea` (skip null entries).
- Right after an AppIndicator extension is disabled its buttons stay registered for a
  moment while they are torn down. Tray buttons are only touched while a known
  AppIndicator extension is active (`extension-state-changed` triggers a sync).
- An extension button whose owner moves it out of the tray box (its own position
  setting) or removes it is released, not pulled back.
- If the AppIndicator extension moves a container out of the flyout (tray position
  change re-adds all icons), the sync notices the foreign parent and re-applies.
- `child-added` on `_leftBox/_centerBox/_rightBox` → schedule a sync with
  `Meta.LaterType.BEFORE_REDRAW` (the role is assigned after insertion, and the
  later runs before the frame is painted, so moved icons never flash).
- SNI items without a key yet are skipped; the indicator's `ready` (or `destroy`)
  signal triggers a sync.
- Item `destroy` → forget it (its container is destroyed with it).

### Moving

- Hidden: `container` is reparented into the flyout grid. The button's own `visible`
  is never touched (AppIndicator drives it from SNI status and rebuilds the DBus menu
  on `notify::visible`).
- The item's menu is moved from `Main.panel.menuManager` to a private
  `PopupMenuManager` while it is in the flyout (otherwise hover/focus inside the
  flyout would switch the panel manager to that menu and close the flyout).
  `menu-set` is tracked. `Main.panel.menuManager.addMenu()` restores it.
- Promoted: `container` lives in the tray box. Promoted managed items are kept in
  `promoted-items` order among themselves (they reuse the slots they occupy, other
  children are untouched).
- disable(): hidden containers go back to the tray box right after the chevron, in
  `hidden-items` order (promoted containers stay where they are); menus go back to
  `Main.panel.menuManager`; all handlers, sources and the keybinding are removed;
  chevron destroyed.
- The initial tray box is the panel box that already holds AppIndicator buttons.

### Input on managed buttons

One `event` handler per item (runs before `vfunc_event` and before the specific
`button-press-event` emission):

- primary press: remember position; start press tracking (see below).
  - ext items with stock behaviour (a non-empty `PopupMenu`, no own `vfunc_event`, no
    `button-press/release-event` handlers): return STOP (prevents
    `PanelMenu.Button.vfunc_event` toggling the menu on press, which would grab the
    pointer and make dragging impossible); toggle on release instead. Other buttons
    keep their own click handling.
  - SNI: STOP; on release either Activate (left-click-activates) or replay the
    AppIndicator press handler (`vfunc_button_press_event`), which may open the menu
    on press and would otherwise end the drag tracking.
  - XEmbed: PROPAGATE (native); for icons in the flyout any release closes the flyout
    in an idle afterwards.
- Panel drop slots are only the promoted tray icons (nothing lands among system
  menus); RTL boxes are handled.
- While dragging, the chevron is shown even with an empty flyout so it can be used
  as drop target.
- When the pointer moves past the drag threshold: drag starts; pending AppIndicator
  double-click timer is cancelled (`_waitDoubleClickPromise`), item menu closed.

### Drag and drop (lib/drag.js)

- Before the threshold, motion and release arrive through the pressed button's
  `event` signal (implicit grab of the stage). Motion without button 1 held resets
  the tracking (the release went to a menu that opened in between).
- Threshold from `St.Settings.drag_threshold`.
- After the threshold: `Main.pushModal()` on a 0×0 reactive actor of our own in
  `Main.uiGroup` (like dnd.js), so unmapping or moving the source cannot drop the
  grab. Drag actor: `Clutter.Clone` of the (mapped) source container with its size.
- Targets are hit-tested by geometry (`get_transformed_extents`): open flyout, chevron,
  tray box. Panel boxes and the grid are not reactive, so picking would miss gaps.
- Hovering the chevron for 500 ms opens the flyout *outside* its menu manager (no
  second modal grab above the drag); it is closed and re-added at drag end.
- A marker line shows the insertion slot.
- Release: move + persist both lists (no `delay()`: a GSettings object stays in
  delay mode for good).
  Esc or release outside a target: cancel. Syncs are postponed until drag end.

### Settings (`org.gnome.shell.extensions.tray-flyout`)

| key | type | default |
|---|---|---|
| promoted-items | as | [] |
| hidden-items | as | [] |
| known-items | a{ss} | {} (key → display name, written by the shell) |
| new-icons-hidden | b | true |
| show-hidden-icon-menu | b | true |
| show-all-icons | b | false |
| max-columns | i | 0 |
| left-click-activates | b | true |
| manage-extension-buttons | b | true |
| focus-tray-shortcut | as | ['<Super>b'] |

### Never managed roles

`activities appMenu dateMenu quickSettings a11y keyboard dwellClick screenRecording
screenSharing` and our own `tray-flyout` role.

## Known limits

- Private APIs used: `indicator._indicator`, `indicator._icon`,
  `indicator._waitDoubleClickPromise` (AppIndicator extension),
  `Main.panel._leftBox/_centerBox/_rightBox`.
- Only the primary panel has tray icons (AppIndicator limitation).
- Intellihide panels may hide while an item menu inside the flyout is open.
- Tooltips only in the flyout (the AppIndicator extension shows none in the panel).
