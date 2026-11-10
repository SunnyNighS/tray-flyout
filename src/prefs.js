// SPDX-License-Identifier: GPL-2.0-or-later

import Adw from 'gi://Adw';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences, gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

function kindLabel(key) {
    if (key.startsWith('ext:'))
        return _('Extension button');
    if (key.startsWith('xembed:'))
        return _('Legacy tray icon');
    return _('Application');
}

class TrayIconList {
    constructor(settings, group) {
        this._settings = settings;
        this._group = group;
        this._rows = new Map();
        this._updating = false;

        this._handlerIds = [
            settings.connect('changed::known-items', () => this._rebuild()),
            settings.connect('changed::promoted-items', () => this._updateStates()),
            settings.connect('changed::hidden-items', () => this._updateStates()),
        ];
        this._rebuild();
    }

    destroy() {
        for (const id of this._handlerIds)
            this._settings.disconnect(id);
        this._handlerIds = [];
    }

    _rebuild() {
        for (const row of this._rows.values())
            this._group.remove(row);
        this._rows.clear();
        if (this._placeholder)
            this._group.remove(this._placeholder);
        this._placeholder = null;

        const known = this._settings.get_value('known-items').deepUnpack();
        const keys = Object.keys(known)
            .sort((a, b) => known[a].localeCompare(known[b]));

        if (keys.length === 0) {
            this._placeholder = new Adw.ActionRow({title: _('No tray icons seen yet')});
            this._group.add(this._placeholder);
            return;
        }

        for (const key of keys) {
            const row = new Adw.SwitchRow({title: known[key], subtitle: kindLabel(key)});
            const forget = new Gtk.Button({
                icon_name: 'user-trash-symbolic',
                valign: Gtk.Align.CENTER,
                tooltip_text: _('Forget this icon'),
                css_classes: ['flat'],
            });
            forget.connect('clicked', () => this._forget(key));
            row.add_suffix(forget);
            row.connect('notify::active', () => this._onToggled(key, row.active));
            this._rows.set(key, row);
            this._group.add(row);
        }
        this._updateStates();
    }

    _updateStates() {
        const promoted = this._settings.get_strv('promoted-items');
        this._updating = true;
        for (const [key, row] of this._rows)
            row.active = promoted.includes(key);
        this._updating = false;
    }

    _onToggled(key, shown) {
        if (this._updating)
            return;
        const promoted = this._settings.get_strv('promoted-items').filter(k => k !== key);
        const hidden = this._settings.get_strv('hidden-items').filter(k => k !== key);
        (shown ? promoted : hidden).push(key);
        this._writeLists(promoted, hidden);
    }

    _forget(key) {
        const known = this._settings.get_value('known-items').deepUnpack();
        delete known[key];
        this._writeLists(
            this._settings.get_strv('promoted-items').filter(k => k !== key),
            this._settings.get_strv('hidden-items').filter(k => k !== key));
        this._settings.set_value('known-items', new GLib.Variant('a{ss}', known));
    }

    _writeLists(promoted, hidden) {
        this._settings.set_strv('promoted-items', promoted);
        this._settings.set_strv('hidden-items', hidden);
    }
}

export default class TrayFlyoutPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        window.set_default_size(640, 860);
        const page = new Adw.PreferencesPage();
        window.add(page);

        const behavior = new Adw.PreferencesGroup({title: _('Behavior')});
        page.add(behavior);

        const addSwitch = (key, title, subtitle) => {
            const row = new Adw.SwitchRow({title, subtitle});
            settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
            behavior.add(row);
        };
        addSwitch('show-hidden-icon-menu', _('Hidden icon menu'),
            _('Show the chevron that opens the flyout. When off, icons that are not shown in the panel are not shown at all.'));
        addSwitch('show-all-icons', _('Show all icons in the panel'),
            _('Ignore the flyout and show every tray icon in the panel.'));
        addSwitch('new-icons-hidden', _('Put new icons into the flyout'),
            _('Icons of applications that were not seen before start in the flyout.'));
        addSwitch('left-click-activates', _('Left click opens the application'),
            _('When off, a left click opens the menu and a double click opens the application.'));
        addSwitch('manage-extension-buttons', _('Include buttons of other extensions'),
            _('Buttons of other extensions next to the tray can be moved into the flyout, too.'));

        const columns = new Adw.SpinRow({
            title: _('Maximum columns'),
            subtitle: _('0 arranges the icons in a square'),
            adjustment: new Gtk.Adjustment({lower: 0, upper: 12, step_increment: 1}),
        });
        settings.bind('max-columns', columns, 'value', Gio.SettingsBindFlags.DEFAULT);
        behavior.add(columns);

        const shortcut = new Adw.EntryRow({
            title: _('Keyboard shortcut to open the flyout'),
            text: settings.get_strv('focus-tray-shortcut')[0] ?? '',
            show_apply_button: true,
        });
        shortcut.connect('apply', () => {
            const text = shortcut.text.trim();
            const [valid] = Gtk.accelerator_parse(text);
            if (text && !valid) {
                shortcut.add_css_class('error');
                return;
            }
            shortcut.remove_css_class('error');
            settings.set_strv('focus-tray-shortcut', text ? [text] : []);
        });
        behavior.add(shortcut);

        const icons = new Adw.PreferencesGroup({
            title: _('Tray icons'),
            description: _('Switched on: shown in the panel. Switched off: shown in the flyout. Icons can also be dragged between panel and flyout.'),
        });
        page.add(icons);
        const iconList = new TrayIconList(settings, icons);
        window.connect('close-request', () => {
            iconList.destroy();
            return false;
        });
    }
}
