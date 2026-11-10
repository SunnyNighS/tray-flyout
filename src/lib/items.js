// SPDX-License-Identifier: GPL-2.0-or-later

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import {ExtensionState} from 'resource:///org/gnome/shell/misc/extensionUtils.js';

export const OWN_ROLE = 'tray-flyout';

export const ItemKind = Object.freeze({
    SNI: 'sni',
    XEMBED: 'xembed',
    EXTENSION: 'ext',
});

const APPINDICATOR_PREFIX = 'appindicator-';

const TRAY_HOSTS = [
    'appindicatorsupport@rgcjonas.gmail.com',
    'ubuntu-appindicators@ubuntu.com',
    'zorin-appindicator@zorinos.com',
];

/**
 * Right after an AppIndicator extension is disabled its buttons are still
 * registered for a moment while they are torn down; they must not be moved.
 *
 * @returns {boolean} whether the tray icons of the panel can be used
 */
export function trayHostActive() {
    const active = ExtensionState.ACTIVE ?? ExtensionState.ENABLED;
    const hosts = TRAY_HOSTS.map(uuid => Main.extensionManager.lookup(uuid)).filter(Boolean);
    return hosts.length === 0 || hosts.some(host => host.state === active);
}

const SYSTEM_ROLES = new Set([
    OWN_ROLE,
    'activities',
    'appMenu',
    'dateMenu',
    'quickSettings',
    'a11y',
    'keyboard',
    'dwellClick',
    'screenRecording',
    'screenSharing',
]);

// Ids that some toolkits generate per process instead of per application.
const GENERIC_SNI_ID = /^(chrome_status_icon_\d+|systray_\d+|\d*)$/;
// Electron counts the tray icons of a process: <App>_status_icon_<N>.
const ELECTRON_SNI_ID = /^(.+_status_icon)_\d+$/;

/**
 * Describes a status area button as a tray item.
 *
 * Returns null for buttons that are never managed. SNI icons of the
 * AppIndicator extension that are not ready yet (no Id known) are returned
 * with `key: null` so the caller can wait for them.
 *
 * @param {string} role statusArea role
 * @param {PanelMenu.Button} button the button registered for the role
 * @returns {?{kind: string, key: ?string}}
 */
export function classify(role, button) {
    if (!(button instanceof PanelMenu.Button) || SYSTEM_ROLES.has(role))
        return null;

    if (!role.startsWith(APPINDICATOR_PREFIX))
        return {kind: ItemKind.EXTENSION, key: `ext:${role}`};

    if (button._indicator)
        return {kind: ItemKind.SNI, key: sniKey(button._indicator)};

    const wmClass = button._icon?.wm_class;
    if (wmClass)
        return {kind: ItemKind.XEMBED, key: `xembed:${wmClass}`};

    return null;
}

function sniKey(indicator) {
    if (!indicator.isReady)
        return null;

    const id = indicator.id ?? '';
    if (GENERIC_SNI_ID.test(id)) {
        // Generic Ids are only told apart by the title; icons of different
        // applications without a title share one key.
        return indicator.title ? `sni-title:${indicator.title}` : `sni-id:${id}`;
    }
    return `sni:${id.replace(ELECTRON_SNI_ID, '$1')}`;
}

/**
 * @param {string} key a stored key, possibly from an older version
 * @returns {string} the key as computed by this version
 */
export function normalizeKey(key) {
    return key.startsWith('sni:') ? `sni:${key.slice(4).replace(ELECTRON_SNI_ID, '$1')}` : key;
}

/**
 * @param {?Clutter.Actor} actor child of a panel box
 * @returns {boolean} whether it is a tray icon button of the AppIndicator extension
 */
export function isTrayButton(actor) {
    return actor instanceof PanelMenu.Button &&
        typeof actor.isReady === 'function' && 'uniqueId' in actor;
}

/**
 * @param {string} kind item kind
 * @param {string} role statusArea role
 * @param {PanelMenu.Button} button the item's button
 * @returns {string} name shown in the preferences
 */
export function displayName(kind, role, button) {
    switch (kind) {
    case ItemKind.SNI: {
        const indicator = button._indicator;
        return indicator._appInfo?.get_display_name() || indicator.title || indicator.id;
    }
    case ItemKind.XEMBED:
        return button._icon.wm_class;
    default:
        return button.accessible_name || role;
    }
}
