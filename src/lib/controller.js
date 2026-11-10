// SPDX-License-Identifier: GPL-2.0-or-later

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Graphene from 'gi://Graphene';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as BoxPointer from 'resource:///org/gnome/shell/ui/boxpointer.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {ChevronButton, Tooltip} from './chevron.js';
import {DragTracker} from './drag.js';
import {ItemKind, OWN_ROLE, classify, displayName, isTrayButton, normalizeKey, trayHostActive} from './items.js';

const PANEL_BOXES = {
    left: '_leftBox',
    center: '_centerBox',
    right: '_rightBox',
};

const HOVER_OPEN_DELAY = 500;
const FIRST_RUN_DURATION = 60 * GLib.USEC_PER_SEC;

function panelBoxes() {
    return Object.values(PANEL_BOXES).map(name => Main.panel[name]);
}

function boxName(box) {
    return Object.keys(PANEL_BOXES).find(name => Main.panel[PANEL_BOXES[name]] === box) ?? 'right';
}

function moveActor(actor, parent, index) {
    const oldParent = actor.get_parent();
    if (oldParent === parent) {
        if (parent.get_children().indexOf(actor) !== index)
            parent.set_child_at_index(actor, index);
        return;
    }
    oldParent?.remove_child(actor);
    parent.insert_child_at_index(actor, Math.min(index, parent.get_n_children()));
}

function doubleClickTime() {
    const settings = global.stage.context?.get_settings?.() ?? Clutter.Settings.get_default();
    return settings.double_click_time;
}

// Whether a button of another extension just toggles its menu on click (the
// stock PanelMenu.Button behaviour), so the click may be taken over.
function isStockMenuButton(button) {
    const menu = button.menu;
    if (!(menu instanceof PopupMenu.PopupMenu) || menu.isEmpty())
        return false;
    if (button.vfunc_event !== PanelMenu.Button.prototype.vfunc_event)
        return false;
    return !['button-press-event', 'button-release-event'].some(name =>
        GObject.signal_has_handler_pending(button, GObject.signal_lookup(name, button.constructor.$gtype), 0, true));
}

// Menus of icons in the flyout stay open until a click, like on Windows: the
// stock manager switches to another menu when its icon is hovered or focused,
// which is the only use of _changeMenu().
class StickyMenuManager extends PopupMenu.PopupMenuManager {
    _changeMenu(_menu) {}
}

// Brings keys stored by older versions in line with the current ones.
function migrateKeys(settings) {
    const normalize = list => [...new Set(list.map(normalizeKey))];
    const promoted = settings.get_strv('promoted-items');
    const hidden = settings.get_strv('hidden-items');
    const newPromoted = normalize(promoted);
    const newHidden = normalize(hidden).filter(key => !newPromoted.includes(key));
    if (newPromoted.join('\n') !== promoted.join('\n'))
        settings.set_strv('promoted-items', newPromoted);
    if (newHidden.join('\n') !== hidden.join('\n'))
        settings.set_strv('hidden-items', newHidden);

    const known = settings.get_value('known-items').deepUnpack();
    const newKnown = {};
    for (const [key, name] of Object.entries(known))
        newKnown[normalizeKey(key)] ??= name;
    if (Object.keys(newKnown).length !== Object.keys(known).length ||
        Object.keys(known).some(key => !(key in newKnown)))
        settings.set_value('known-items', new GLib.Variant('a{ss}', newKnown));
}

function containsPoint(actor, x, y) {
    return actor.mapped && actor.get_transformed_extents().contains_point(new Graphene.Point({x, y}));
}

