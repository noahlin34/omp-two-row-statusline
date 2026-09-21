# OMP Two-Row Statusline

A small [Oh My Pi](https://github.com/can1357/oh-my-pi) extension that registers a native Composer Shape for a unified two-row statusline above the composer.

It is a single TypeScript extension module. OMP loads it directly; no build step is required.

## What it shows

The statusline uses the active OMP theme and adapts to the terminal width.

### Top row

- The current session title, with the session accent color.
- Right-aligned: green counts of running task jobs and background jobs, and the live output throughput in tokens per second, rendered with OMP's own generation meter (`TokenRateMeter`). Both counts use the same predicates as OMP's built-in background-work readouts: a task job owned by a running subagent is counted as a task (matching OMP's running-subagent count) rather than double-counted as a job, and every other running job counts as a job. The rate is smoothed over recent stream time, so it updates while the model streams and holds its last reading between turns. It stays blank until a run has produced enough tokens to measure (OMP's meter requires at least ~200 tokens over ~4s of stream time), which also keeps bursty write-heavy turns from producing a bogus reading.

### Bottom row

- The active model and thinking level.
- The current working directory, shortened when it is too long.
- Context usage as a percentage and formatted token count.
- Elapsed agent-processing time (the same active-time counter as OMP's built-in `time_spent` segment: idle time between turns never accumulates).
- Subscription usage and reset countdown when the provider exposes usage data.

The status rows use the active theme's `statusLineBg` background, so they follow both dark and light themes instead of painting a fixed black band. The context percentage is colored with OMP's own context-usage levels, which are window-scaled: it turns `warning`, `thinkingHigh`, then `error` at the same points core's `context_pct` status segment does. The extension registers OMP's native Composer Shape API: both status rows render above the input, keeping the prompt and caret below the unified statusline. The input itself uses the borderless composer layout; no custom editor or border-removal shim is used.

## Install

OMP auto-discovers TypeScript extensions from the project or user extension directory. Choose one of these installation scopes.

### User-wide

Install it for every project:

```bash
mkdir -p ~/.omp/agent/extensions
cp two-row-statusline.ts ~/.omp/agent/extensions/
```

### One project

Install it only for the current project:

```bash
mkdir -p .omp/extensions
cp two-row-statusline.ts .omp/extensions/
```

Project-local extensions are loaded after the project is trusted.

### Configure an explicit path

Add the file to the active OMP configuration instead of copying it into an auto-discovered directory:

```yaml
# ~/.omp/agent/config.yml
extensions:
  - ~/projects/omp-two-row-statusline/two-row-statusline.ts
```

Relative configured paths resolve from the current project directory.

## Try it once

To load the extension without installing it, pass it explicitly when starting OMP:

```bash
omp --extension ./two-row-statusline.ts
# or
omp -e ./two-row-statusline.ts
```

For an auto-discovered extension, restart OMP or use `/reload` after changing the file.

After loading it, select **OMP Two-Row Statusline** in **Settings → Appearance → Composer Shape**. Composer shapes are registered by extensions but are not selected automatically; OMP otherwise keeps the configured shape (usually `box`).

## How it works

The extension registers the composer shape during extension initialization, then updates the active session context from lifecycle events. OMP owns the editor lifecycle and renders both full-width status rows above the input through the native Composer Style hooks.

Subscription usage is optional:

- Usage reports are fetched only when the active provider exposes `fetchUsageReports`.
- Reports are matched to the active OAuth account when account identity is available.
- The most relevant available window is preferred in this order: `5h`, `1d`, `7d`, `30d`, then any other window.
- Results are cached for five minutes and refreshed in the background approximately once per minute.
- A report request has a two-second timeout; unavailable usage data is omitted from the statusline.

The composer shape remains registered for the extension lifetime; its render callbacks stop emitting status rows when the session shuts down.

## Requirements

- Oh My Pi with TUI support.
- A provider/model supported by the active OMP session.
- A terminal that supports ANSI true-color escape sequences for the intended appearance.

The source imports OMP's bundled extension and TUI APIs:

```ts
@oh-my-pi/pi-coding-agent
@oh-my-pi/pi-coding-agent/utils/token-rate   # TokenRateMeter
@oh-my-pi/pi-agent-core                      # Tokenizer
@oh-my-pi/pi-tui                             # composer style, theme, session accent, width helpers
@oh-my-pi/pi-tui/chrome                      # context-usage level + color
@oh-my-pi/pi-utils

The throughput readout uses OMP's own generation meter: the extension feeds a
`TokenRateMeter` from the same `message_start` / `message_update` / `message_end`
events core uses, tokenizing deltas with the active model's own `Tokenizer`, and
seeds it from history after a session or model switch. OMP 18.2 moved the
terminal UI modules (themes, status line, composer, chat) into `@oh-my-pi/pi-tui`;
the session accent helpers now come from that package's root export rather than
`@oh-my-pi/pi-coding-agent/utils/session-color`, which no longer exists.

It is intended to run inside OMP, not as a standalone Node.js script.

## Repository layout

```text
two-row-statusline.ts  # Extension entry point
README.md              # This file
```

## Troubleshooting

- **Nothing appears:** confirm the file is under `~/.omp/agent/extensions`, `.omp/extensions`, or an `extensions` setting, restart OMP or run `/reload`, then select **OMP Two-Row Statusline** under **Settings → Appearance → Composer Shape**.
- **Only one row appears or content is clipped:** widen the terminal; both rows are width-aware and truncate their content to fit.
- **Subscription usage is missing:** the provider may not expose usage reports, the account may not match a report, or the request may have timed out. The rest of the statusline remains available.
- **The editor border is still visible:** the custom shape is not active; select **OMP Two-Row Statusline** under **Settings → Appearance → Composer Shape**. The extension does not replace OMP's configured composer automatically.
