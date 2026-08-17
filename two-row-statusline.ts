import { basename } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { calculateTokensPerSecond } from "@oh-my-pi/pi-coding-agent/utils/token-rate";
import { getSessionAccentAnsi, getSessionAccentHex } from "@oh-my-pi/pi-coding-agent/utils/session-color";
import { CustomEditor } from "@oh-my-pi/pi-coding-agent/modes/components/custom-editor";
import { truncateToWidth, visibleWidth } from "@oh-my-pi/pi-tui";

type StatusTheme = ExtensionContext["ui"]["theme"];

const WIDGET_KEY = "omp-two-row-statusline";
const STATUS_REFRESH_KEY = `${WIDGET_KEY}:refresh`;
const BLACK_BG = "\x1b[48;2;0;0;0m";
const FG_RESET = "\x1b[39m";
const RESET = "\x1b[0m";
const ROW_EDGE_PADDING = 1;
const STATUSLINE_ROWS = 2;
const borderlessEditors = new WeakSet<object>();

type StatuslineRows = (width: number) => readonly string[];

/**
 * OMP sizes the built-in bordered editor, whose max-height includes two rows
 * of border chrome. Render the two statusline rows inside this same component
 * and reserve those rows from the borderless editor's content.
 */
class TwoRowStatuslineEditor extends CustomEditor {
	#renderStatusline: StatuslineRows;

	constructor(tui: unknown, theme: unknown, keybindings: unknown, renderStatusline: StatuslineRows) {
		super(tui, theme, keybindings);
		this.#renderStatusline = renderStatusline;
	}

	override setMaxHeight(maxHeight: number | undefined): void {
		super.setMaxHeight(maxHeight === undefined ? undefined : Math.max(1, maxHeight - STATUSLINE_ROWS));
	}