export class TrayFlyout {
    constructor(settings, iconFile) {
        this._settings = settings;
        migrateKeys(settings);
        this._items = new Map();
        this._pending = new Set();
        this._laterId = 0;
        this._hoverTimeoutId = 0;
        this._flyoutDetached = false;
        this._trayBox = panelBoxes().find(box =>
            box.get_children().some(child => isTrayButton(child.get_first_child()))) ?? Main.panel._rightBox;
        this._lastActivation = null;
        this._closeIdleId = 0;
        this._dragging = false;
        // When the extension is enabled for the first time, icons that appear
        // within the first minute (the applications started with the session)
        // stay in the panel; only icons appearing later go to the flyout.
        const firstRun = Object.keys(settings.get_value('known-items').deepUnpack()).length === 0;
        this._firstRunEnd = firstRun ? GLib.get_monotonic_time() + FIRST_RUN_DURATION : 0;

        this._chevron = new ChevronButton(iconFile);
        this._grid = this._chevron.grid;
        this._grid.maxColumns = settings.get_int('max-columns');
        Main.panel.addToStatusArea(OWN_ROLE, this._chevron, 0, boxName(this._trayBox));

        this._itemMenus = new StickyMenuManager(this._chevron);
        this._drag = new DragTracker(this);
        this._tooltip = new Tooltip();

        this._chevron.connectObject(
            'tile-activate', (_c, tile) => this._activateTile(tile),
            'tile-menu', (_c, tile) => this._openTileMenu(tile),
            this);
        this._chevron.menu.connectObject('open-state-changed',
            (_m, open) => this._onFlyoutOpenStateChanged(open), this);

        for (const box of panelBoxes())
            box.connectObject('child-added', (_b, child) => this._onChildAdded(box, child), this);
        Main.extensionManager.connectObject('extension-state-changed', () => this._queueSync(), this);

        this._settings.connectObject(
            'changed::promoted-items', () => this._queueSync(),
            'changed::hidden-items', () => this._queueSync(),
            'changed::show-all-icons', () => this._queueSync(),
            'changed::show-hidden-icon-menu', () => this._queueSync(),
            'changed::manage-extension-buttons', () => this._onManageExtensionsChanged(),
            'changed::max-columns', () => {
                this._grid.maxColumns = this._settings.get_int('max-columns');
            },
            this);

        Main.wm.addKeybinding('focus-tray-shortcut', settings,
            Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW | Shell.ActionMode.POPUP,
            () => this._toggleFromKeyboard());

        this._sync();
    }

    destroy() {
        Main.wm.removeKeybinding('focus-tray-shortcut');
        this._chevron.menu.close(BoxPointer.PopupAnimation.NONE);
        this._chevron.menu.disconnectObject(this);
        this._chevron.disconnectObject(this);

        this._drag.destroy();
        this._clearHoverTimeout();
        if (this._laterId)
            global.compositor.get_laters().remove(this._laterId);
        this._laterId = 0;
        if (this._closeIdleId)
            GLib.source_remove(this._closeIdleId);
        this._closeIdleId = 0;

        this._settings.disconnectObject(this);
        for (const box of panelBoxes())
            box.disconnectObject(this);
        Main.extensionManager.disconnectObject(this);
        for (const indicator of this._pending)
            indicator.disconnectObject(this);
        this._pending.clear();

        this._restoreAll();

        this._tooltip.destroy();
        this._chevron.destroy();
        this._chevron = null;
        this._grid = null;
        this._itemMenus = null;
        this._settings = null;
    }

    // Tracking

    _onChildAdded(box, child) {
        // The AppIndicator extension moves all its icons when its tray
        // position setting changes; follow them, even if every icon is hidden.
        if (isTrayButton(child.get_first_child()))
            this._newTrayBox = box;
        this._queueSync();
    }

    _queueSync() {
        if (this._laterId || this._syncing)
            return;
        // Panel._addToPanelBox() registers the role only after inserting the
        // container, and the later runs before the next frame is painted, so
        // icons that belong into the flyout never flash up in the panel.
        this._laterId = global.compositor.get_laters().add(Meta.LaterType.BEFORE_REDRAW, () => {
            this._laterId = 0;
            this._sync();
            return GLib.SOURCE_REMOVE;
        });
    }

