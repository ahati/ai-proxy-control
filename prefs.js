/* AI Proxy Control - Preferences Dialog
 *
 * Configures the ai-proxy launch command: port, conversation store size and
 * TTL, additional arguments, and auto-start behavior.
 */

import Gtk from 'gi://Gtk';
import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import { ExtensionPreferences, gettext as _ } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class AiProxyControlPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        this._window = window;

        const page = new Adw.PreferencesPage({
            title: _('General'), icon_name: 'preferences-system-symbolic',
        });
        window.add(page);

        const serverGroup = new Adw.PreferencesGroup({
            title: _('Server'),
            description: _('Options passed to ai-proxy on start.'),
        });
        page.add(serverGroup);

        const portRow = new Adw.EntryRow({
            title: _('Port (-port)'),
            text: settings.get_string('port'),
        });
        serverGroup.add(portRow);
        portRow.connect('changed', row => {
            settings.set_string('port', row.text.trim());
        });

        const sizeRow = new Adw.SpinRow({
            title: _('Conversation store size'),
            subtitle: _('-conversation-store-size: max conversations kept in memory.'),
            adjustment: Gtk.Adjustment.new(
                settings.get_int('conversation-store-size'), 0, 1000000, 10, 50, 0),
            climb_rate: 1, digits: 0,
        });
        serverGroup.add(sizeRow);
        sizeRow.connect('notify::value', row => {
            settings.set_int('conversation-store-size', Math.round(row.value));
        });

        const ttlRow = new Adw.EntryRow({
            title: _('Conversation store TTL (-conversation-store-ttl)'),
            text: settings.get_string('conversation-store-ttl'),
        });
        serverGroup.add(ttlRow);
        ttlRow.connect('changed', row => {
            settings.set_string('conversation-store-ttl', row.text.trim());
        });

        const extraRow = new Adw.EntryRow({
            title: _('Extra arguments'),
            text: settings.get_string('extra-args'),
        });
        serverGroup.add(extraRow);
        extraRow.connect('changed', row => {
            settings.set_string('extra-args', row.text);
        });

        /* ── Logging ── */
        const loggingGroup = new Adw.PreferencesGroup({
            title: _('Logging'),
            description: _('Where ai-proxy stdout/stderr is appended. Restart ai-proxy for a new path to take effect.'),
        });
        page.add(loggingGroup);

        const DEFAULT_LOG_PATH = '~/.local/share/ai-proxy-control/ai-proxy.log';
        const currentLog = settings.get_string('log-path');
        const logRow = new Adw.ActionRow({
            title: _('Log file'),
            subtitle: currentLog ? currentLog : DEFAULT_LOG_PATH,
        });
        loggingGroup.add(logRow);
        this._logRow = logRow;
        this._logSettings = settings;

        const chooseBtn = new Gtk.Button({
            label: _('Choose…'),
            valign: Gtk.Align.CENTER,
        });
        chooseBtn.connect('clicked', () => this._chooseLogFile());
        logRow.add_suffix(chooseBtn);

        const resetBtn = new Gtk.Button({
            label: _('Reset'),
            valign: Gtk.Align.CENTER,
            sensitive: !!currentLog,
        });
        resetBtn.connect('clicked', () => {
            settings.set_string('log-path', '');
            logRow.subtitle = DEFAULT_LOG_PATH;
            resetBtn.sensitive = false;
        });
        logRow.add_suffix(resetBtn);

        const behaviorGroup = new Adw.PreferencesGroup({ title: _('Behavior') });
        page.add(behaviorGroup);

        const autoStartRow = new Adw.SwitchRow({
            title: _('Auto-start on enable'),
            subtitle: _('Launch ai-proxy when the extension is enabled, if it is not already running.'),
            active: settings.get_boolean('auto-start'),
        });
        behaviorGroup.add(autoStartRow);
        autoStartRow.connect('notify::active', row => {
            settings.set_boolean('auto-start', row.active);
        });
    }

    /* ── Log file picker (GTK 4.10+ async FileDialog) ── */
    _chooseLogFile() {
        const settings = this._logSettings;
        const logRow = this._logRow;
        const window = this._window;
        const DEFAULT_LOG_PATH = '~/.local/share/ai-proxy-control/ai-proxy.log';

        const dialog = new Gtk.FileDialog({
            title: _('Choose log file'),
            modal: true,
        });

        const current = settings.get_string('log-path');
        if (current) {
            try {
                dialog.set_initial_file(Gio.File.new_for_path(current));
            } catch (e) { /* ignore */ }
        }

        dialog.open(window, null, (self, res) => {
            try {
                const file = self.open_finish(res);
                if (file) {
                    const path = file.get_path();
                    settings.set_string('log-path', path);
                    logRow.subtitle = path;
                }
            } catch (e) {
                /* Cancelled or error — keep existing setting. */
            }
        });
    }
}