	override render(width: number): readonly string[] {
		return [...this.#renderStatusline(width), ...super.render(width)];
	}
}

function installBorderlessEditor(pi: ExtensionAPI, ctx: ExtensionContext): void {
	if (!ctx.hasUI || ctx.mode !== "tui" || borderlessEditors.has(ctx)) return;
	borderlessEditors.add(ctx);
	ctx.ui.setEditorComponent((_tui, theme, keybindings) => {
		const editor = new TwoRowStatuslineEditor(_tui, theme, keybindings, width => {
			const statusTheme = ctx.ui.theme;
			return [renderTopRow(ctx, statusTheme, width), renderBottomRow(pi, ctx, statusTheme, width)];
		});
		editor.setBorderVisible(false);
		return editor;
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
	usedPercent: number;
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
			const fraction = limit.amount?.usedFraction;
			if (typeof fraction !== "number" || !Number.isFinite(fraction)) continue;
			const window = usageWindowLabel(limit.scope?.windowId, limit.window?.durationMs);
			const resetsAt = limit.window?.resetsAt;
			candidates.push({
				priority: usageWindowPriority(window),
				usage: {
					window,
					resetsAt: typeof resetsAt === "number" && Number.isFinite(resetsAt) ? resetsAt : undefined,
					usedPercent: Math.max(0, Math.min(100, fraction * 100)),
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
		`${formatResetCountdown(usage.resetsAt)} ${Math.round(usage.usedPercent)}%`,
	);
}

function requestStatuslineRender(ctx: ExtensionContext): void {
	// Clearing a private hook key is row-free but still asks the TUI to repaint
	// the editor, whose render owns both statusline rows.
	ctx.ui.setStatus(STATUS_REFRESH_KEY, undefined);
}

function refreshSubscriptionUsage(ctx: ExtensionContext): void {
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
	if (usageRefreshTimers.has(ctx)) return;
	usageRefreshTimers.add(ctx);
	ctx.setInterval(() => {
		const state = getUsageState(ctx);
		if (state.usage) requestStatuslineRender(ctx);
		refreshSubscriptionUsage(ctx);
	}, 60_000);
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

function projectLabel(ctx: ExtensionContext, theme: StatusTheme): string {
	const cwd = ctx.cwd || ctx.sessionManager.getCwd();
	const project = cleanText(basename(cwd || "project")) || "project";
	const accentHex = getSessionAccentHex(
		project,
		theme.getMajorThemeColorHexes(),
		theme.accentSurfaceLuminance,
	);
	const accentAnsi = getSessionAccentAnsi(accentHex) ?? theme.getFgAnsi("accent");
	return `${accentAnsi}${accentHex}${FG_RESET} ${theme.fg("text", project)}`;
}

function renderTopRow(ctx: ExtensionContext, theme: StatusTheme, width: number): string {
	const running = ctx.getAsyncJobSnapshot()?.running ?? [];
	const tasks = running.filter(job => job.type === "task").length;
	const jobs = running.filter(job => job.type === "bash").length;
	const icon = theme.icon.agents ? `${theme.icon.agents} ` : "";
	const right = theme.fg("statusLineSubagents", `${icon}${tasks} tasks ${theme.sep.dot} ${jobs} jobs`);
	return renderBlackRow(projectLabel(ctx, theme), right, width);
}

function renderModel(pi: ExtensionAPI, theme: StatusTheme, ctx: ExtensionContext): string {
	const model = cleanText(ctx.model?.name || ctx.model?.id || "no-model");
	const level = pi.getThinkingLevel();
	let thinking = "";
	if (level) {
		const display = level === "off" ? `${theme.status.disabled} off` : (theme.thinking[level] ?? level);
		thinking = ` ${theme.sep.dot}${display}`;
	}
	return theme.fg("statusLineModel", `${theme.icon.model} ${model}${thinking}`);

}
function renderPath(ctx: ExtensionContext, theme: StatusTheme): string {
	const cwd = cleanText(ctx.cwd || ctx.sessionManager.getCwd());
	const label = cwd.length > 34 ? `…${cwd.slice(-33)}` : cwd;
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

function renderThroughput(ctx: ExtensionContext, theme: StatusTheme): string {
	const messages = ctx.sessionManager
		.getEntries()
		.filter(entry => entry.type === "message")
		.map(entry => entry.message);
	const rate = calculateTokensPerSecond(messages, !ctx.isIdle());
	if (!rate) return "";
	return theme.fg("statusLineOutput", `${theme.icon.throughput} ${rate.toFixed(1)} tok/s`);
}

function renderBottomRow(pi: ExtensionAPI, ctx: ExtensionContext, theme: StatusTheme, width: number): string {
	const left = [renderModel(pi, theme, ctx), renderPath(ctx, theme)].filter(Boolean).join("  ");
	const right = [renderContext(ctx, theme), renderSubscriptionUsage(ctx, theme), renderThroughput(ctx, theme)]
		.filter(Boolean)
		.join("  ");
	return renderBlackRow(left, right, width);
}

export default function twoRowStatusline(pi: ExtensionAPI): void {
	const refresh = (_event: unknown, ctx: ExtensionContext): void => {
		installBorderlessEditor(pi, ctx);
		scheduleSubscriptionUsageRefresh(ctx);
		refreshSubscriptionUsage(ctx);
	};

	pi.on("session_start", refresh);
	pi.on("session_switch", refresh);
	pi.on("session_branch", refresh);
	pi.on("session_tree", refresh);
	pi.on("agent_start", refresh);
	pi.on("agent_end", refresh);
	pi.on("tool_execution_start", refresh);
	pi.on("tool_execution_end", refresh);

	pi.on("session_shutdown", (_event, ctx) => {
		if (ctx.hasUI) {
			ctx.ui.setStatus(STATUS_REFRESH_KEY, undefined);
			ctx.ui.setWidget(WIDGET_KEY, undefined);
			ctx.ui.setEditorComponent(undefined);
		}
	});
}
