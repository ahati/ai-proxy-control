/* AI Proxy Control — GNOME Shell Extension
 *
 * Adds a top-bar indicator to start, stop, and monitor the ai-proxy server.
 * Status is detected by polling `pgrep -x ai-proxy`, so the indicator
 * reflects whatever ai-proxy instance is currently running — even one
 * started outside this extension. Process output is appended to a log file
 * under ~/.local/share/ai-proxy-control/ai-proxy.log.
 */

import GObject from 'gi://GObject';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Pango from 'gi://Pango';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as ModalDialog from 'resource:///org/gnome/shell/ui/modalDialog.js';

/* Adwaita-derived palette — green=running, gray=stopped, red=error. */
const COLOR_GREEN = '#2ec27e';
const COLOR_RED = '#e01b24';
const COLOR_MUTED = '#9ca3af';

const PROCESS_NAME = 'ai-proxy';
const POLL_INTERVAL_SEC = 3;
const RESTART_GAP_MS = 1200;
const START_SETTLE_MS = 1000;

/* Per-user data dir for logs. */
function dataDir() {
    const xdg = GLib.get_user_data_dir();
    return GLib.build_filenamev([xdg, 'ai-proxy-control']);
}

function logPath(settings) {
    /* Prefer a user-configured path; fall back to the per-user data dir. */
    const configured = settings ? settings.get_string('log-path') : '';
    if (configured && configured.trim()) return configured.trim();
    return GLib.build_filenamev([dataDir(), 'ai-proxy.log']);
}

/* Resolve the ai-proxy binary: prefer $PATH, fall back to the known install
 * location. Returns null if it cannot be found or is not executable. */
function resolveBinary() {
    let p = GLib.find_program_in_path(PROCESS_NAME);
    if (!p) {
        const fallback = GLib.build_filenamev([GLib.get_home_dir(), '.local', 'bin', PROCESS_NAME]);
        if (GLib.file_test(fallback, GLib.FileTest.IS_EXECUTABLE)) p = fallback;
    }
    return p || null;
}

/* Run a short command synchronously and return its stdout (trimmed). Returns
 * '' on failure or empty output. Used for pgrep/pkill-style probes. */
function runCapture(argv) {
    try {
        const [, stdout] = GLib.spawn_sync(null, argv, null,
            GLib.SpawnFlags.SEARCH_PATH, null);
        const out = stdout ? imports.byteArray.toString(stdout).trim() : '';
        return out;
    } catch (e) {
        return '';
    }
}

/* Detect live (non-zombie) ai-proxy process(es). Returns an array of PIDs.
 *
 * pgrep matches defunct/zombie children too, and an ai-proxy spawned by a
 * prior shell session can linger as an unreaped zombie after Stop — which
 * would keep the indicator pinned on "Running". We therefore list matching
 * PIDs via pgrep and then drop any whose /proc/<pid>/stat state is 'Z'
 * (zombie). pgrep exits non-zero when nothing matches, which spawn_sync
 * surfaces as an error — caught and treated as "not running". */
function detectPids() {
    const out = runCapture(['pgrep', '-x', PROCESS_NAME]);
    if (!out) return [];
    return out.split(/\s+/)
        .map(s => parseInt(s, 10))
        .filter(n => !isNaN(n))
        .filter(pid => processState(pid) !== 'Z');
}

/* Read the single-letter process state from /proc/<pid>/stat. Returns '' if
 * the process is gone or the field can't be parsed. Field 3 is the state,
 * but the comm field (2) is parenthesized and may contain spaces/parens, so
 * parse from the last ')' onward. */
function processState(pid) {
    try {
        const path = `/proc/${pid}/stat`;
        const [, bytes] = GLib.file_get_contents(path);
        const stat = bytes ? imports.byteArray.toString(bytes) : '';
        const rp = stat.lastIndexOf(')');
        if (rp < 0) return '';
        return stat.slice(rp + 2).trim().split(/\s+/)[0] || '';
    } catch (e) {
        return '';
    }
}

/* Append an SVG status dot element as a child to a row. Color is applied via
 * inline style. */
function makeDot(color) {
    return new St.Icon({
        icon_name: 'media-record-symbolic',
        style_class: 'aiproxy-dot',
        style: `color: ${color};`,
    });
}

