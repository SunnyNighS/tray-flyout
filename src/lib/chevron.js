// SPDX-License-Identifier: GPL-2.0-or-later

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Graphene from 'gi://Graphene';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

/**
 * Lays out its visible children in a near-square grid of equal cells.
 * A child counts as visible when the container and its button are visible;
 * the AppIndicator extension hides the button of passive icons.
 */
export const FlyoutGrid = GObject.registerClass(
class FlyoutGrid extends St.Widget {
    _init() {
        super._init({style_class: 'tray-flyout-grid'});
        this._maxColumns = 0;
        this._cell = 0;
        this._columns = 1;
    }

    set maxColumns(columns) {
        this._maxColumns = columns;
        this.queue_relayout();
    }

    get visibleChildren() {
        return this.get_children().filter(c => c.visible && c.get_first_child()?.visible);
    }

    get columns() {
        return this._columns;
    }

    _computeColumns(count) {
        const columns = Math.max(1, Math.ceil(Math.sqrt(count)));
        return this._maxColumns > 0 ? Math.min(columns, this._maxColumns) : columns;
    }

    _computeCell(children) {
        let cell = 0;
        for (const child of children) {
            const [, width] = child.get_preferred_width(-1);
            const [, height] = child.get_preferred_height(-1);
            cell = Math.max(cell, width, height);
        }
        return Math.ceil(cell);
    }

    _measure() {
        const children = this.visibleChildren;
        const columns = this._computeColumns(children.length);
        const rows = Math.ceil(children.length / columns);
        const cell = this._computeCell(children);
        const spacing = this.get_theme_node().get_length('spacing');
        return {
            children,
            columns,
            cell,
            spacing,
            width: columns * cell + Math.max(0, columns - 1) * spacing,
            height: rows * cell + Math.max(0, rows - 1) * spacing,
        };
    }

    vfunc_get_preferred_width(_forHeight) {
        const {width} = this._measure();
        return this.get_theme_node().adjust_preferred_width(width, width);
    }

    vfunc_get_preferred_height(_forWidth) {
        const {height} = this._measure();
        return this.get_theme_node().adjust_preferred_height(height, height);
    }

    vfunc_allocate(box) {
        this.set_allocation(box);
        const content = this.get_theme_node().get_content_box(box);
        const {children, columns, cell, spacing} = this._measure();

        this._columns = columns;
        this._cell = cell;
        this._origin = [content.x1, content.y1];
        this._spacing = spacing;

        const childBox = new Clutter.ActorBox();
        children.forEach((child, i) => {
            const x = content.x1 + (i % columns) * (cell + spacing);
            const y = content.y1 + Math.floor(i / columns) * (cell + spacing);
            childBox.set_origin(x, y);
            childBox.set_size(cell, cell);
            child.allocate(childBox);
        });

        // Containers of hidden buttons (passive icons) need an allocation too.
        const laidOut = new Set(children);
        const empty = new Clutter.ActorBox({x1: content.x1, y1: content.y1, x2: content.x1, y2: content.y1});
        for (const child of this.get_children()) {
            if (!laidOut.has(child))
                child.allocate(empty);
        }
    }

    /**
     * @param {number} x local x coordinate
     * @param {number} y local y coordinate
     * @param {number} count number of slots that can be targeted
     * @returns {number} index of the slot under the point
     */
    slotAt(x, y, count) {
        const [x0, y0] = this._origin ?? [0, 0];
        const step = this._cell + this._spacing;
        if (step <= 0)
            return count;
        const column = Math.min(this._columns - 1, Math.max(0, Math.floor((x - x0) / step)));
        const row = Math.max(0, Math.floor((y - y0) / step));
        const after = x - x0 - column * step > this._cell / 2 ? 1 : 0;
        return Math.min(count, row * this._columns + column + after);
    }

    /**
     * @param {number} index slot index, may equal the number of slots
     * @returns {number[]} local [x, y, height] of the insertion marker
     */
    markerAt(index) {
        const [x0, y0] = this._origin ?? [0, 0];
        const step = this._cell + this._spacing;
        let column = index % this._columns;
        let row = Math.floor(index / this._columns);
        if (index > 0 && column === 0) {
            column = this._columns;
            row -= 1;
        }
        return [x0 + column * step - this._spacing / 2, y0 + row * step, this._cell];
    }
});

const TOOLTIP_DELAY = 500;

/**
 * Name label shown above a hovered or focused icon in the flyout.
 */
export class Tooltip {
    constructor() {
        this._label = new St.Label({style_class: 'tray-flyout-tooltip', visible: false});
        Main.uiGroup.add_child(this._label);
        this._timeoutId = 0;
    }