    _scan() {
        const manageExtensions = this._settings.get_boolean('manage-extension-buttons');
        const trayActive = trayHostActive();
        const tracked = new Set(this._items.keys());

        for (const [role, button] of Object.entries(Main.panel.statusArea)) {
            if (!button || tracked.has(button))
                continue;
            const info = classify(role, button);
            if (!info || (info.kind !== ItemKind.EXTENSION && !trayActive))
                continue;
            if (info.kind === ItemKind.EXTENSION &&
                (!manageExtensions || button.container.get_parent() !== this._trayBox))
                continue;
            if (!info.key) {
                this._waitForKey(button._indicator);
                continue;
            }
            this._track(role, button, info);
        }
    }

    _waitForKey(indicator) {
        if (!indicator || this._pending.has(indicator))
            return;
        this._pending.add(indicator);
        const retry = () => {
            indicator.disconnectObject(this);
            this._pending.delete(indicator);
            this._queueSync();
        };
        // AppIndicator objects are not GObjects, so their destruction has to be
        // followed by hand (their handlers are gone after 'destroy').
        indicator.connectObject('ready', retry, 'destroy', retry, this);
    }

    _track(role, button, {kind, key}) {
        const item = {
            role,
            button,
            kind,
            key,
            homeBox: button.container.get_parent(),
            hidden: false,
            destroyed: false,
            menu: null,
            get container() {
                return this.button.container;
            },
        };
        this._items.set(button, item);

        button.connectObject(
            'destroy', () => this._untrack(item, true),
            'event', (_b, event) => this._onItemEvent(item, event),
            'menu-set', () => this._onMenuSet(item),
            'notify::visible', () => this._queueSync(),
            'notify::hover', () => this._updateTooltip(item, button.hover),
            'key-focus-in', () => this._updateTooltip(item, true),
            'key-focus-out', () => this._updateTooltip(item, false),
            this);
    }

    _untrack(item, destroyed) {
        item.destroyed = destroyed;
        if (this._drag.tracks(item))
            this._drag.cancel();
        if (destroyed) {
            this._tooltip.hide();
        } else {
            item.button.disconnectObject(this);
            if (item.hidden && item.homeBox !== this._trayBox)
                this._placeInPanel(item, 0, item.homeBox);
            else if (item.hidden)
                this._placeInPanel(item, this._chevronIndex() + 1);
        }
        this._releaseMenu(item);
        this._items.delete(item.button);
        this._queueSync();
    }

    _restoreAll() {
        const order = this._settings.get_strv('hidden-items');
        const rank = item => order.indexOf(item.key);
        const hidden = [...this._items.values()]
            .filter(item => item.hidden)
            .sort((a, b) => rank(b) - rank(a));
        const index = this._chevronIndex() + 1;

        for (const item of this._items.values()) {
            item.button.disconnectObject(this);
            this._releaseMenu(item);
        }
        for (const item of hidden)
            this._placeInPanel(item, index);
        this._items.clear();

        // Whatever is left in the flyout would be destroyed with the chevron.
        for (const child of this._grid.get_children())
            moveActor(child, this._trayBox, index);
    }

    _onManageExtensionsChanged() {
        if (!this._settings.get_boolean('manage-extension-buttons')) {
            for (const item of [...this._items.values()]) {
                if (item.kind === ItemKind.EXTENSION)
                    this._untrack(item, false);
            }
        }
        this._queueSync();
    }

    // Placement

