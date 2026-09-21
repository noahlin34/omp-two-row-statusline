import {
	AgentRegistry,
	type ExtensionAPI,
	type ExtensionContext,
	type MessageEndEvent,
	type MessageStartEvent,
	type MessageUpdateEvent,
} from "@oh-my-pi/pi-coding-agent";
import { TokenRateMeter } from "@oh-my-pi/pi-coding-agent/utils/token-rate";
import { Tokenizer } from "@oh-my-pi/pi-agent-core";
import { formatDuration } from "@oh-my-pi/pi-utils";
import {
	getSessionAccentAnsi,
	getSessionAccentHex,
	sliceWithWidth,
	truncateToWidth,
	visibleWidth,
	type ComposerStyle,
} from "@oh-my-pi/pi-tui";
import {
	getContextUsageLevel,
	getContextUsageThemeColor,
} from "@oh-my-pi/pi-tui/chrome";

type StatusTheme = ExtensionContext["ui"]["theme"];

/** The three message lifecycle events that drive the throughput meter. */
type MessageMeterEvent = MessageStartEvent | MessageUpdateEvent | MessageEndEvent;

function isInteractiveTui(ctx: ExtensionContext): boolean {
	return ctx.hasUI && ctx.mode === "tui";
}

const STATUS_REFRESH_KEY = "omp-two-row-statusline:refresh";
const FG_RESET = "\x1b[39m";
const RESET = "\x1b[0m";
const ROW_EDGE_PADDING = 1;
const MAX_PATH_LABEL_WIDTH = 34;
const PATH_ELLIPSIS = "…";
const PATH_ELLIPSIS_WIDTH = visibleWidth(PATH_ELLIPSIS);

function registerStatuslineComposer(pi: ExtensionAPI, getContext: () => ExtensionContext | undefined): void {
	let contentRowIndex = 0;

	const style: ComposerStyle = {
		id: "omp-two-row-statusline",
		sideBorders: false,
		verticalChrome: 2,
		statusAttachment: "none",
		bottomBar: "none",
		bottomBarGap: false,
		defaultPromptGutter: "❯ ",
		defaultPaddingX: () => 0,
		sideChromeWidth: () => 0,
		renderTop: ({ width }) => {
			contentRowIndex = 0;
			const ctx = getContext();
			if (!ctx || !isInteractiveTui(ctx)) return undefined;
			return renderTopRow(ctx, ctx.ui.theme, width);
		},
		renderRow: ({ width, gutter, text, pad }) => {
			const row = gutter + text + pad;
			if (contentRowIndex++ !== 0) return [row];

			// The second status row must be above the editor. A ComposerStyle's
			// renderBottom callback runs after the cursor row, so emit this row
			// alongside the first content row instead.
			const ctx = getContext();
			if (!ctx || !isInteractiveTui(ctx)) return [row];
			return [renderBottomRow(pi, ctx, ctx.ui.theme, width), row];
		},
		renderBottom: () => undefined,
	};
	pi.registerComposerShape({
		label: "OMP Two-Row Statusline",
		description: "Two status rows above a borderless composer",
		style,
	});
}

function cleanText(value: string): string {
	return value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
}

function formatTokens(value: number): string {
	if (!Number.isFinite(value) || value <= 0) return "0";
	if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
	if (value >= 1_000) return `${Math.round(value / 1_000)}K`;
	return `${Math.round(value)}`;
}
type SubscriptionUsage = {
	window: string;
	resetsAt?: number;
	remainingPercent: number;
};

type UsageLimitLike = {
	id?: unknown;
	scope?: Record<string, unknown>;
	window?: Record<string, unknown>;
	amount?: Record<string, unknown>;
};

type UsageReportLike = {
	provider?: unknown;
	metadata?: Record<string, unknown>;
	limits?: unknown;
};

type UsageState = {
	provider: string;
	sessionKey: string;
	fetchedAt: number;
	inFlight: boolean;
	usage?: SubscriptionUsage;
};

const usageStates = new WeakMap<object, UsageState>();
/** Keyed on `ctx.sessionManager`: stable across OMP's per-dispatch contexts. */
const usageRefreshTimers = new WeakSet<object>();
const USAGE_CACHE_MS = 5 * 60_000;

const activeMeters = new WeakMap<object, ActiveMeter>();
/** Keyed on `ctx.sessionManager`: stable across OMP's per-dispatch contexts. */
const meterTickTimers = new WeakSet<object>();

