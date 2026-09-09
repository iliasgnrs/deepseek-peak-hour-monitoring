import * as vscode from 'vscode';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TimeWindow {
    /** start minute of UTC day (0..1439) */
    startMin: number;
    /** end minute of UTC day (0..1439, exclusive) */
    endMin: number;
}

interface Boundary {
    when: Date; // exact boundary instant (UTC)
    /** true -> entering peak; false -> leaving peak (going off-peak) */
    type: 'start' | 'end';
}

interface Cfg {
    enabled: boolean;
    windows: TimeWindow[];
    weekdays: number[]; // 0 = Sunday .. 6 = Saturday
    notifyOnChange: boolean;
    notifyMinutesBefore: number;
}

// ---------------------------------------------------------------------------
// Parsing / defaults
// ---------------------------------------------------------------------------

const DEFAULT_WINDOWS = ['01:00-04:00', '06:00-10:00'];
const DEFAULT_WEEKDAYS = [1, 2, 3, 4, 5]; // Mon - Fri

function parseMinute(s: string): number {
    const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
    if (!m) {
        throw new Error(`Μη έγκυρη ώρα "${s}" (θέλουμε μορφή HH:MM)`);
    }
    const h = Number(m[1]);
    const min = Number(m[2]);
    if (h > 23 || min > 59) {
        throw new Error(`Μη έγκυρη ώρα "${s}"`);
    }
    return h * 60 + min;
}

function parseWindows(list: string[]): TimeWindow[] {
    if (!Array.isArray(list) || list.length === 0) {
        return [];
    }
    return list.map((w) => {
        const parts = w.split('-');
        if (parts.length !== 2) {
            throw new Error(`Μη έγκυρο παράθυρο "${w}" (θέλουμε "HH:MM-HH:MM")`);
        }
        const start = parseMinute(parts[0]);
        const end = parseMinute(parts[1]);
        if (end <= start) {
            throw new Error(`Το παράθυρο "${w}" πρέπει να τελειώνει μετά την έναρξη (εντός ίδιας ημέρας UTC)`);
        }
        return { startMin: start, endMin: end };
    });
}

// ---------------------------------------------------------------------------
// Peak-hour math (all in UTC)
// ---------------------------------------------------------------------------

/** Minutes since start of the UTC day for a date. */
function minutesOfUtcDay(d: Date): number {
    return d.getUTCHours() * 60 + d.getUTCMinutes() + d.getUTCSeconds() / 60;
}

/** Whether `now` is currently inside a peak window. */
function isInPeak(now: Date, cfg: Cfg): boolean {
    if (!cfg.weekdays.includes(now.getUTCDay())) {
        return false;
    }
    const tod = minutesOfUtcDay(now);
    return cfg.windows.some((w) => tod >= w.startMin && tod < w.endMin);
}

/**
 * Finds the next status transition (window start or end) after `now`.
 * Scans up to 7 days ahead across the configured weekdays.
 */
function nextBoundary(now: Date, cfg: Cfg): Boundary | undefined {
    const todayUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    const msNow = now.getTime();

    // Build candidate boundaries for each configured weekday and window.
    const candidates: { weekday: number; minute: number; type: 'start' | 'end' }[] = [];
    for (const wd of cfg.weekdays) {
        for (const w of cfg.windows) {
            candidates.push({ weekday: wd, minute: w.startMin, type: 'start' });
            candidates.push({ weekday: wd, minute: w.endMin, type: 'end' });
        }
    }

    let best: Boundary | undefined;
    for (let offset = 0; offset <= 7; offset++) {
        const base = new Date(todayUtc + offset * 86400000);
        for (const c of candidates) {
            const dayMs = Date.UTC(
                base.getUTCFullYear(),
                base.getUTCMonth(),
                base.getUTCDate() + c.weekday - base.getUTCDay()
            );
            const cand = new Date(dayMs + c.minute * 60000);
            if (cand.getTime() > msNow && (!best || cand.getTime() < best.when.getTime())) {
                best = { when: cand, type: c.type };
            }
        }
    }
    return best;
}

