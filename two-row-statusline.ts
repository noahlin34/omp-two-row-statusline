import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { calculateTokensPerSecond } from "@oh-my-pi/pi-coding-agent/utils/token-rate";
import { getSessionAccentAnsi, getSessionAccentHex } from "@oh-my-pi/pi-coding-agent/utils/session-color";
import { formatDuration } from "@oh-my-pi/pi-utils";
import {
	sliceWithWidth,
	truncateToWidth,
	visibleWidth,
	type ComposerStyle,
} from "@oh-my-pi/pi-tui";

type StatusTheme = ExtensionContext["ui"]["theme"];

function isInteractiveTui(ctx: ExtensionContext): boolean {
	return ctx.hasUI && ctx.mode === "tui";
}

const STATUS_REFRESH_KEY = "omp-two-row-statusline:refresh";
const BLACK_BG = "\x1b[48;2;0;0;0m";
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
	sessionKey: string;
	fetchedAt: number;
	inFlight: boolean;
	usage?: SubscriptionUsage;
};

const usageStates = new WeakMap<object, UsageState>();
const usageRefreshTimers = new WeakSet<object>();
const USAGE_CACHE_MS = 5 * 60_000;

const activeMeters = new WeakMap<object, ActiveMeter>();
const meterTickTimers = new WeakSet<object>();

type ActiveMeter = {
	activeMs: number;
	activeStartedAt: number | null;
};

type ThroughputMessage = Parameters<typeof calculateTokensPerSecond>[0][number];

type ThroughputState = {
	messages: readonly ThroughputMessage[];
};

const EMPTY_THROUGHPUT_MESSAGES: readonly ThroughputMessage[] = [];
const throughputStates = new WeakMap<object, ThroughputState>();

function getThroughputState(ctx: ExtensionContext): ThroughputState {
	let state = throughputStates.get(ctx.sessionManager);
	if (!state) {
		state = { messages: EMPTY_THROUGHPUT_MESSAGES };
		throughputStates.set(ctx.sessionManager, state);
	}
	return state;
}

function isAssistantThroughputMessage(value: unknown): value is ThroughputMessage {
	return typeof value === "object" && value !== null && "role" in value && value.role === "assistant";
}

function findLatestAssistantMessage(ctx: ExtensionContext): ThroughputMessage | undefined {
	const entries = ctx.sessionManager.getEntries();
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (!entry || entry.type !== "message" || !isAssistantThroughputMessage(entry.message)) continue;
		return entry.message;
	}
	return undefined;
}

function refreshThroughputFromEntries(ctx: ExtensionContext): void {
	const message = findLatestAssistantMessage(ctx);
	getThroughputState(ctx).messages = message ? [message] : EMPTY_THROUGHPUT_MESSAGES;
}