/* ── Live log viewer window ──
 *
 * A floating window (added to Main.uiGroup) that tails the ai-proxy log file.
 * It re-reads the file on an interval and renders the last N lines in a
 * monospace, scrollable text view. Self-contained: own timeout, own destroy.
 * Emits 'closed' when dismissed. */

const LOG_TAIL_MS = 1000;
const LOG_MAX_LINES = 1000;
const LOG_WINDOW_W = 720;
const LOG_WINDOW_H = 480;

/* Read the tail of a file as text. Returns {lines: [...], exists: bool,
 * error: string|null}. Uses sync IO — acceptable for a viewer polled at 1Hz. */
function readLogTail(path, maxLines) {
    const file = Gio.File.new_for_path(path);
    try {
        if (!file.query_exists(null)) {
            return { lines: [], exists: false, error: null };
        }
        const [ok, contents] = file.load_contents(null);
        if (!ok) return { lines: [], exists: true, error: 'read failed' };
        const text = contents ? imports.byteArray.toString(contents) : '';
        const allLines = text.length ? text.split(/\r?\n/) : [];
        // Drop a trailing empty element from a final newline.
        if (allLines.length && allLines[allLines.length - 1] === '') allLines.pop();
        const lines = allLines.length > maxLines
            ? allLines.slice(allLines.length - maxLines)
            : allLines;
        return { lines, exists: true, error: null };
    } catch (e) {
        return { lines: [], exists: true, error: String(e) };
    }
}