/** Local-time string (HH:MM) for a Date, using the machine's timezone. */
function localHhmm(d: Date): string {
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/** Human friendly remaining duration, e.g. "σε ~2 ώρες" / "σε ~15 λεπτά". */
function formatRemaining(ms: number): string {
    const totalMin = Math.max(0, Math.round(ms / 60000));
    if (totalMin < 1) {
        return 'τώρα';
    }
    if (totalMin < 60) {
        return `σε ~${totalMin} λεπτά`;
    }
    const h = Math.floor(totalMin / 60);
    const m = totalMin % 60;
    if (m === 0) {
        return `σε ~${h} ώρες`;
    }
    return `σε ~${h} ώρες ${m} λεπτά`;
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

let statusBar: vscode.StatusBarItem;
let timer: NodeJS.Timeout | undefined;
let cfg: Cfg = { enabled: true, windows: [], weekdays: [], notifyOnChange: true, notifyMinutesBefore: 10 };
let lastInPeak: boolean | undefined;
let lastWarnedBoundaryMs = 0;

function readConfig(): void {
    const conf = vscode.workspace.getConfiguration('deepseekPeak');
    const windowsRaw = conf.get<string[]>('windowsUtc', DEFAULT_WINDOWS);
    const weekdays = conf.get<number[]>('weekdays', DEFAULT_WEEKDAYS);
    cfg = {
        enabled: conf.get<boolean>('enabled', true),
        windows: parseWindows(windowsRaw),
        weekdays,
        notifyOnChange: conf.get<boolean>('notifyOnChange', true),
        notifyMinutesBefore: conf.get<number>('notifyMinutesBefore', 10),
    };
}

function describeTransition(b: Boundary): string {
    return b.type === 'start'
        ? `Το επόμενο peak ξεκινά ${localHhmm(b.when)} τοπική ώρα (${formatRemaining(b.when.getTime() - Date.now())}).`
        : `Το peak τελειώνει ${localHhmm(b.when)} τοπική ώρα (${formatRemaining(b.when.getTime() - Date.now())}).`;
}

function updateStatusBar(now: Date): void {
    if (!cfg.enabled || cfg.windows.length === 0) {
        statusBar.hide();
        return;
    }

    const inPeak = isInPeak(now, cfg);
    const boundary = nextBoundary(now, cfg);

    if (inPeak) {
        const endsAt = boundary && boundary.type === 'end' ? boundary.when : now;
        const remaining = endsAt.getTime() - now.getTime();
        statusBar.text = `$(flame) Peak · τέλος ${localHhmm(endsAt)} (${formatRemaining(remaining)})`;
        statusBar.color = new vscode.ThemeColor('charts.red');
        statusBar.tooltip = `ΕΙΣΤΕ ΕΝΤΟΣ DeepSeek peak hours (ακριβότερη/περιορισμένη χρήση).\n${boundary ? describeTransition(boundary) : ''}`;
    } else {
        statusBar.text = `$(check) Off-peak`;
        statusBar.color = new vscode.ThemeColor('charts.green');
        statusBar.tooltip = `Είστε ΕΚΤΟΣ DeepSeek peak hours.\n${boundary ? describeTransition(boundary) : 'Κανένα peak σε προγραμματισμό.'}`;
    }

    statusBar.show();
    maybeNotify(now, inPeak, boundary);
}

/** Sends notifications on state change and shortly before transitions. */
function maybeNotify(now: Date, inPeak: boolean, boundary: Boundary | undefined): void {
    const warnMs = cfg.notifyMinutesBefore * 60000;

    // 1) State change notifications.
    if (cfg.notifyOnChange && lastInPeak !== undefined && lastInPeak !== inPeak) {
        if (inPeak) {
            void vscode.window.showInformationMessage(
                `DeepSeek Peak Hours: Μπήκατε σε peak hours (ακριβότερη χρήση). ${boundary ? describeTransition(boundary) : ''}`
            );
        } else {
            void vscode.window.showInformationMessage(
                'DeepSeek Peak Hours: Τελείωσαν τα peak hours — είστε πλέον off-peak. ✓'
            );
        }
    }
    lastInPeak = inPeak;

    // 2) "Almost there" warnings (before a start or end).
    if (!boundary || warnMs <= 0) {
        return;
    }
    const msUntil = boundary.when.getTime() - now.getTime();
    if (msUntil > 0 && msUntil <= warnMs && boundary.when.getTime() !== lastWarnedBoundaryMs) {
        lastWarnedBoundaryMs = boundary.when.getTime();
        const msg =
            boundary.type === 'start'
                ? `Το DeepSeek peak ξεκινά ${formatRemaining(msUntil)} (${localHhmm(boundary.when)} τοπική).`
                : `Το DeepSeek peak τελειώνει ${formatRemaining(msUntil)} (${localHhmm(boundary.when)} τοπική).`;
        void vscode.window.showInformationMessage(`DeepSeek Peak Hours: ${msg}`);
    }
}

function tick(): void {
    try {
        updateStatusBar(new Date());
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        void vscode.window.showErrorMessage(`DeepSeek Peak Hours: ${msg}`);
    }
}

function showStatusNow(): void {
    try {
        const now = new Date();
        const inPeak = isInPeak(now, cfg);
        const boundary = nextBoundary(now, cfg);
        const lines = [
            `Τώρα (τοπική ${now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}): ${inPeak ? 'ΕΝΤΟΣ peak' : 'ΕΚΤΟΣ peak'}`,
            `Τώρα (UTC ${now.toISOString().slice(11, 16)}): ${inPeak ? 'peak' : 'off-peak'}`,
        ];
        if (boundary) {
            lines.push(describeTransition(boundary));
        } else {
            lines.push('Κανένα peak σε προγραμματισμό.');
        }
        void vscode.window.showInformationMessage(lines.join('\n'), { modal: false });
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        void vscode.window.showErrorMessage(`DeepSeek Peak Hours: ${msg}`);
    }
}

function schedule(): void {
    if (timer) {
        clearInterval(timer);
    }
    // Refresh every 15 s so the countdown stays reasonably fresh.
    timer = setInterval(tick, 15000);
}

export function activate(context: vscode.ExtensionContext): void {
    statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    statusBar.command = 'deepseekPeak.showStatus';
    context.subscriptions.push(statusBar);

    readConfig();
    schedule();
    tick();

    context.subscriptions.push(
        vscode.commands.registerCommand('deepseekPeak.showStatus', showStatusNow),
        vscode.commands.registerCommand('deepseekPeak.openSettings', () => {
            void vscode.commands.executeCommand(
                'workbench.action.openSettings',
                '@ext:iliasgnrs.deepseek-peak-hour-monitoring'
            );
        }),
        vscode.workspace.onDidChangeConfiguration((e) => {
            if (e.affectsConfiguration('deepseekPeak')) {
                readConfig();
                // Reset warn dedupe when config changes.
                lastWarnedBoundaryMs = 0;
                tick();
            }
        })
    );
}

export function deactivate(): void {
    if (timer) {
        clearInterval(timer);
    }
}
