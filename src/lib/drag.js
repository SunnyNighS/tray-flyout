// SPDX-License-Identifier: GPL-2.0-or-later

import Clutter from 'gi://Clutter';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

/**
 * Press and drag tracking for tray buttons.
 *
 * GNOME Shell's dnd.js cannot be detached from an actor again before
 * GNOME 49, and the buttons belong to other extensions. So until the drag
 * threshold is crossed the press is followed through the button's own
 * `event` signal (the stage keeps an implicit grab on the pressed actor),
 * and once a drag starts all input goes to a modal grab on an actor of our
 * own, like dnd.js does.
 *
 * The delegate provides:
 * - dragReleaseFocus(item): called right before the modal grab is taken
 * - dragBegin(item)
 * - dragMotion(item, x, y): returns an insertion marker [x, y, height] or null
 * - dragDrop(item, x, y)
 * - dragEnd(item)
 */
export class DragTracker {
    constructor(delegate) {
        this._delegate = delegate;
        this._state = null;
    }

    get dragging() {
        return this._state?.dragging ?? false;
    }

    tracks(item) {
        return this._state?.item === item;
    }

    /**
     * @param {object} item tray item with `button` and `container`
     * @param {Clutter.Event} event primary button press
     * @param {object} click what to do when the press ends without a drag
     * @param {?Function} click.onClick called with the release event
     * @param {boolean} click.consume whether the release is consumed
     */
    press(item, event, {onClick = null, consume = false} = {}) {
        this.cancel();
        const [x, y] = event.get_coords();
        this._state = {item, onClick, consume, startX: x, startY: y, dragging: false};
    }

    /**
     * Handles an event of the pressed button before the drag has started.
     *
     * @param {Clutter.Event} event the event
     * @returns {boolean} whether the event was handled
     */
    handlePressEvent(event) {
        const state = this._state;

        switch (event.type()) {
        case Clutter.EventType.MOTION: {
            if (!(event.get_state() & Clutter.ModifierType.BUTTON1_MASK)) {
                // The release went elsewhere, e.g. to a menu that opened.
                this._state = null;
                return Clutter.EVENT_PROPAGATE;
            }
            const [x, y] = event.get_coords();
            const threshold = St.Settings.get().drag_threshold;
            if (Math.abs(x - state.startX) <= threshold && Math.abs(y - state.startY) <= threshold)
                return Clutter.EVENT_PROPAGATE;
            this._begin(state, x, y);
            return Clutter.EVENT_STOP;
        }
        case Clutter.EventType.BUTTON_RELEASE:
            if (event.get_button() !== Clutter.BUTTON_PRIMARY)
                return Clutter.EVENT_PROPAGATE;
            this._state = null;
            state.onClick?.(event);
            return state.consume ? Clutter.EVENT_STOP : Clutter.EVENT_PROPAGATE;
        default:
            return Clutter.EVENT_PROPAGATE;
        }
    }

    cancel() {
        const state = this._state;
        if (state)
            this._finish(state);
    }

    destroy() {
        this.cancel();
        this._delegate = null;
    }

    _begin(state, x, y) {
        const {item} = state;
        const container = item.container;
        const [cx, cy] = container.get_transformed_position();

        state.offsetX = state.startX - cx;
        state.offsetY = state.startY - cy;
        state.actor = new Clutter.Clone({
            source: container,
            reactive: false,
            opacity: 200,
            width: container.width,
            height: container.height,
        });
        state.marker = new St.Widget({style_class: 'tray-flyout-drop-marker', visible: false});
        state.eventActor = new Clutter.Actor({width: 0, height: 0, reactive: true});
        Main.uiGroup.add_child(state.actor);
        Main.uiGroup.add_child(state.marker);
        Main.uiGroup.add_child(state.eventActor);
        state.eventActor.connect('event', (_a, event) => this._onDragEvent(state, event));

        this._delegate.dragReleaseFocus(item);
        state.grab = Main.pushModal(state.eventActor, {actionMode: Shell.ActionMode.POPUP});
        if (!(state.grab.get_seat_state() & Clutter.GrabState.POINTER)) {
            this._finish(state);
            return;
        }

        state.dragging = true;
        this._delegate.dragBegin(item);
        container.opacity = 96;
        this._move(state, x, y);
    }

    _onDragEvent(state, event) {
        const type = event.type();
        // Crossing events must propagate; everything else is taken by the drag.
        if (type === Clutter.EventType.ENTER || type === Clutter.EventType.LEAVE)
            return Clutter.EVENT_PROPAGATE;

        switch (type) {
        case Clutter.EventType.MOTION: {
            const [x, y] = event.get_coords();
            this._move(state, x, y);
            break;
        }
        case Clutter.EventType.BUTTON_RELEASE: {
            if (event.get_button() !== Clutter.BUTTON_PRIMARY)
                break;
            const [x, y] = event.get_coords();
            state.marker.hide();
            this._delegate.dragDrop(state.item, x, y);
            this._finish(state);
            break;
        }
        case Clutter.EventType.KEY_PRESS:
            if (event.get_key_symbol() === Clutter.KEY_Escape)
                this._finish(state);
            break;
        }
        return Clutter.EVENT_STOP;
    }

    _move(state, x, y) {
        state.actor.set_position(x - state.offsetX, y - state.offsetY);
        // The flyout may have opened above the drag actor in the meantime.
        Main.uiGroup.set_child_above_sibling(state.actor, null);

        const rect = this._delegate.dragMotion(state.item, x, y);
        if (!rect) {
            state.marker.hide();
            return;
        }
        const [mx, my, height] = rect;
        state.marker.height = Math.round(height);
        state.marker.set_position(Math.round(mx - state.marker.width / 2), Math.round(my));
        state.marker.show();
        Main.uiGroup.set_child_above_sibling(state.marker, null);
    }

    _finish(state) {
        this._state = null;
        if (state.grab)
            Main.popModal(state.grab);
        state.actor?.destroy();
        state.marker?.destroy();
        state.eventActor?.destroy();

        if (!state.dragging)
            return;
        if (!state.item.destroyed)
            state.item.container.opacity = 255;
        this._delegate.dragEnd(state.item);
    }
}