const LogViewerWindow = GObject.registerClass(
    { GTypeName: 'AiProxyLogViewerWindow', Signals: { 'closed': {} } },
    class LogViewerWindow extends St.BoxLayout {
        _init(settings) {
            super._init({
                vertical: true,
                style_class: 'aiproxy-log-window',
                reactive: true,
                can_focus: true,
                track_hover: true,
            });
            this._settings = settings;
            this._paused = false;
            this._autoScroll = true;
            this._tickId = 0;

            this._buildChrome();

            /* Fixed size: set after construction (Clutter uses width/height
             * request props, but set_size is unambiguous for a chrome window). */
            this.set_size(LOG_WINDOW_W, LOG_WINDOW_H);

            /* Mount into the UI layer above everything and make it visible.
             * addChrome only accepts {trackFullscreen, affectsStruts}; input
             * region coverage is on by default for tracked chrome actors. */
            Main.layoutManager.addChrome(this);
            /* Center on the primary monitor. */
            const monitor = Main.layoutManager.primaryMonitor;
            if (monitor) {
                this.set_position(
                    Math.round(monitor.x + (monitor.width - LOG_WINDOW_W) / 2),
                    Math.round(monitor.y + (monitor.height - LOG_WINDOW_H) / 2));
            }

            this.show();

            this.connect('destroy', () => this._onDestroy());
            this._refresh();
            this._tickId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, LOG_TAIL_MS, () => {
                this._refresh();
                return GLib.SOURCE_CONTINUE;
            });
        }

        _buildChrome() {
            /* Title bar — also the drag handle for moving the window. It must
             * be reactive to receive button-press/motion/release events. */
            const header = new St.BoxLayout({
                style_class: 'aiproxy-log-header',
                x_expand: true,
                reactive: true,
            });
            this._title = new St.Label({
                text: 'ai-proxy log',
                style_class: 'aiproxy-log-title',
                x_expand: true,
                y_align: Clutter.ActorAlign.CENTER,
            });
            header.add_child(this._title);

            this._pauseBtn = this._toolbarButton('media-playback-pause-symbolic',
                () => this._togglePause());
            this._clearBtn = this._toolbarButton('edit-clear-all-symbolic',
                () => this._clearLog());
            this._autoscrollBtn = this._toolbarButton('go-bottom-symbolic',
                () => { this._autoScroll = true; this._scrollToEnd(); });
            this._closeBtn = this._toolbarButton('window-close-symbolic',
                () => this.close());
            header.add_child(this._pauseBtn);
            header.add_child(this._clearBtn);
            header.add_child(this._autoscrollBtn);
            header.add_child(this._closeBtn);
            this._wireDrag(header);
            this.add_child(header);

            /* Scrollable log body. St.ScrollView's child must implement the
             * StScrollable interface — St.Label does not, so wrap the label in
             * an St.BoxLayout (which does) and use that as the scroll child. */
            this._body = new St.Label({
                style_class: 'aiproxy-log-body',
                text: '',
                x_expand: true,
                y_align: Clutter.ActorAlign.FILL,
            });
            /* Wrap doesn't suit logs; clip long lines instead. */
            this._body.clutter_text.line_wrap = false;
            this._body.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
            this._body.clutter_text.selectable = true;
            this._body.clutter_text.editable = false;

            const bodyBox = new St.BoxLayout({
                vertical: true,
                x_expand: true,
                y_expand: true,
            });
            bodyBox.add_child(this._body);

            const scroll = new St.ScrollView({
                style_class: 'aiproxy-log-scroll',
                x_expand: true,
                y_expand: true,
                child: bodyBox,
            });
            this._scroll = scroll;
            this._scrollPolicyId = scroll.connect('scroll-event', () => {
                /* If the user scrolls away from the bottom, stop auto-scrolling. */
                const vadj = scroll.vadjustment;
                const atBottom = vadj.value + vadj.page_size >= vadj.upper - 4;
                this._autoScroll = atBottom;
                return Clutter.EVENT_PROPAGATE;
            });
            this.add_child(scroll);

            /* Footer */
            this._footer = new St.Label({
                text: '',
                style_class: 'aiproxy-log-footer',
                x_expand: true,
            });
            this.add_child(this._footer);

            this._updatePauseIcon();
        }

        /* ── Window dragging ──
         *
         * The header is the drag handle. On button-press we record the offset
         * between the pointer and the window origin; on motion we move the
         * window to keep that offset constant. A stage grab captures motion
         * events even when the pointer leaves the header. */
        _wireDrag(handle) {
            this._dragging = false;
            this._dragOffset = [0, 0];
            this._dragGrab = null;

            handle.connect('button-press-event', (actor, event) => {
                /* Only start a drag on left-button presses that land on the
                 * header itself or the title label — not on toolbar buttons,
                 * which need to receive their own clicks. */
                if (event.get_button() !== 1) return Clutter.EVENT_PROPAGATE;
                const src = event.get_source();
                if (src !== handle && src !== this._title) {
                    return Clutter.EVENT_PROPAGATE;
                }
                const [px, py] = event.get_coords();
                const [wx, wy] = this.get_transformed_position();
                this._dragOffset = [px - wx, py - wy];
                this._dragging = true;
                this._dragGrab = global.stage.grab(handle);
                return Clutter.EVENT_STOP;
            });

            handle.connect('motion-event', (actor, event) => {
                if (!this._dragging) return Clutter.EVENT_PROPAGATE;
                const [px, py] = event.get_coords();
                this.set_position(
                    Math.round(px - this._dragOffset[0]),
                    Math.round(py - this._dragOffset[1]));
                return Clutter.EVENT_STOP;
            });

            handle.connect('button-release-event', () => {
                this._endDrag();
                return Clutter.EVENT_STOP;
            });

            /* If the grab is broken (e.g. focus stolen), stop dragging too. */
            handle.connect('touch-event', () => Clutter.EVENT_PROPAGATE);
        }

        _endDrag() {
            this._dragging = false;
            if (this._dragGrab) {
                this._dragGrab.dismiss();
                this._dragGrab = null;
            }
        }

        _toolbarButton(iconName, callback) {
            const btn = new St.Button({
                style_class: 'aiproxy-log-button',
                can_focus: true,
            });
            btn.set_child(new St.Icon({
                icon_name: iconName,
                style_class: 'aiproxy-log-button-icon',
            }));
            btn.connect('clicked', () => { callback(); return Clutter.EVENT_PROPAGATE; });
            return btn;
        }

        _togglePause() {
            this._paused = !this._paused;
            this._updatePauseIcon();
            if (!this._paused) this._refresh();
        }

        _updatePauseIcon() {
            this._pauseBtn.get_child().set_icon_name(
                this._paused ? 'media-playback-start-symbolic' : 'media-playback-pause-symbolic');
            this._pauseBtn.set_style_class_name(
                this._paused ? 'aiproxy-log-button aiproxy-log-button-active' : 'aiproxy-log-button');
        }

        _clearLog() {
            const path = logPath(this._settings);
            try {
                const file = Gio.File.new_for_path(path);
                const empty = imports.byteArray.fromString('');
                file.replace_contents(empty, null, false,
                    Gio.FileCreateFlags.REPLACE_DESTINATION, null);
                this._body.set_text('');
                this._footer.set_text('Log cleared.');
            } catch (e) {
                this._footer.set_text(`Clear failed: ${e}`);
            }
        }

        _refresh() {
            if (this._paused) return;
            const path = logPath(this._settings);
            const { lines, exists, error } = readLogTail(path, LOG_MAX_LINES);
            if (error) {
                this._footer.set_text(`Error: ${error}`);
                return;
            }
            if (!exists) {
                this._body.set_text(`(log file does not exist yet: ${path})`);
                this._footer.set_text('Waiting for ai-proxy to write logs…');
                return;
            }
            this._body.set_text(lines.join('\n'));
            this._footer.set_text(
                `${lines.length} line${lines.length === 1 ? '' : 's'} · ${path}`);
            if (this._autoScroll) this._scrollToEnd();
        }

        _scrollToEnd() {
            const vadj = this._scroll.vadjustment;
            vadj.set_value(vadj.upper - vadj.page_size);
        }

        show() {
            this.visible = true;
            if (this._autoScroll) this._scrollToEnd();
        }

        close() {
            this.emit('closed');
            this.destroy();
        }

        _onDestroy() {
            if (this._tickId) {
                GLib.source_remove(this._tickId);
                this._tickId = 0;
            }
            if (this._scrollPolicyId) {
                this._scroll.disconnect(this._scrollPolicyId);
                this._scrollPolicyId = 0;
            }
            this._endDrag();
        }
    }
);