type ActiveMeter = {
	activeMs: number;
	activeStartedAt: number | null;
};

/**
 * Live generation throughput, using OMP's own {@link TokenRateMeter} — the
 * same meter the built-in status line feeds from streamed deltas. It reports
 * a kernel-weighted rate while a turn streams and keeps the last reading
 * between turns, which the previous whole-message average could not: mid-
 * stream assistant messages carry no `usage.output`/`duration` yet, so that
 * readout stayed blank until each message ended.
 *
 * The meter must be fed from the same events core uses, so the extension
 * mirrors core's `message_start` / `message_update` / `message_end` wiring and
 * seeds it from history after a session swap.
 */
type SessionMeter = {
	meter: TokenRateMeter;
	/**
	 * `model.tokenizer` the meter was built for. A {@link Tokenizer}'s encoding
	 * is derived from exactly this field, so it is a complete and stable
	 * rebuild key — comparing instance identity would rebuild the meter on
	 * every render, discarding the smoothing it exists to provide.
	 */
	encoding: string | null;
};

const sessionMeters = new WeakMap<object, SessionMeter>();

function getSessionMeter(ctx: ExtensionContext): TokenRateMeter {
	const model = ctx.model;
	const encoding = model?.tokenizer ?? null;
	const existing = sessionMeters.get(ctx.sessionManager);
	// The meter's encoding is fixed at construction, so a model switch must
	// rebuild it rather than keep counting with the previous model's tokenizer.
	if (existing && existing.encoding === encoding) return existing.meter;

	const tokenizer = new Tokenizer(model);
	const meter = new TokenRateMeter(text => tokenizer.countTokens(text));
	sessionMeters.set(ctx.sessionManager, { meter, encoding });
	seedMeterFromHistory(ctx, meter);
	return meter;
}

/** Re-seed the meter from the last completed assistant turn after a session swap. */
function seedMeterFromHistory(ctx: ExtensionContext, meter: TokenRateMeter): void {
	const entries = ctx.sessionManager.getEntries();
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry?.type !== "message") continue;
		const message = entry.message;
		if (typeof message !== "object" || message === null || message.role !== "assistant") continue;
		const duration = "duration" in message ? message.duration : undefined;
		const output = "usage" in message ? message.usage?.output : undefined;
		if (typeof duration !== "number" || typeof output !== "number") continue;
		meter.seed(output, duration);
		return;
	}
	meter.reset();
}

/** Mirrors core's per-event meter feeding; see the block comment on `SessionMeter`. */
function feedSessionMeter(ctx: ExtensionContext, event: MessageMeterEvent): void {
	if (event.message.role !== "assistant") return;
	const meter = getSessionMeter(ctx);
	const message = event.message;
	switch (event.type) {
		case "message_start":
			meter.begin(typeof message.timestamp === "number" ? message.timestamp : undefined);
			return;
		case "message_end":
			meter.end(
				message.usage?.output,
				"duration" in message && typeof message.duration === "number"
					? (typeof message.timestamp === "number" ? message.timestamp : Date.now()) + message.duration
					: undefined,
			);
			return;
		case "message_update": {
			const delta = event.assistantMessageEvent;
			if (delta?.type === "text_delta" || delta?.type === "thinking_delta" || delta?.type === "toolcall_delta") {
				meter.push(delta.delta);
			}
		}
	}
}

function getActiveMeter(ctx: ExtensionContext): ActiveMeter {
	let meter = activeMeters.get(ctx.sessionManager);
	if (!meter) {
		meter = { activeMs: 0, activeStartedAt: null };
		activeMeters.set(ctx.sessionManager, meter);
	}
	return meter;
}

function markActivityStart(ctx: ExtensionContext): void {
	const meter = getActiveMeter(ctx);
	if (meter.activeStartedAt !== null) return;
	meter.activeStartedAt = Date.now();
}

function markActivityEnd(ctx: ExtensionContext): void {
	const meter = getActiveMeter(ctx);
	if (meter.activeStartedAt === null) return;
	meter.activeMs += Math.max(0, Date.now() - meter.activeStartedAt);
	meter.activeStartedAt = null;
}


function getActiveMs(ctx: ExtensionContext): number {
	const meter = getActiveMeter(ctx);
	if (meter.activeStartedAt === null) return meter.activeMs;
	return meter.activeMs + Math.max(0, Date.now() - meter.activeStartedAt);
}