    _sync() {
        if (this._drag.dragging) {
            this._syncAfterDrag = true;
            return;
        }
        this._syncing = true;
        this._updateTrayBox();
        this._scan();

        const showAll = this._settings.get_boolean('show-all-icons');
        const newHidden = this._settings.get_boolean('new-icons-hidden') &&
            GLib.get_monotonic_time() > this._firstRunEnd;
        const promoted = this._settings.get_strv('promoted-items');
        const hidden = this._settings.get_strv('hidden-items');
        const newPromotedItems = [];
        const newHiddenKeys = [];

        const trayActive = trayHostActive();
        for (const item of this._itemsInVisualOrder()) {
            if (item.kind !== ItemKind.EXTENSION && !trayActive)
                continue;

            // An extension that moved or removed its own button keeps control.
            const parent = item.container.get_parent();
            if (item.kind === ItemKind.EXTENSION && parent !== this._trayBox && parent !== this._grid) {
                this._releaseMenu(item);
                item.hidden = false;
                this._untrack(item, false);
                continue;
            }

            // Someone else (the AppIndicator extension re-adding its icons)
            // may have taken the container out of the flyout.
            if (item.hidden && item.container.get_parent() !== this._grid) {
                this._releaseMenu(item);
                item.hidden = false;
            }

            let isHidden;
            if (hidden.includes(item.key)) {
                isHidden = true;
            } else if (promoted.includes(item.key)) {
                isHidden = false;
            } else {
                isHidden = item.kind !== ItemKind.EXTENSION && newHidden;
                if (isHidden)
                    newHiddenKeys.push(item.key);
                else
                    newPromotedItems.push(item);
            }

            if (isHidden && !showAll)
                this._placeInFlyout(item);
            else if (item.hidden || item.container.get_parent() !== this._trayBox)
                this._placeInPanel(item, this._lastPromotedIndex() + 1);
        }

        const promotedOrder = this._insertByPosition(promoted, newPromotedItems);
        const hiddenOrder = [...hidden, ...newHiddenKeys];
        this._orderPanel(promotedOrder);
        this._orderFlyout(hiddenOrder);
        this._updateChevron();
        this._rememberItems();

        // Both writes are seen together: syncs triggered by them are deferred.
        if (newPromotedItems.length)
            this._settings.set_strv('promoted-items', promotedOrder);
        if (newHiddenKeys.length)
            this._settings.set_strv('hidden-items', hiddenOrder);

        this._syncing = false;
    }

    _updateTrayBox() {
        const box = this._newTrayBox;
        this._newTrayBox = null;
        if (!box || box === this._trayBox)
            return;

        this._trayBox = box;
        moveActor(this._chevron.container, box, Math.min(1, box.get_n_children()));
        for (const item of this._items.values()) {
            if (item.kind === ItemKind.EXTENSION)
                this._untrack(item, false);
        }
    }

    _itemsInVisualOrder() {
        const panel = this._trayBox.get_children();
        const flyout = this._grid.get_children();
        const position = item => {
            const index = panel.indexOf(item.container);
            return index >= 0 ? index : panel.length + flyout.indexOf(item.container);
        };
        return [...this._items.values()].sort((a, b) => position(a) - position(b));
    }

    // New panel icons keep their current place: each key is inserted before
    // the key of the next known icon to its right.
    _insertByPosition(order, newItems) {
        const result = [...order];
        const children = this._trayBox.get_children();
        for (const item of newItems) {
            const following = children.slice(children.indexOf(item.container) + 1)
                .map(c => this._items.get(c.get_first_child())?.key)
                .find(key => key && result.includes(key));
            const at = following ? result.indexOf(following) : -1;
            result.splice(at < 0 ? result.length : at, 0, item.key);
        }
        return result;
    }

    _placeInFlyout(item) {
        if (item.hidden)
            return;
        item.button.menu?.close?.(BoxPointer.PopupAnimation.NONE);
        moveActor(item.container, this._grid, this._grid.get_n_children());
        item.hidden = true;
        this._adoptMenu(item);
    }

    _placeInPanel(item, index, box = this._trayBox) {
        this._releaseMenu(item);
        item.hidden = false;
        moveActor(item.container, box, index);
    }

    _promotedContainers() {
        return this._trayBox.get_children().filter(child => {
            const item = this._items.get(child.get_first_child());
            return item && !item.hidden;
        });
    }

    _lastPromotedIndex() {
        const containers = this._promotedContainers();
        return containers.length
            ? this._trayBox.get_children().indexOf(containers[containers.length - 1])
            : this._chevronIndex();
    }

    _chevronIndex() {
        return this._trayBox.get_children().indexOf(this._chevron.container);
    }

    _rank(order, container) {
        const index = order.indexOf(this._items.get(container.get_first_child())?.key);
        return index < 0 ? order.length : index;
    }