    schedule(actor, text) {
        this.hide();
        if (!text)
            return;
        this._timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, TOOLTIP_DELAY, () => {
            this._timeoutId = 0;
            this._show(actor, text);
            return GLib.SOURCE_REMOVE;
        });
    }

    hide() {
        if (this._timeoutId)
            GLib.source_remove(this._timeoutId);
        this._timeoutId = 0;
        this._label.hide();
    }

    destroy() {
        this.hide();
        this._label.destroy();
    }

    _show(actor, text) {
        if (!actor.mapped)
            return;
        this._label.text = text;
        this._label.show();
        Main.uiGroup.set_child_above_sibling(this._label, null);

        const [x, y] = actor.get_transformed_position();
        const [width] = actor.get_transformed_size();
        const monitor = Main.layoutManager.findMonitorForActor(actor);
        const gap = 6;
        let labelX = x + (width - this._label.width) / 2;
        if (monitor)
            labelX = Math.max(monitor.x, Math.min(labelX, monitor.x + monitor.width - this._label.width));
        this._label.set_position(Math.round(labelX), Math.round(y - this._label.height - gap));
    }
}

export const ChevronButton = GObject.registerClass({
    Signals: {
        'tile-activate': {param_types: [Clutter.Actor.$gtype]},
        'tile-menu': {param_types: [Clutter.Actor.$gtype]},
    },
}, class ChevronButton extends PanelMenu.Button {
    _init(iconFile) {
        super._init(0.5, _('Show hidden icons'));
        this.add_style_class_name('tray-flyout-chevron');

        this._icon = new St.Icon({
            gicon: Gio.icon_new_for_string(iconFile),
            style_class: 'system-status-icon tray-flyout-chevron-icon',
            pivot_point: new Graphene.Point({x: 0.5, y: 0.5}),
        });
        this.add_child(this._icon);

        this.menu.actor.add_style_class_name('tray-flyout-menu');
        this.grid = new FlyoutGrid();
        this.menu.box.add_child(this.grid);

        this.menu.actor.connect('captured-event', this._onMenuCapturedEvent.bind(this));
        this.menu.connect('open-state-changed', () => this.updateDirection());
        this.connect('notify::mapped', () => this.updateDirection());
    }

    /**
     * Points the chevron away from the closest monitor edge, i.e. towards
     * the side where the flyout opens.
     */
    updateDirection() {
        if (!this.mapped)
            return;
        const monitor = Main.layoutManager.findMonitorForActor(this);
        if (!monitor)
            return;
        const [x, y] = this.get_transformed_position();
        const [width, height] = this.get_transformed_size();
        const edges = [
            [0, monitor.y + monitor.height - (y + height)],
            [180, y - monitor.y],
            [90, x - monitor.x],
            [-90, monitor.x + monitor.width - (x + width)],
        ];
        edges.sort((a, b) => a[1] - b[1]);
        this._icon.rotation_angle_z = edges[0][0];
    }

    focusTile(index) {
        const tiles = this.grid.visibleChildren;
        if (tiles.length === 0)
            return;
        const tile = tiles[(index + tiles.length) % tiles.length];
        tile.get_first_child().grab_key_focus();
    }

    _focusedTileIndex(tiles) {
        const focus = global.stage.get_key_focus();
        return focus ? tiles.findIndex(t => t.contains(focus)) : -1;
    }

    _onMenuCapturedEvent(_actor, event) {
        if (event.type() !== Clutter.EventType.KEY_PRESS)
            return Clutter.EVENT_PROPAGATE;

        const tiles = this.grid.visibleChildren;
        const index = this._focusedTileIndex(tiles);
        const symbol = event.get_key_symbol();
        const shift = (event.get_state() & Clutter.ModifierType.SHIFT_MASK) !== 0;
        const columns = this.grid.columns;
        const count = tiles.length;

        const move = target => {
            this.focusTile(index < 0 ? 0 : target);
            return Clutter.EVENT_STOP;
        };

        switch (symbol) {
        case Clutter.KEY_Left:
            return move(index - 1);
        case Clutter.KEY_Right:
            return move(index + 1);
        case Clutter.KEY_Up:
            return move(index - columns < 0
                ? index + columns * Math.floor((count - 1 - index) / columns)
                : index - columns);
        case Clutter.KEY_Down:
            return move(index + columns >= count ? index % columns : index + columns);
        case Clutter.KEY_Return:
        case Clutter.KEY_KP_Enter:
        case Clutter.KEY_space:
            if (index < 0)
                return Clutter.EVENT_PROPAGATE;
            this.emit('tile-activate', tiles[index]);
            return Clutter.EVENT_STOP;
        case Clutter.KEY_Menu:
        case Clutter.KEY_F10:
            if (index < 0 || (symbol === Clutter.KEY_F10 && !shift))
                return Clutter.EVENT_PROPAGATE;
            this.emit('tile-menu', tiles[index]);
            return Clutter.EVENT_STOP;
        default:
            return Clutter.EVENT_PROPAGATE;
        }
    }
});
