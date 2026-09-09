import * as https from 'https';
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
    monitorStatus: boolean;
    statusFeedUrl: string;
    statusCheckIntervalMinutes: number;
    notifyOnStatusIncident: boolean;
}

// ---------------------------------------------------------------------------
// Parsing / defaults
// ---------------------------------------------------------------------------

const DEFAULT_WINDOWS = ['01:00-04:00', '06:00-10:00'];
const DEFAULT_WEEKDAYS = [1, 2, 3, 4, 5]; // Mon - Fri
const DEFAULT_STATUS_FEED = 'https://status.deepseek.com/feed.rss';

function parseMinute(s: string): number {
    const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
    if (!m) {
        throw new Error(`Invalid time "${s}" (expected HH:MM format)`);
    }
    const h = Number(m[1]);
    const min = Number(m[2]);
    if (h > 23 || min > 59) {
        throw new Error(`Invalid time "${s}"`);
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
            throw new Error(`Invalid window "${w}" (expected "HH:MM-HH:MM")`);
        }
        const start = parseMinute(parts[0]);
        const end = parseMinute(parts[1]);
        if (end <= start) {
            throw new Error(`The window "${w}" must end after it starts (within the same UTC day)`);
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

/** Human friendly remaining duration, e.g. "in ~2 hours" / "in ~15 minutes". */
function formatRemaining(ms: number): string {
    const totalMin = Math.max(0, Math.round(ms / 60000));
    if (totalMin < 1) {
        return 'now';
    }
    if (totalMin < 60) {
        return `in ~${totalMin} minutes`;
    }
    const h = Math.floor(totalMin / 60);
    const m = totalMin % 60;
    if (m === 0) {
        return `in ~${h} hours`;
    }
    return `in ~${h} hours ${m} minutes`;
}

// ---------------------------------------------------------------------------
// DeepSeek status monitoring (status.deepseek.com RSS/Atom feed)
// ---------------------------------------------------------------------------

interface FeedIncident {
    id: string;
    title: string;
    link: string;
    pubDate: string;
    status: string;
}

/** GET a URL over HTTPS and return the body as text. */
function httpGetText(url: string, timeoutMs = 15000): Promise<string> {
    return new Promise((resolve, reject) => {
        const target = new URL(url);
        const req = https.get(
            target,
            { headers: { 'User-Agent': 'DeepSeekPeakHourMonitoring/0.0.1 (VS Code extension)' } },
            (res) => {
                const code = res.statusCode ?? 0;
                const loc = res.headers.location;
                if (code >= 300 && code < 400 && loc) {
                    res.resume();
                    resolve(httpGetText(new URL(loc, target).toString(), timeoutMs));
                    return;
                }
                if (code !== 200) {
                    res.resume();
                    reject(new Error(`HTTP ${code}`));
                    return;
                }
                const chunks: Buffer[] = [];
                res.on('data', (c: Buffer) => chunks.push(c));
                res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
            }
        );
        req.on('error', reject);
        req.setTimeout(timeoutMs, () => req.destroy(new Error('request timed out')));
    });
}

/** Decode common XML/HTML entities. */
function unescapeXml(s: string): string {
    return s
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&apos;/g, "'")
        .replace(/&#x([0-9a-fA-F]+);/g, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
        .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
        .replace(/&amp;/g, '&');
}

/** Strip HTML tags, collapsing whitespace. */
function stripHtml(s: string): string {
    return s
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

/** Parse an RSS 2.0 or Atom feed into its incidents/entries. */
function parseFeed(xml: string): FeedIncident[] {
    const isAtom = /<feed\b/i.test(xml);
    const itemRe = isAtom ? /<entry\b[^>]*>([\s\S]*?)<\/entry>/gi : /<item\b[^>]*>([\s\S]*?)<\/item>/gi;
    const out: FeedIncident[] = [];
    const field = (block: string, tag: string): string => {
        const m = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i').exec(block);
        return m ? unescapeXml(m[1]) : '';
    };
    let m: RegExpExecArray | null;
    while ((m = itemRe.exec(xml))) {
        const block = m[1];
        const id = field(block, isAtom ? 'id' : 'guid');
        const title = field(block, 'title');
        const hrefM = /<link\b[^>]*href="([^"]*)"/i.exec(block);
        const innerM = /<link\b[^>]*>([\s\S]*?)<\/link>/i.exec(block);
        const link = unescapeXml(hrefM ? hrefM[1] : innerM ? innerM[1] : '');
        const pubDate = field(block, isAtom ? 'updated' : 'pubDate');
        const desc = field(block, isAtom ? 'summary' : 'description');
        const text = stripHtml(desc);
        const st = /status\s*:\s*([a-z_]+)/i.exec(text);
        const status = st ? st[1].toLowerCase() : '';
        out.push({ id, title, link, pubDate, status });
    }
    return out;
}

/** Whether a feed entry's status means an incident is still ongoing. */
function isActiveIncident(inc: FeedIncident): boolean {
    const t = inc.status;
    if (!t) {
        return false;
    }
    if (/resolved|operational|completed/.test(t)) {
        return false; // all clear
    }
    if (/maintenance|scheduled/.test(t)) {
        return false; // planned, not an outage
    }
    return true; // investigating / identified / monitoring / degraded / outage ...
}

function describeStatusFeed(inc: FeedIncident): string {
    return `[${inc.status}] ${inc.title}`;
}

/** Whether an incident status is severe (major outage / unavailable / ...). */
function isSevereStatus(s: string): boolean {
    return /major|partial_outage|full_outage|outage|unavailable|critical|severe|\bdown\b/i.test(s);
}

/**
 * Overall health derived from the currently active incidents.
 * green = all good; medium = some issue; serious = major outage/unavailable.
 */
type Health = 'green' | 'medium' | 'serious';

function overallHealth(active: FeedIncident[]): Health {
    if (active.length === 0) {
        return 'green';
    }
    if (active.some((i) => isSevereStatus(i.status))) {
        return 'serious';
    }
    return 'medium';
}

let feedStatusBar: vscode.StatusBarItem;
let statusTimer: NodeJS.Timeout | undefined;
let knownActive = new Map<string, FeedIncident>();
let lastActiveList: FeedIncident[] = [];
let statusFeedSeen = false;
let lastStatusError = '';

function showStatusFeedNow(): void {
    const lines =
        lastActiveList.length > 0
            ? lastActiveList.map((i) => `• ${describeStatusFeed(i)}\n  ${i.link}`)
            : ['No active incidents — DeepSeek systems are reported operational.'];
    void vscode.window.showInformationMessage('DeepSeek Status: ' + lines.join('\n'), { modal: false });
}

async function checkStatusFeed(): Promise<void> {
    if (!cfg.monitorStatus) {
        feedStatusBar.hide();
        return;
    }
    const url = (cfg.statusFeedUrl || '').trim() || DEFAULT_STATUS_FEED;
    let incidents: FeedIncident[];
    try {
        const xml = await httpGetText(url);
        incidents = parseFeed(xml);
        lastStatusError = '';
    } catch (err) {
        feedStatusBar.hide();
        const msg = err instanceof Error ? err.message : String(err);
        if (msg !== lastStatusError) {
            lastStatusError = msg;
            void vscode.window.showWarningMessage(`DeepSeek Status: could not reach the status feed (${url}). ${msg}`);
        }
        return;
    }

    // Keep only currently-active incidents.
    const active = new Map<string, FeedIncident>();
    for (const inc of incidents) {
        if (inc.id && isActiveIncident(inc)) {
            active.set(inc.id, inc);
        }
    }
    lastActiveList = [...active.values()];

    // Diff against what we knew before.
    const newlyActive: FeedIncident[] = [];
    for (const id of active.keys()) {
        if (!knownActive.has(id)) {
            newlyActive.push(active.get(id)!);
        }
    }
    const newlyResolved: FeedIncident[] = [];
    for (const inc of knownActive.values()) {
        if (!active.has(inc.id)) {
            newlyResolved.push(inc);
        }
    }
    knownActive = new Map(active);

    // Status-bar indicator (always shown while monitoring is on), colour-coded
    // by overall health: green = normal, orange = medium issue, red = serious.
    const health = overallHealth(lastActiveList);
    if (health === 'green') {
        feedStatusBar.text = '$(check) Normal operation';
        feedStatusBar.color = new vscode.ThemeColor('charts.green');
        feedStatusBar.tooltip = 'DeepSeek systems are reported operational (normal operation).';
    } else {
        feedStatusBar.text =
            health === 'serious'
                ? `$(error) Serious issue (${active.size})`
                : `$(warning) Medium issue (${active.size})`;
        feedStatusBar.color = new vscode.ThemeColor(health === 'serious' ? 'charts.red' : 'charts.orange');
        feedStatusBar.tooltip =
            `Active DeepSeek status incident(s):\n` +
            lastActiveList.map((i) => `• ${describeStatusFeed(i)}`).join('\n') +
            '\n\nClick for details.';
    }
    feedStatusBar.show();

    if (!cfg.notifyOnStatusIncident) {
        return;
    }

    // First poll that already sees an active incident -> single heads-up.
    if (!statusFeedSeen && active.size > 0) {
        const first = lastActiveList[0];
        void vscode.window.showWarningMessage(
            `DeepSeek Status: There is an ongoing issue — ${first.title} (${first.status}). ${first.link}`
        );
    }

    for (const inc of newlyActive) {
        void vscode.window.showWarningMessage(
            `DeepSeek Status: New issue — ${inc.title} (${inc.status}). ${inc.link}`
        );
    }
    for (const inc of newlyResolved) {
        void vscode.window.showInformationMessage(
            `DeepSeek Status: Resolved ✓ — ${inc.title} (${inc.link})`
        );
    }
    statusFeedSeen = true;
}

function scheduleStatus(): void {
    if (statusTimer) {
        clearInterval(statusTimer);
        statusTimer = undefined;
    }
    if (!cfg.monitorStatus) {
        return;
    }
    const intervalMs = Math.max(1, Math.floor(cfg.statusCheckIntervalMinutes || 5)) * 60000;
    statusTimer = setInterval(() => {
        void checkStatusFeed();
    }, intervalMs);
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

let statusBar: vscode.StatusBarItem;
let timer: NodeJS.Timeout | undefined;
let cfg: Cfg = {
    enabled: true,
    windows: [],
    weekdays: [],
    notifyOnChange: true,
    notifyMinutesBefore: 10,
    monitorStatus: true,
    statusFeedUrl: DEFAULT_STATUS_FEED,
    statusCheckIntervalMinutes: 5,
    notifyOnStatusIncident: true,
};
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
        monitorStatus: conf.get<boolean>('monitorStatus', true),
        statusFeedUrl: conf.get<string>('statusFeedUrl', DEFAULT_STATUS_FEED),
        statusCheckIntervalMinutes: conf.get<number>('statusCheckIntervalMinutes', 5),
        notifyOnStatusIncident: conf.get<boolean>('notifyOnStatusIncident', true),
    };
}