    _orderPanel(order) {
        const children = this._trayBox.get_children();
        const containers = this._promotedContainers();
        const slots = containers.map(c => children.indexOf(c));
        const sorted = [...containers].sort((a, b) => this._rank(order, a) - this._rank(order, b));

        if (sorted.some((c, i) => c !== containers[i])) {
            // Fill the slots of the tray icons in the new order; placing every
            // child at its final index from left to right keeps the others put.
            const desired = [...children];
            slots.forEach((slot, i) => (desired[slot] = sorted[i]));
            desired.forEach((c, i) => {
                if (this._trayBox.get_child_at_index(i) !== c)
                    this._trayBox.set_child_at_index(c, i);
            });
        }

        if (sorted.length === 0)
            return;
        const first = this._trayBox.get_children().indexOf(sorted[0]);
        const chevron = this._chevronIndex();
        if (chevron !== first - 1)
            this._trayBox.set_child_at_index(this._chevron.container, chevron < first ? first - 1 : first);
    }

    _orderFlyout(order) {
        const children = this._grid.get_children();
        const sorted = [...children].sort((a, b) => this._rank(order, a) - this._rank(order, b));
        if (sorted.some((c, i) => c !== children[i]))
            sorted.forEach((c, i) => this._grid.set_child_at_index(c, i));
    }

    _updateChevron() {
        // While dragging, the chevron is shown as drop target even when the
        // flyout is empty.
        const visible = this._settings.get_boolean('show-hidden-icon-menu') &&
            !this._settings.get_boolean('show-all-icons') &&
            (this._grid.visibleChildren.length > 0 || this._dragging);

        if (!visible)
            this._closeFlyout();
        this._chevron.container.visible = visible;
        this._grid.queue_relayout();
    }

    _rememberItems() {
        const known = this._settings.get_value('known-items').deepUnpack();
        let changed = false;
        for (const item of this._items.values()) {
            const name = displayName(item.kind, item.role, item.button);
            if (name && known[item.key] !== name) {
                known[item.key] = name;
                changed = true;
            }
        }
        if (changed)
            this._settings.set_value('known-items', new GLib.Variant('a{ss}', known));
    }

    // Menus of icons in the flyout live in a separate manager: in the panel's
    // manager, hovering or focusing an icon in the flyout would switch to that
    // icon's menu and close the flyout. Menus are closed before they change
    // managers, a manager loses track of a menu that is removed while open.

    _adoptMenu(item) {
        const menu = item.button.menu;
        if (!menu || item.menu === menu)
            return;
        this._releaseMenu(item);
        item.menu = menu;
        menu.close?.(BoxPointer.PopupAnimation.NONE);
        Main.panel.menuManager.removeMenu(menu);
        // Placeholder menus (legacy tray icons) stay out of every manager: a
        // manager would take a modal grab for them when hovered.
        if (menu instanceof PopupMenu.PopupMenu) {
            this._itemMenus.addMenu(menu);
            menu.connectObject('open-state-changed',
                (_m, open) => this._onItemMenuOpenStateChanged(open), this);
        }
    }

    _releaseMenu(item) {
        const menu = item.menu;
        if (!menu)
            return;
        item.menu = null;
        if (menu instanceof PopupMenu.PopupMenu)
            menu.disconnectObject(this);
        // A menu replaced by setMenu() is already destroyed.
        if (item.destroyed || menu !== item.button.menu)
            return;
        menu.close?.(BoxPointer.PopupAnimation.NONE);
        this._itemMenus.removeMenu(menu);
        Main.panel.menuManager.addMenu(menu);
    }

    _onMenuSet(item) {
        if (item.hidden)
            this._adoptMenu(item);
    }