function getUsageState(ctx: ExtensionContext): UsageState {
	let state = usageStates.get(ctx.sessionManager);
	if (!state) {
		state = { provider: "", sessionKey: "", fetchedAt: 0, inFlight: false };
		usageStates.set(ctx.sessionManager, state);
	}
	return state;
}

function normalizeIdentityValue(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim().toLowerCase() : undefined;
}

function matchesUsageAccount(
	report: UsageReportLike,
	limit: UsageLimitLike,
	identity: Record<string, unknown> | undefined,
): boolean {
	if (!identity) return true;
	const metadata = report.metadata ?? {};
	const scope = limit.scope ?? {};
	const activeOrg = normalizeIdentityValue(identity.orgId);
	const reportOrg = normalizeIdentityValue(metadata.orgId ?? scope.orgId);
	if (activeOrg || reportOrg) {
		if (activeOrg !== reportOrg) return false;
		if (!identity.accountId && !identity.email && !identity.projectId) return true;
	}

	const activeAccount = normalizeIdentityValue(identity.accountId);
	if (
		activeAccount &&
		[metadata.accountId, metadata.account_id, scope.accountId].some(
			value => normalizeIdentityValue(value) === activeAccount,
		)
	) {
		return true;
	}

	const activeEmail = normalizeIdentityValue(identity.email);
	if (activeEmail && normalizeIdentityValue(metadata.email) === activeEmail) return true;

	const activeProject = normalizeIdentityValue(identity.projectId);
	return Boolean(
		activeProject &&
			[metadata.projectId, scope.projectId].some(value => normalizeIdentityValue(value) === activeProject),
	);
}

function resolveUsageUsedFraction(limit: UsageLimitLike): number | undefined {
	const amount = limit.amount;
	if (!amount) return undefined;
	const usedFraction = amount.usedFraction;
	if (typeof usedFraction === "number" && Number.isFinite(usedFraction)) return usedFraction;
	const used = amount.used;
	const limitValue = amount.limit;
	if (
		typeof used === "number" &&
		Number.isFinite(used) &&
		typeof limitValue === "number" &&
		Number.isFinite(limitValue) &&
		limitValue > 0
	) {
		return used / limitValue;
	}
	if (amount.unit === "percent" && typeof used === "number" && Number.isFinite(used)) return used / 100;
	const remainingFraction = amount.remainingFraction;
	if (typeof remainingFraction === "number" && Number.isFinite(remainingFraction)) {
		return Math.max(0, 1 - remainingFraction);
	}
	return undefined;
}

function usageWindowLabel(windowId: unknown, durationMs: unknown): string {
	if (windowId === "daily" || windowId === "1d") return "1d";
	if (windowId === "monthly" || windowId === "30d") return "30d";
	if (typeof windowId === "string" && windowId) return windowId;
	if (typeof durationMs === "number" && Number.isFinite(durationMs)) {
		const hours = Math.round(durationMs / 3_600_000);
		return hours >= 24 ? `${Math.round(hours / 24)}d` : `${hours}h`;
	}
	return "sub";
}

function usageWindowPriority(window: string): number {
	if (window === "5h") return 0;
	if (window === "1d") return 1;
	if (window === "7d") return 2;
	if (window === "30d") return 3;
	return 4;
}

function selectSubscriptionUsage(reports: unknown, ctx: ExtensionContext): SubscriptionUsage | undefined {
	const provider = ctx.model?.provider;
	if (!provider || !Array.isArray(reports)) return undefined;
	const identity = ctx.modelRegistry.authStorage.getOAuthAccountIdentity(
		provider,
		ctx.sessionManager.getSessionId(),
	) as Record<string, unknown> | undefined;
	const candidates: { priority: number; usage: SubscriptionUsage }[] = [];

	for (const value of reports) {
		if (!value || typeof value !== "object") continue;
		const report = value as UsageReportLike;
		if (report.provider !== provider || !Array.isArray(report.limits)) continue;
		for (const value of report.limits) {
			if (!value || typeof value !== "object") continue;
			const limit = value as UsageLimitLike;
			if (!matchesUsageAccount(report, limit, identity)) continue;
			const fraction = resolveUsageUsedFraction(limit);
			if (typeof fraction !== "number" || !Number.isFinite(fraction)) continue;
			const window = usageWindowLabel(limit.scope?.windowId ?? limit.window?.id, limit.window?.durationMs);
			const resetsAt = limit.window?.resetsAt;
			candidates.push({
				priority: usageWindowPriority(window),
				usage: {
					window,
					resetsAt: typeof resetsAt === "number" && Number.isFinite(resetsAt) ? resetsAt : undefined,
					remainingPercent: Math.max(0, Math.min(100, (1 - fraction) * 100)),
				},
			});
		}
	}

	candidates.sort((a, b) => a.priority - b.priority);
	return candidates[0]?.usage;
}