const Indicator = GObject.registerClass(
    { GTypeName: 'AiProxyControlIndicator' },
    class Indicator extends PanelMenu.Button {
        _init(ext) {
            super._init(0.0, 'AI Proxy Control');
            this._ext = ext;
            this._settings = ext.getSettings();

            this._pids = [];               // currently-detected ai-proxy PIDs
            this._binaryMissing = false;   // cached: binary not found
            this._pollId = 0;
            this._restartPending = false;
            this._logWindow = null;        // live-tail window (singleton)

            /* ── Panel icon, recolored by running state ── */
            this._panelIcon = new St.Icon({
                icon_name: 'network-server-symbolic',
                style_class: 'aiproxy-panel-icon',
            });
            this.add_child(this._panelIcon);

            this._buildMenu();
            this._refreshNow();

            this._pollId = GLib.timeout_add_seconds(
                GLib.PRIORITY_DEFAULT, POLL_INTERVAL_SEC, () => {
                    this._refreshNow();
                    return GLib.SOURCE_CONTINUE;
                });
        }

        /* ── Menu layout ── */
        _buildMenu() {
            /* Status row: colored dot + status label + port subtitle. */
            const statusRow = new St.BoxLayout({
                style_class: 'aiproxy-status-row',
                x_expand: true,
            });
            this._statusDot = makeDot(COLOR_MUTED);
            statusRow.add_child(this._statusDot);

            const labelBox = new St.BoxLayout({ vertical: true, x_expand: true });
            this._statusLabel = new St.Label({
                text: 'ai-proxy: Checking…',
                style_class: 'aiproxy-status-title',
                x_expand: true,
                y_align: Clutter.ActorAlign.CENTER,
            });
            this._statusSubtitle = new St.Label({
                text: '',
                style_class: 'aiproxy-status-subtitle',
                x_expand: true,
            });
            labelBox.add_child(this._statusLabel);
            labelBox.add_child(this._statusSubtitle);
            statusRow.add_child(labelBox);
            this.menu.box.add_child(statusRow);

            this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

            /* Start / Stop / Restart actions. */
            this._startItem = this._actionItem('Start', 'media-playback-start-symbolic',
                () => this._start());
            this._stopItem = this._actionItem('Stop', 'media-playback-stop-symbolic',
                () => this._stop());
            this._restartItem = this._actionItem('Restart', 'view-refresh-symbolic',
                () => this._restart());
            this.menu.addMenuItem(this._startItem);
            this.menu.addMenuItem(this._stopItem);
            this.menu.addMenuItem(this._restartItem);

            this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

            /* Auxiliary actions. */
            this._openItem = this._actionItem('Open in Browser', 'web-browser-symbolic',
                () => this._openInBrowser());
            this._logsItem = this._actionItem('View Logs', 'folder-documents-symbolic',
                () => this._viewLogs());
            this._prefsItem = this._actionItem('Preferences', 'preferences-system-symbolic',
                () => {
                    this._ext.openPreferences();
                    this.menu.close();
                });
            this.menu.addMenuItem(this._openItem);
            this.menu.addMenuItem(this._logsItem);
            this.menu.addMenuItem(this._prefsItem);
        }

        _actionItem(label, iconName, callback) {
            const item = new PopupMenu.PopupMenuItem(label);
            const icon = new St.Icon({
                icon_name: iconName,
                style_class: 'aiproxy-menu-icon',
            });
            /* PopupMenuItem is a horizontal St.BoxLayout with children in the
             * order [ornament, label]. Insert the icon at index 1 so it lands
             * to the left of the label. */
            item.insert_child_at_index(icon, 1);
            item._aiproxyIcon = icon;
            item.connect('activate', () => callback());
            return item;
        }

        /* ── State detection ── */

        _refreshNow() {
            const pids = detectPids();
            this._pids = pids;

            /* Cache binary presence so the menu can surface a clear error
             * rather than a silent no-op on Start. */
            this._binaryMissing = !resolveBinary();

            this._applyState();
        }

        _applyState() {
            const running = this._pids.length > 0;
            const port = this._settings.get_string('port') || '8080';

            if (running) {
                this._panelIcon.set_style(`color: ${COLOR_GREEN};`);
                this._statusDot.set_style(`color: ${COLOR_GREEN};`);
                const pidStr = this._pids.length === 1
                    ? `PID ${this._pids[0]}`
                    : `${this._pids.length} processes`;
                this._statusLabel.set_text(`ai-proxy: Running (${pidStr})`);
                this._statusSubtitle.set_text(`Port ${port}`);
            } else if (this._binaryMissing) {
                this._panelIcon.set_style(`color: ${COLOR_RED};`);
                this._statusDot.set_style(`color: ${COLOR_RED};`);
                this._statusLabel.set_text('ai-proxy: Not installed');
                this._statusSubtitle.set_text('Binary not found on $PATH');
            } else {
                this._panelIcon.set_style(`color: ${COLOR_MUTED};`);
                this._statusDot.set_style(`color: ${COLOR_MUTED};`);
                this._statusLabel.set_text('ai-proxy: Stopped');
                this._statusSubtitle.set_text(`Port ${port}`);
            }

            /* Toggle action availability based on current state. Start is only
             * valid when stopped and the binary exists; Stop/Restart only when
             * running. */
            this._startItem.setSensitive(!running && !this._binaryMissing);
            this._stopItem.setSensitive(running);
            this._restartItem.setSensitive(running && !this._binaryMissing);
        }

        /* ── Actions ── */

        /* Build the launch argv from settings. Returns the full argv array
         * (binary first). */
        _buildArgv() {
            const bin = resolveBinary();
            const argv = [bin];
            const port = this._settings.get_string('port');
            if (port) argv.push('-port', port);
            const size = this._settings.get_int('conversation-store-size');
            if (size > 0) argv.push('-conversation-store-size', String(size));
            const ttl = this._settings.get_string('conversation-store-ttl');
            if (ttl) argv.push('-conversation-store-ttl', ttl);
            const extra = this._settings.get_string('extra-args');
            if (extra) {
                /* Split the user-supplied extra args shell-style so quoted
                 * values are preserved. */
                try {
                    argv.push(...GLib.shell_parse_argv(extra)[1]);
                } catch (e) {
                    log(`ai-proxy-control: ignoring unparseable extra-args: ${e}`);
                }
            }
            return argv;
        }

        _start() {
            if (this._pids.length > 0) return;       // already running
            const bin = resolveBinary();
            if (!bin) {
                this._binaryMissing = true;
                this._applyState();
                return;
            }

            const argv = this._buildArgv();

            /* Ensure the log directory exists so the redirect target is valid. */
            try { GLib.mkdir_with_parents(dataDir(), 0o755); } catch (e) { /* ignore */ }

            /* Spawn via /bin/sh so the binary's stdout+stderr append to the
             * log file. `exec` makes ai-proxy replace the shell, so its PID
             * is the one pgrep reports — and the one a later Stop targets. */
            const logFile = logPath(this._settings);
            const argvQuoted = argv.map(a => GLib.shell_quote(a)).join(' ');
            const cmd = `exec ${argvQuoted} >> ${GLib.shell_quote(logFile)} 2>&1`;
            const launcher = ['sh', '-c', cmd];

            try {
                const [pid] = GLib.spawn_async(null, launcher, null,
                    GLib.SpawnFlags.SEARCH_PATH_FROM_ENVP | GLib.SpawnFlags.DO_NOT_REAP_CHILD,
                    null);

                /* Reap the child to avoid zombies. We don't track it long-term
                 * because pgrep is the source of truth for liveness. */
                GLib.child_watch_add(GLib.PRIORITY_DEFAULT, pid, () => {
                    GLib.spawn_close_pid(pid);
                });
            } catch (e) {
                log(`ai-proxy-control: failed to start: ${e}`);
                this._refreshNow();
                return;
            }

            /* Give the process a moment to register, then re-probe. */
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, START_SETTLE_MS, () => {
                this._refreshNow();
                return GLib.SOURCE_REMOVE;
            });
        }

        _stop() {
            if (this._pids.length === 0) return;
            /* pkill -x matches the exact process name, terminating every
             * ai-proxy instance. SIGTERM lets the server shut down cleanly. */
            try {
                GLib.spawn_async(null, ['pkill', '-x', PROCESS_NAME], null,
                    GLib.SpawnFlags.SEARCH_PATH, null);
            } catch (e) {
                log(`ai-proxy-control: pkill failed: ${e}`);
            }
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, START_SETTLE_MS, () => {
                this._refreshNow();
                return GLib.SOURCE_REMOVE;
            });
        }

        _restart() {
            if (this._pids.length === 0) return;
            this._restartPending = true;
            this._stop();
            /* Wait for the stop to take effect before relaunching. */
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, RESTART_GAP_MS, () => {
                this._restartPending = false;
                this._refreshNow();
                if (this._pids.length === 0) this._start();
                return GLib.SOURCE_REMOVE;
            });
        }

        _openInBrowser() {
            const port = this._settings.get_string('port') || '8080';
            const url = `http://localhost:${port}`;
            try {
                Gio.AppInfo.launch_default_for_uri(url, null);
            } catch (e) {
                log(`ai-proxy-control: failed to open browser: ${e}`);
            }
        }

        _viewLogs() {
            /* Open the live-tail viewer window instead of launching an
             * external editor. A toggle: if already open, focus it. */
            this._showLogWindow();
        }

        _showLogWindow() {
            if (this._logWindow) {
                this._logWindow.show();
                return;
            }
            this._logWindow = new LogViewerWindow(this._settings);
            this._logWindow.connect('closed', () => {
                this._logWindow = null;
            });
            this._logWindow.show();
        }

        destroy() {
            if (this._pollId) {
                GLib.source_remove(this._pollId);
                this._pollId = 0;
            }
            if (this._logWindow) {
                this._logWindow.destroy();
                this._logWindow = null;
            }
            super.destroy();
        }
    }
);

export default class AiProxyControlExtension extends Extension {
    enable() {
        this._indicator = new Indicator(this);
        Main.panel.addToStatusArea(this.uuid, this._indicator, 1, 'right');

        /* Optional auto-start: launch ai-proxy if it isn't already running.
                 * Give the indicator a brief moment to settle its first probe. */
        if (this._indicator._settings.get_boolean('auto-start')) {
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1500, () => {
                if (this._indicator && this._indicator._pids.length === 0) {
                    this._indicator._start();
                }
                return GLib.SOURCE_REMOVE;
            });
        }
    }

    disable() {
        /* Note: we intentionally do NOT stop ai-proxy here. The server is a
         * general resource that may outlive this extension's lifecycle. */
        if (this._indicator) {
            this._indicator.destroy();
            this._indicator = null;
        }
    }
}