    _onItemMenuOpenStateChanged(open) {
        if (open) {
            this._tooltip.hide();
            return;
        }
        if (this._itemMenus.activeMenu)
            return;

        // Like on Windows, choosing a menu entry or clicking elsewhere also
        // closes the flyout; Escape or a click on another icon in the flyout
        // only closes the icon menu.
        const event = Clutter.get_current_event();
        const type = event?.type();
        if (type === Clutter.EventType.KEY_PRESS && event.get_key_symbol() === Clutter.KEY_Escape)
            return;
        const isClick = type === Clutter.EventType.BUTTON_PRESS || type === Clutter.EventType.BUTTON_RELEASE;
        if (isClick && containsPoint(this._grid, ...event.get_coords()))
            return;
        this._closeFlyout();
    }

    _updateTooltip(item, show) {
        if (show && item.hidden && !this._drag.dragging && !this._itemMenus.activeMenu) {
            const name = item.button.accessible_name ||
                displayName(item.kind, item.role, item.button);
            this._tooltip.schedule(item.container, name);
        } else {
            this._tooltip.hide();
        }
    }

    // Flyout

    _onFlyoutOpenStateChanged(open) {
        if (open) {
            this._chevron.updateDirection();
            global.display.connectObject('notify::focus-window', () => {
                if (!this._drag.dragging)
                    this._closeFlyout();
            }, this._grid);
        } else {
            global.display.disconnectObject(this._grid);
            this._tooltip.hide();
        }
    }

    _closeFlyout() {
        if (this._chevron?.menu.isOpen)
            this._chevron.menu.close(BoxPointer.PopupAnimation.FULL);
    }

    _toggleFromKeyboard() {
        const menu = this._chevron.menu;
        if (menu.isOpen) {
            menu.close(BoxPointer.PopupAnimation.FULL);
            return;
        }
        // Another menu is open; don't stack the flyout's grab on top of it.
        if (Main.actionMode === Shell.ActionMode.POPUP || !this._chevron.container.visible)
            return;
        // The modal grab of the menu remembers the focus at open time and
        // restores it on close, so Escape lands on the chevron.
        this._chevron.grab_key_focus();
        menu.open(BoxPointer.PopupAnimation.FULL);
        this._chevron.focusTile(0);
    }

    _itemForTile(tile) {
        return this._items.get(tile.get_first_child());
    }

    _activateTile(tile) {
        const item = this._itemForTile(tile);
        if (!item)
            return;
        if (item.kind === ItemKind.XEMBED) {
            item.button._icon.click(Clutter.get_current_event());
            this._scheduleClose();
            return;
        }
        if (item.kind === ItemKind.SNI && !this._settings.get_boolean('left-click-activates')) {
            this._openTileMenu(tile);
            return;
        }
        const [x, y] = tile.get_transformed_position();
        this._activate(item, x + tile.width / 2, y + tile.height / 2, global.get_current_time());
    }

    _openTileMenu(tile) {
        const menu = this._itemForTile(tile)?.button.menu;
        if (!(menu instanceof PopupMenu.PopupMenu) || menu.isEmpty())
            return;
        menu.open(BoxPointer.PopupAnimation.FULL);
        menu.actor.navigate_focus(null, St.DirectionType.TAB_FORWARD, false);
    }

    _activate(item, x, y, time) {
        if (item.kind === ItemKind.EXTENSION && !isStockMenuButton(item.button)) {
            // Only reached from the keyboard: a click cannot be synthesized,
            // so hand the key focus to the button and its own key handling.
            item.button.grab_key_focus();
            return;
        }
        const indicator = item.button._indicator;
        if (item.kind !== ItemKind.SNI ||
            indicator.supportsActivation === false || indicator._proxy?.ItemIsMenu) {
            item.button.menu?.toggle();
            return;
        }

        // A second click of a double click would hide what the first showed.
        const last = this._lastActivation;
        if (last?.item === item && time - last.time < doubleClickTime())
            return;
        this._lastActivation = {item, time};

        // Close first, so the application sees its window gain focus.
        this._closeFlyout();
        indicator.open(x, y, time);
    }

    // Input on tray buttons

