# ai-proxy-control

A GNOME Shell extension that adds a top-bar indicator to **start, stop, and monitor the [ai-proxy](https://z.ai) server**, with a built-in live log viewer.

The panel icon recolors by state — **green** = running, **gray** = stopped, **red** = binary not found — and the dropdown menu shows live status (PID + port), start/stop/restart actions, a live-tail log window, and a link to open the proxy in your browser.

![status: indicator + dropdown](https://img.shields.io/badge/shell--version-45%20%E2%80%93%2050-blue)

## Features

- **Top-bar indicator** (`network-server-symbolic`), recolored by running state.
- **Live status detection** via `pgrep -x ai-proxy` (polled every 3 s). The indicator reflects whatever ai-proxy instance is currently running — even one started outside this extension.
- **Start / Stop / Restart** menu actions, auto-enabled/disabled by state.
- **Live log viewer** — a floating window that tails the ai-proxy log file (last 1000 lines, monospace, selectable), with pause/resume, clear, and smart autoscroll (scroll up to inspect, jump back down to resume following).
- **Configurable log path** — pick any file via the native file picker in Preferences, or fall back to the default `~/.local/share/ai-proxy-control/ai-proxy.log`.
- **Open in Browser** — launches `http://localhost:<port>`.
- **Preferences** (GSettings-backed): port, conversation store size & TTL, extra arguments, auto-start on enable, and log file path.

## Requirements

- GNOME Shell **45–50**
- `glib-compile-schemas` (for install)
- The `ai-proxy` binary on `$PATH` (or at `~/.local/bin/ai-proxy`)

## Install

```bash
./install.sh
gnome-extensions enable ai-proxy-control@ahati
```

Then reload GNOME Shell:
- **Wayland** — log out and back in.
- **X11** — `Alt+F2` → `r` → Enter.

## Configure

Open Preferences (from the indicator menu, or `gnome-extensions prefs ai-proxy-control@ahati`):

| Setting | Default | Maps to |
|---|---|---|
| Port | `8080` | `-port` |
| Conversation store size | `100` | `-conversation-store-size` |
| Conversation store TTL | `24h` | `-conversation-store-ttl` |
| Extra arguments | *(none)* | appended to the launch command |
| Log file | `~/.local/share/ai-proxy-control/ai-proxy.log` | append target for stdout+stderr |
| Auto-start on enable | off | start ai-proxy when the extension loads |

> Changing the log path only affects **newly started** ai-proxy processes (the redirect target is fixed at launch). Restart ai-proxy from the menu after changing it.

## How it works

- **Start** resolves the `ai-proxy` binary from `$PATH`, builds the argv from your settings, and spawns it detached via `sh -c 'exec ... >> logfile 2>&1'` so stdout/stderr append to the log file and the tracked PID is ai-proxy's own (matching `pgrep`).
- **Stop** runs `pkill -x ai-proxy` (SIGTERM → clean shutdown).
- **Status** polls `pgrep -x ai-proxy` every 3 seconds.
- Disabling the extension does **not** stop a running ai-proxy.

## Files

| File | Purpose |
|---|---|
| `extension.js` | Panel indicator, menu, start/stop/restart, live log viewer window |
| `prefs.js` | Preferences (Adwaita) — server + logging + behavior |
| `stylesheet.css` | Panel icon, menu, and log viewer styling |
| `schemas/*.gschema.xml` | GSettings schema source |
| `metadata.json` | GNOME Shell extension metadata |

## License

MIT — see [LICENSE](LICENSE).