function updateThroughputFromMessage(ctx: ExtensionContext, message: unknown): void {
	if (!isAssistantThroughputMessage(message)) return;
	getThroughputState(ctx).messages = [message];
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
	let state = usageStates.get(ctx);
	if (!state) {
		state = { sessionKey: "", fetchedAt: 0, inFlight: false };
		usageStates.set(ctx, state);
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
	const reportOrg = normalizeIdentityValue(metadata.orgId);
	if (activeOrg || reportOrg) {
		if (activeOrg !== reportOrg) return false;
	}

	const matches = [

		[identity.accountId, metadata.accountId ?? metadata.account_id ?? scope.accountId],
		[identity.email, metadata.email],
		[identity.projectId, metadata.projectId ?? scope.projectId],
	].some(([active, reported]) => {
		const normalizedActive = normalizeIdentityValue(active);
		return normalizedActive !== undefined && normalizedActive === normalizeIdentityValue(reported);
	});

	return matches || Boolean(activeOrg && !identity.accountId && !identity.email && !identity.projectId);
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
			const window = usageWindowLabel(limit.scope?.windowId, limit.window?.durationMs);
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

function refreshSubscriptionUsage(ctx: ExtensionContext): void {
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
	if (state.sessionKey !== sessionKey) {
		state.sessionKey = sessionKey;
		state.fetchedAt = 0;
		state.usage = undefined;
	}
	if (!provider || state.inFlight || Date.now() - state.fetchedAt < USAGE_CACHE_MS) return;

	const authStorage = ctx.modelRegistry.authStorage;
	const fetcher = authStorage.fetchUsageReports;
	if (typeof fetcher !== "function") return;
	state.inFlight = true;
	void fetcher
		.call(authStorage, {
			baseUrlResolver: (providerName: string) => ctx.modelRegistry.getProviderBaseUrl(providerName),
			signal: AbortSignal.timeout(2_000),
		})
		.then(reports => {
			state.usage = selectSubscriptionUsage(reports, ctx);
			state.fetchedAt = Date.now();
			requestStatuslineRender(ctx);
		})
		.catch(() => {
			state.fetchedAt = Date.now();
		})
		.finally(() => {
			state.inFlight = false;
		});
}
function scheduleSubscriptionUsageRefresh(ctx: ExtensionContext): void {
	if (!isInteractiveTui(ctx)) return;
	if (usageRefreshTimers.has(ctx)) return;
	usageRefreshTimers.add(ctx);
	ctx.setInterval(() => {
		const state = getUsageState(ctx);
		if (state.usage) requestStatuslineRender(ctx);
		refreshSubscriptionUsage(ctx);
	}, 60_000);
}

function scheduleMeterTick(ctx: ExtensionContext): void {
	if (meterTickTimers.has(ctx)) return;
	meterTickTimers.add(ctx);
	// Live tick for the elapsed-time segment: 1s cadence while the agent runs;
	// the render itself is skipped when the meter is idle.
	ctx.setInterval(() => {
		if (getActiveMeter(ctx).activeStartedAt !== null) requestStatuslineRender(ctx);
	}, 1_000);
}


function renderBlackRow(left: string, right: string, width: number): string {
	const edgePadding = Math.min(ROW_EDGE_PADDING, Math.floor(width / 2));
	const innerWidth = Math.max(0, width - edgePadding * 2);
	let content = right
		? `${left}${" ".repeat(Math.max(1, innerWidth - visibleWidth(left) - visibleWidth(right)))}${right}`
		: left;
	content = truncateToWidth(content, innerWidth);
	const trailingPadding = Math.max(0, innerWidth - visibleWidth(content));
	return `${BLACK_BG}${" ".repeat(edgePadding)}${content}${" ".repeat(trailingPadding + edgePadding)}${RESET}`;
}

function sessionTitleLabel(ctx: ExtensionContext, theme: StatusTheme): string {
	const title = cleanText(ctx.sessionManager.getSessionName() ?? "");
	if (!title) return "";
	const accentHex = getSessionAccentHex(title, theme.sessionAccentInputs);
	const accentAnsi = getSessionAccentAnsi(accentHex) ?? theme.getFgAnsi("accent");
	return `${accentAnsi}${accentHex}${FG_RESET} ${theme.fg("text", title)}`;
}

function renderThroughput(ctx: ExtensionContext, theme: StatusTheme): string {
	const rate = calculateTokensPerSecond(getThroughputState(ctx).messages, !ctx.isIdle());
	if (!rate) return "";
	return theme.fg("statusLineOutput", `${theme.icon.throughput} ${rate.toFixed(1)} tok/s`);
}
function renderTopRow(ctx: ExtensionContext, theme: StatusTheme, width: number): string {
	const running = ctx.getAsyncJobSnapshot()?.running ?? [];
	const tasks = running.filter(job => job.type === "task").length;
	const jobs = running.filter(job => job.type === "bash").length;
	const icon = theme.icon.agents ? `${theme.icon.agents} ` : "";
	const right = [
		theme.fg("success", `${icon}${tasks} tasks ${theme.sep.dot} ${jobs} jobs`),
		renderThroughput(ctx, theme),
	]
		.filter(Boolean)
		.join("  ");
	return renderBlackRow(sessionTitleLabel(ctx, theme), right, width);
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
	return theme.fg(
		"statusLineContext",
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
	return renderBlackRow(left, right, width);
}

export default function twoRowStatusline(pi: ExtensionAPI): void {
	let activeContext: ExtensionContext | undefined;
	registerStatuslineComposer(pi, () => activeContext);

	const refresh = (_event: unknown, ctx: ExtensionContext): void => {
		if (!isInteractiveTui(ctx)) return;
		activeContext = ctx;
		refreshThroughputFromEntries(ctx);
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

	const refreshThroughput = (event: { message: unknown }, ctx: ExtensionContext): void => {
		if (!isInteractiveTui(ctx)) return;
		activeContext = ctx;
		updateThroughputFromMessage(ctx, event.message);
	};

	pi.on("message_start", refreshThroughput);
	pi.on("message_update", refreshThroughput);
	pi.on("message_end", refreshThroughput);

	pi.on("agent_start", (_event, ctx) => {
		if (!isInteractiveTui(ctx)) return;
		markActivityStart(ctx);
		requestStatuslineRender(ctx);
	});
	pi.on("agent_end", (_event, ctx) => {
		if (!isInteractiveTui(ctx)) return;
		markActivityEnd(ctx);
		requestStatuslineRender(ctx);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		if (activeContext === ctx) activeContext = undefined;
		if (isInteractiveTui(ctx)) {
			ctx.ui.setStatus(STATUS_REFRESH_KEY, undefined);
		}
	});
}