    _onItemEvent(item, event) {
        if (this._drag.tracks(item) && !this._drag.dragging)
            return this._drag.handlePressEvent(event);

        // Legacy tray icons forward clicks to their X11 client, whose menus
        // need the pointer: close the flyout after any click on them.
        if (item.kind === ItemKind.XEMBED && item.hidden &&
            event.type() === Clutter.EventType.BUTTON_RELEASE &&
            event.get_button() !== Clutter.BUTTON_PRIMARY) {
            this._tooltip.hide();
            this._scheduleClose();
            return Clutter.EVENT_PROPAGATE;
        }

        if (event.type() !== Clutter.EventType.BUTTON_PRESS ||
            event.get_button() !== Clutter.BUTTON_PRIMARY)
            return Clutter.EVENT_PROPAGATE;

        this._tooltip.hide();
        const click = this._clickHandler(item);
        this._drag.press(item, event, click);
        return click.consume ? Clutter.EVENT_STOP : Clutter.EVENT_PROPAGATE;
    }

    _clickHandler(item) {
        const button = item.button;
        switch (item.kind) {
        case ItemKind.EXTENSION:
            // PanelMenu.Button toggles its menu on press, which grabs the
            // pointer and makes dragging impossible; toggle on release instead.
            // Buttons with their own click handling keep it.
            if (!isStockMenuButton(button))
                return {};
            return {onClick: () => button.menu.toggle(), consume: true};
        case ItemKind.SNI:
            if (!this._settings.get_boolean('left-click-activates')) {
                // The AppIndicator extension may open the menu right on the
                // press, which would end the drag tracking: replay the press
                // on release instead.
                return {onClick: event => button.vfunc_button_press_event(event), consume: true};
            }
            return {
                onClick: event => this._activate(item, ...event.get_coords(), event.get_time()),
                consume: true,
            };
        default:
            if (!item.hidden)
                return {};
            return {onClick: () => this._scheduleClose(), consume: false};
        }
    }