function describeTransition(b: Boundary): string {
    return b.type === 'start'
        ? `The next peak starts at ${localHhmm(b.when)} local time (${formatRemaining(b.when.getTime() - Date.now())}).`
        : `The peak ends at ${localHhmm(b.when)} local time (${formatRemaining(b.when.getTime() - Date.now())}).`;
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
        statusBar.text = `$(flame) Peak · ends ${localHhmm(endsAt)} (${formatRemaining(remaining)})`;
        statusBar.color = new vscode.ThemeColor('charts.red');
        statusBar.tooltip = `You are INSIDE DeepSeek peak hours (more expensive/limited usage).\n${boundary ? describeTransition(boundary) : ''}`;
    } else {
        statusBar.text = `$(check) Off-peak`;
        statusBar.color = new vscode.ThemeColor('charts.green');
        statusBar.tooltip = `You are OUTSIDE DeepSeek peak hours.\n${boundary ? describeTransition(boundary) : 'No peak scheduled.'}`;
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
                `DeepSeek Peak Hours: You have entered peak hours (more expensive usage). ${boundary ? describeTransition(boundary) : ''}`
            );
        } else {
            void vscode.window.showInformationMessage(
                'DeepSeek Peak Hours: Peak hours have ended — you are now off-peak. ✓'
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
                ? `The DeepSeek peak starts ${formatRemaining(msUntil)} (${localHhmm(boundary.when)} local).`
                : `The DeepSeek peak ends ${formatRemaining(msUntil)} (${localHhmm(boundary.when)} local).`;
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
            `Now (local ${now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}): ${inPeak ? 'INSIDE peak' : 'OUTSIDE peak'}`,
            `Now (UTC ${now.toISOString().slice(11, 16)}): ${inPeak ? 'peak' : 'off-peak'}`,
        ];
        if (boundary) {
            lines.push(describeTransition(boundary));
        } else {
            lines.push('No peak scheduled.');
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

    feedStatusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99);
    feedStatusBar.command = 'deepseekPeak.showStatusFeed';
    context.subscriptions.push(feedStatusBar);

    readConfig();
    schedule();
    tick();
    scheduleStatus();
    void checkStatusFeed();

    context.subscriptions.push(
        vscode.commands.registerCommand('deepseekPeak.showStatus', showStatusNow),
        vscode.commands.registerCommand('deepseekPeak.showStatusFeed', showStatusFeedNow),
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
                scheduleStatus();
                const statusSettingsChanged = [
                    'monitorStatus',
                    'statusFeedUrl',
                    'statusCheckIntervalMinutes',
                    'notifyOnStatusIncident',
                ].some((k) => e.affectsConfiguration(`deepseekPeak.${k}`));
                if (statusSettingsChanged) {
                    void checkStatusFeed();
                }
            }
        })
    );
}

export function deactivate(): void {
    if (timer) {
        clearInterval(timer);
    }
    if (statusTimer) {
        clearInterval(statusTimer);
    }
}
