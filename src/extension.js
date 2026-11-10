// SPDX-License-Identifier: GPL-2.0-or-later

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {TrayFlyout} from './lib/controller.js';

export default class TrayFlyoutExtension extends Extension {
    enable() {
        const iconFile = this.dir.get_child('icons').get_child('tray-flyout-chevron-symbolic.svg');
        this._trayFlyout = new TrayFlyout(this.getSettings(), iconFile.get_path());
    }

    disable() {
        this._trayFlyout.destroy();
        this._trayFlyout = null;
    }
}