    _scheduleClose() {
        if (this._closeIdleId)
            return;
        this._closeIdleId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this._closeIdleId = 0;
            this._closeFlyout();
            return GLib.SOURCE_REMOVE;
        });
    }

    // Drag and drop (delegate of DragTracker)

    dragReleaseFocus(item) {
        // The modal grab of the drag restores the key focus when it ends; if
        // that is the dragged button, now back in the panel, the panel's menu
        // manager would open its menu.
        const focus = global.stage.get_key_focus();
        if (focus && item.container.contains(focus))
            global.stage.set_key_focus(this._chevron.menu.isOpen ? this._chevron.menu.actor : null);
    }

    dragBegin(item) {
        this._dragging = true;
        this._updateChevron();
        this._tooltip.hide();
        item.button._waitDoubleClickPromise?.cancel();
        item.button.remove_style_pseudo_class('active');
        item.button.menu?.close?.(BoxPointer.PopupAnimation.NONE);
    }

    dragMotion(item, x, y) {
        const target = this._dropTarget(item, x, y);

        if (target?.type === 'chevron' && !this._chevron.menu.isOpen) {
            if (!this._hoverTimeoutId) {
                this._hoverTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, HOVER_OPEN_DELAY, () => {
                    this._hoverTimeoutId = 0;
                    this._openFlyoutForDrag();
                    return GLib.SOURCE_REMOVE;
                });
            }
        } else {
            this._clearHoverTimeout();
        }
        return target?.marker ?? null;
    }

    dragDrop(item, x, y) {
        const target = this._dropTarget(item, x, y);
        if (target?.type === 'box')
            this._dropInPanel(item, target.index);
        else if (target)
            this._dropInFlyout(item, target.type === 'grid' ? target.index : Infinity);
    }

    dragEnd(_item) {
        this._clearHoverTimeout();
        if (this._flyoutDetached) {
            this._flyoutDetached = false;
            this._chevron.menu.close(BoxPointer.PopupAnimation.NONE);
            Main.panel.menuManager.addMenu(this._chevron.menu);
        }
        this._dragging = false;
        if (this._syncAfterDrag) {
            this._syncAfterDrag = false;
            this._queueSync();
        } else {
            this._updateChevron();
        }
    }

    _clearHoverTimeout() {
        if (this._hoverTimeoutId)
            GLib.source_remove(this._hoverTimeoutId);
        this._hoverTimeoutId = 0;
    }

    _openFlyoutForDrag() {
        const menu = this._chevron.menu;
        if (menu.isOpen || this._grid.visibleChildren.length === 0)
            return;
        // Opened outside its manager: the manager's modal grab would sit on
        // top of the drag's grab and take its events.
        Main.panel.menuManager.removeMenu(menu);
        this._flyoutDetached = true;
        menu.open(BoxPointer.PopupAnimation.FULL);
    }

    // Drop targets are found by geometry: the panel boxes and the grid are
    // not reactive, so picking would miss the gaps between icons.
    _dropTarget(item, x, y) {
        if (this._chevron.menu.isOpen && containsPoint(this._chevron.menu.actor, x, y))
            return this._gridTarget(item, x, y);
        if (containsPoint(this._chevron.container, x, y))
            return {type: 'chevron', marker: null};
        if (containsPoint(this._trayBox, x, y))
            return this._boxTarget(item, x, y);
        return null;
    }

    _gridTarget(item, x, y) {
        const tiles = this._grid.visibleChildren;
        const [, localX, localY] = this._grid.transform_stage_point(x, y);
        const index = this._grid.slotAt(localX, localY, tiles.length);
        const [mx, my, height] = this._grid.markerAt(index);
        const [gx, gy] = this._grid.get_transformed_position();
        return {
            type: 'grid',
            index: tiles.slice(0, index).filter(t => t !== item.container).length,
            marker: [gx + mx, gy + my, height],
        };
    }

    _boxTarget(item, x, y) {
        const box = this._trayBox;
        const vertical = box.layout_manager?.orientation === Clutter.Orientation.VERTICAL;
        const rtl = !vertical && box.get_text_direction() === Clutter.TextDirection.RTL;
        const all = box.get_children();
        // Only the tray icons are slots, so nothing lands among system menus.
        const icons = all.filter(c => {
            const other = this._items.get(c.get_first_child());
            return other && !other.hidden && c !== item.container && c.visible && c.width > 0;
        });
        const before = icons.find(c => {
            const [cx, cy] = c.get_transformed_position();
            if (vertical)
                return y < cy + c.height / 2;
            return rtl ? x > cx + c.width / 2 : x < cx + c.width / 2;
        });

        const index = before ? all.indexOf(before) : this._lastPromotedIndex() + 1;
        const reference = before ?? icons[icons.length - 1] ?? this._chevron.container;
        let marker = null;
        if (!vertical) {
            const [rx, ry] = reference.get_transformed_position();
            const leadingEdge = before ? !rtl : rtl;
            marker = [rx + (leadingEdge ? 0 : reference.width), ry, reference.height];
        }
        return {type: 'box', index, marker};
    }

    _dropInPanel(item, index) {
        const all = this._trayBox.get_children();
        const following = all.slice(index)
            .map(c => this._items.get(c.get_first_child()))
            .find(other => other && other !== item && !other.hidden);

        const current = all.indexOf(item.container);
        this._placeInPanel(item, current >= 0 && current < index ? index - 1 : index);
        this._writeOrder(item.key, false, following?.key);
    }

    _dropInFlyout(item, index) {
        const tiles = this._grid.visibleChildren.filter(t => t !== item.container);
        const following = this._items.get(tiles[index]?.get_first_child())?.key;
        this._placeInFlyout(item);
        this._writeOrder(item.key, true, following);
    }

    _writeOrder(key, hidden, followingKey) {
        const promoted = this._settings.get_strv('promoted-items').filter(k => k !== key);
        const hiddenItems = this._settings.get_strv('hidden-items').filter(k => k !== key);
        const list = hidden ? hiddenItems : promoted;
        const at = followingKey ? list.indexOf(followingKey) : -1;
        list.splice(at < 0 ? list.length : at, 0, key);

        this._syncAfterDrag = true;
        this._settings.set_strv('promoted-items', promoted);
        this._settings.set_strv('hidden-items', hiddenItems);
    }
}
