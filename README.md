# DeepSeek Peak Hour Monitoring

A VS Code extension that shows you **in the status bar** whether you are **inside or outside
DeepSeek peak hours** and **when the current peak ends**, based on your computer's clock
(classification is always done in **UTC**, as DeepSeek defines it).

It also **watches the DeepSeek status page** and notifies you as soon as there is an active
incident (degraded performance, outage, etc.), so you know when the systems are not
working well.

> **What DeepSeek peak hours are** (default): Monday–Friday, **01:00–04:00** and
> **06:00–10:00 UTC**. At all other times you are **off-peak**.

## Features

- 🟢/🔴 **Status bar** indicator: `Off-peak` or `Peak · ends 04:00 (in ~45 min)`.
- ⏱️ **Countdown** for when the current peak ends (or when the next one starts).
- 🔔 **Notifications** when the status changes and **shortly before** the change.
- 🛠️ **Fully configurable** schedule (windows, days, notifications).
- 🚨 **Status monitoring** (`status.deepseek.com`): a red `DeepSeek issue (n)` indicator and
  a notification when DeepSeek reports an active incident.

## Installation

### From the GitHub Release (recommended)

Download the pre-built `deepseek-peak-hour-monitoring.vsix` from the
[latest GitHub Release](https://github.com/iliasgnrs/deepseek-peak-hour-monitoring/releases/latest)
and install it from the command line:

```bash
code --install-extension deepseek-peak-hour-monitoring.vsix
```

or from within VS Code: open the **Extensions** view (`Ctrl+Shift+X`), click the
`...` menu and choose **Install from VSIX...**, then select the downloaded file.

Installing this way makes the extension available **globally, in all of your
workspaces**.

### Development / local

1. Open the project folder in VS Code.
2. Install dependencies and compile:
   ```bash
   npm install
   npm run compile
   ```
3. Press **F5** (or Run → Start Debugging) to open an
   *Extension Development Host* with the extension loaded.

You will see the indicator on the left side of the status bar. Clicking it opens a
window with detailed status (local time + UTC + when it changes).

## Settings

Open the settings (`Ctrl+,`) and search for `deepseekPeak` (or use the
**DeepSeek Peak Hours: Settings** command from the Command Palette).

| Setting | Type | Default | Description |
|---|---|---|---|
| `deepseekPeak.enabled` | boolean | `true` | Show/hide the status bar indicator |
| `deepseekPeak.windowsUtc` | string[] | `["01:00-04:00", "06:00-10:00"]` | Peak windows in **UTC**, format `"HH:MM-HH:MM"` |
| `deepseekPeak.weekdays` | number[] | `[1,2,3,4,5]` | Weekdays (0=Sun … 6=Sat) |
| `deepseekPeak.notifyOnChange` | boolean | `true` | Notify when the status changes |
| `deepseekPeak.notifyMinutesBefore` | number | `10` | Minutes before the change to warn (0=disabled) |
| `deepseekPeak.monitorStatus` | boolean | `true` | Monitor the DeepSeek status feed for incidents |
| `deepseekPeak.statusFeedUrl` | string | `https://status.deepseek.com/feed.rss` | RSS/Atom status feed URL (feed.rss or feed.atom) |
| `deepseekPeak.statusCheckIntervalMinutes` | number | `5` | How often (minutes) to check the status feed |
| `deepseekPeak.notifyOnStatusIncident` | boolean | `true` | Notify when a status incident starts or is resolved |

### Status monitoring

While VS Code is running, the extension polls the DeepSeek status feed every
`statusCheckIntervalMinutes` minutes. Whenever the feed shows an incident that is **not
resolved** (e.g. `investigating`, `identified`, `monitoring`, `degraded`, `outage`), you
get:

- a red **`$(error) DeepSeek issue (n)`** indicator in the status bar (click it to see the
details and links), and
- a **notification** when the incident starts, and another when it is resolved.

When DeepSeek reports **no active incident**, the status bar stays clean and nothing is
shown.

### Example: changing the schedule

For example, if your peaks are 02:00–05:00 and 09:00–12:00 UTC, Sat-Sun:

```json
{
  "deepseekPeak.windowsUtc": ["02:00-05:00", "09:00-12:00"],
  "deepseekPeak.weekdays": [0, 6]
}
```

## How "computer time" works

The extension uses your computer's clock, but **classification is done in UTC** — so it
holds true wherever you are. The times it shows you (e.g. "ends 04:00") are converted to
your **local timezone** for convenience.

## Structure

```
├── package.json      # metadata, commands, settings
├── tsconfig.json
├── src/extension.ts  # all the logic (peak math, status monitoring, notifications)
└── .vscode/          # debug (F5) + build task
```

## License

MIT