function formatResetCountdown(resetsAt: number | undefined): string {
	if (resetsAt === undefined) return "reset ?";
	const minutes = Math.max(1, Math.ceil((resetsAt - Date.now()) / 60_000));
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h`;
	const days = Math.floor(hours / 24);
	const remainingHours = hours % 24;
	return remainingHours > 0 ? `${days}d${remainingHours}h` : `${days}d`;
}
function renderSubscriptionUsage(ctx: ExtensionContext, theme: StatusTheme): string {
	const usage = getUsageState(ctx).usage;
	if (!usage) return "";
	return theme.fg(
		"statusLineOutput",
		`${formatResetCountdown(usage.resetsAt)} ${Math.round(usage.remainingPercent)}%`,
	);
}

function requestStatuslineRender(ctx: ExtensionContext): void {
	if (!isInteractiveTui(ctx)) return;
	// Clearing a private hook key is row-free but still asks the TUI to repaint
	// the editor, whose render owns both statusline rows.
	ctx.ui.setStatus(STATUS_REFRESH_KEY, undefined);
}

function refreshSubscriptionUsage(ctx: ExtensionContext, force = false): void {
	if (!isInteractiveTui(ctx)) return;
	const state = getUsageState(ctx);
	const provider = ctx.model?.provider ?? "";
	const sessionId = ctx.sessionManager.getSessionId();
	const identity = provider ? ctx.modelRegistry.authStorage.getOAuthAccountIdentity(provider, sessionId) : undefined;
	const sessionKey = [
		provider,
		sessionId,
		identity?.accountId ?? "",
		identity?.email ?? "",
		identity?.projectId ?? "",
		identity?.orgId ?? "",
	].join("\0");
	if (state.provider !== provider) {
		state.provider = provider;
		state.usage = undefined;
	}
	if (state.sessionKey !== sessionKey) {
		state.sessionKey = sessionKey;
		state.fetchedAt = 0;
	}
	if (!provider || state.inFlight || (!force && Date.now() - state.fetchedAt < USAGE_CACHE_MS)) return;

	const authStorage = ctx.modelRegistry.authStorage;
	const fetcher = authStorage.fetchUsageReports;
	if (typeof fetcher !== "function") return;
	state.inFlight = true;
	const requestedSessionKey = sessionKey;
	void fetcher
		.call(authStorage, {
			baseUrlResolver: (providerName: string) => ctx.modelRegistry.getProviderBaseUrl(providerName),
			signal: AbortSignal.timeout(2_000),
		})
		.then(reports => {
			if (state.sessionKey !== requestedSessionKey) return;
			const usage = selectSubscriptionUsage(reports, ctx);
			if (usage) {
				state.usage = usage;
				state.fetchedAt = Date.now();
			} else {
				state.fetchedAt = 0;
			}
			requestStatuslineRender(ctx);
		})
		.catch(() => {
			// Retry transient provider failures on the minute cadence instead
			// of caching an empty result for the full success interval.
			state.fetchedAt = 0;
		})
		.finally(() => {
			state.inFlight = false;
			if (state.sessionKey !== requestedSessionKey) refreshSubscriptionUsage(ctx, true);
		});
}
function scheduleSubscriptionUsageRefresh(ctx: ExtensionContext): void {
	if (!isInteractiveTui(ctx)) return;
	// Guard on the session manager, not on `ctx`: OMP builds a fresh context
	// per event dispatch, so a `ctx`-keyed guard never matches twice and each
	// refresh event would otherwise stack another pair of intervals.
	if (usageRefreshTimers.has(ctx.sessionManager)) return;
	usageRefreshTimers.add(ctx.sessionManager);
	ctx.setInterval(() => {
		const state = getUsageState(ctx);
		if (state.usage) requestStatuslineRender(ctx);
		refreshSubscriptionUsage(ctx);
	}, 60_000);
}

function scheduleMeterTick(ctx: ExtensionContext): void {
	if (meterTickTimers.has(ctx.sessionManager)) return;
	meterTickTimers.add(ctx.sessionManager);
	// Live tick for the elapsed-time segment: 1s cadence while the agent runs;
	// the render itself is skipped when the meter is idle.
	ctx.setInterval(() => {
		if (getActiveMeter(ctx).activeStartedAt !== null) requestStatuslineRender(ctx);
	}, 1_000);
}


function renderStatusRow(left: string, right: string, width: number, background: string): string {
	const edgePadding = Math.min(ROW_EDGE_PADDING, Math.floor(width / 2));
	const innerWidth = Math.max(0, width - edgePadding * 2);
	const fullRightWidth = visibleWidth(right);
	const rightContent =
		fullRightWidth <= innerWidth
			? right
			: `${PATH_ELLIPSIS}${sliceWithWidth(
					right,
					Math.max(0, fullRightWidth - innerWidth + PATH_ELLIPSIS_WIDTH),
					Math.max(0, innerWidth - PATH_ELLIPSIS_WIDTH),
				).text}`;
	const rightWidth = visibleWidth(rightContent);
	const separatorWidth = rightWidth > 0 && innerWidth > rightWidth ? 1 : 0;
	const leftContent = truncateToWidth(left, Math.max(0, innerWidth - rightWidth - separatorWidth));
	const gapWidth = rightWidth > 0 ? Math.max(separatorWidth, innerWidth - visibleWidth(leftContent) - rightWidth) : 0;
	const content = `${leftContent}${" ".repeat(gapWidth)}${rightContent}`;
	const trailingPadding = Math.max(0, innerWidth - visibleWidth(content));
	return `${background}${" ".repeat(edgePadding)}${content}${" ".repeat(trailingPadding + edgePadding)}${RESET}`;
}

function sessionTitleLabel(ctx: ExtensionContext, theme: StatusTheme): string {
	const title = cleanText(ctx.sessionManager.getSessionName() ?? "");
	if (!title) return "";
	const accentHex = getSessionAccentHex(title, theme.sessionAccentInputs);
	const accentAnsi = getSessionAccentAnsi(accentHex) ?? theme.getFgAnsi("accent");
	return `${accentAnsi}${accentHex}${FG_RESET} ${theme.fg("text", title)}`;
}

function renderThroughput(ctx: ExtensionContext, theme: StatusTheme): string {
	// `rate()` already holds the last reading between turns and returns null
	// until a run has accumulated enough tokens to measure.
	const rate = getSessionMeter(ctx).rate();
	if (rate === null) return "";
	return theme.fg("statusLineOutput", `${theme.icon.throughput} ${rate.toFixed(1)} tok/s`);
}
function renderTopRow(ctx: ExtensionContext, theme: StatusTheme, width: number): string {
	const running = ctx.getAsyncJobSnapshot()?.running ?? [];
	// Counts match core's own background-work readouts: the subagent count is
	// the registry's running `sub` agents, and the job count excludes task jobs
	// owned by those subagents, which that count already covers.
	const runningSubagentIds = new Set(
		AgentRegistry.global()
			.list()
			.filter(entry => entry.kind === "sub" && entry.status === "running")
			.map(entry => entry.id),
	);
	const tasks = runningSubagentIds.size;
	const jobs = running.filter(job => !(job.type === "task" && job.agentId !== undefined && runningSubagentIds.has(job.agentId))).length;
	const icon = theme.icon.agents ? `${theme.icon.agents} ` : "";
	const right = [
		theme.fg("success", `${icon}${tasks} tasks ${theme.sep.dot} ${jobs} jobs`),
		renderThroughput(ctx, theme),
	]
		.filter(Boolean)
		.join("  ");
	return renderStatusRow(sessionTitleLabel(ctx, theme), right, width, theme.getBgAnsi("statusLineBg"));
}

function renderModel(pi: ExtensionAPI, theme: StatusTheme, ctx: ExtensionContext): string {
	const model = cleanText(ctx.model?.name || ctx.model?.id || "no-model");
	const level = pi.getThinkingLevel();
	let thinking = "";
	if (level) {
		const display =
			level === "off"
				? `${theme.status.disabled} off`
				: level === "inherit"
					? level
					: (theme.thinking[level] ?? level);
		thinking = ` ${theme.sep.dot}${display}`;
	}
	return theme.fg("statusLineModel", `${theme.icon.model} ${model}${thinking}`);

}
function renderPath(ctx: ExtensionContext, theme: StatusTheme): string {
	const cwd = cleanText(ctx.cwd || ctx.sessionManager.getCwd());
	const cwdWidth = visibleWidth(cwd);
	let label = cwd;
	if (cwdWidth > MAX_PATH_LABEL_WIDTH) {
		const tailWidth = MAX_PATH_LABEL_WIDTH - PATH_ELLIPSIS_WIDTH;
		const tail = sliceWithWidth(cwd, Math.max(0, cwdWidth - tailWidth), tailWidth).text;
		label = `${PATH_ELLIPSIS}${tail}`;
	}
	return theme.fg("statusLinePath", `${theme.icon.folder} ${label}`);
}

function renderContext(ctx: ExtensionContext, theme: StatusTheme): string {
	const usage = ctx.getContextUsage();
	if (!usage || !Number.isFinite(usage.percent)) return "";
	// Window-scaled thresholds, from OMP's own context-usage helpers, so the
	// percentage turns warning/purple/error at the same points core's
	// `context_pct` segment does.
	const level = getContextUsageLevel(usage.percent, usage.contextWindow);
	// getContextUsageThemeColor returns statusLineContext | warning |
	// thinkingHigh | error.
	return theme.fg(
		getContextUsageThemeColor(level),
		`${theme.icon.context} ${usage.percent.toFixed(1)}%/${formatTokens(usage.contextWindow)}`,
	);
}

function renderTimeSpent(ctx: ExtensionContext, theme: StatusTheme): string {
	const activeMs = getActiveMs(ctx);
	if (activeMs < 1000) return "";
	return `${theme.icon.time} ${formatDuration(activeMs)}`;
}


function renderBottomRow(pi: ExtensionAPI, ctx: ExtensionContext, theme: StatusTheme, width: number): string {
	const left = [renderModel(pi, theme, ctx), renderPath(ctx, theme)].filter(Boolean).join("  ");
	const right = [renderContext(ctx, theme), renderTimeSpent(ctx, theme), renderSubscriptionUsage(ctx, theme)]
		.filter(Boolean)
		.join("  ");
	return renderStatusRow(left, right, width, theme.getBgAnsi("statusLineBg"));
}

export default function twoRowStatusline(pi: ExtensionAPI): void {
	let activeContext: ExtensionContext | undefined;
	registerStatuslineComposer(pi, () => activeContext);

	const refresh = (_event: unknown, ctx: ExtensionContext): void => {
		if (!isInteractiveTui(ctx)) return;
		activeContext = ctx;
		// Rebuild (and re-seed) the meter when the session or model changed
		// underneath this context.
		getSessionMeter(ctx);
		scheduleSubscriptionUsageRefresh(ctx);
		scheduleMeterTick(ctx);
		refreshSubscriptionUsage(ctx);
	};

	pi.on("session_start", refresh);
	pi.on("session_switch", refresh);
	pi.on("session_branch", refresh);
	pi.on("session_tree", refresh);
	pi.on("session_compact", refresh);
	pi.on("agent_start", refresh);
	pi.on("tool_execution_start", refresh);
	pi.on("tool_execution_end", refresh);

	const meterEvent = (event: MessageMeterEvent, ctx: ExtensionContext): void => {
		if (!isInteractiveTui(ctx)) return;
		activeContext = ctx;
		feedSessionMeter(ctx, event);
		requestStatuslineRender(ctx);
	};

	pi.on("message_start", meterEvent);
	pi.on("message_update", meterEvent);
	pi.on("message_end", meterEvent);

	pi.on("agent_start", (_event, ctx) => {
		if (!isInteractiveTui(ctx)) return;
		markActivityStart(ctx);
		requestStatuslineRender(ctx);
	});
	pi.on("agent_end", (_event, ctx) => {
		if (!isInteractiveTui(ctx)) return;
		markActivityEnd(ctx);
		refreshSubscriptionUsage(ctx, true);
		requestStatuslineRender(ctx);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		if (activeContext === ctx) activeContext = undefined;
		if (isInteractiveTui(ctx)) {
			ctx.ui.setStatus(STATUS_REFRESH_KEY, undefined);
		}
	});
}
