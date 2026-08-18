# OMP Two-Row Statusline

A small [Oh My Pi](https://github.com/can1357/oh-my-pi) extension that replaces the default TUI footer with a two-row statusline above the editor.

It is a single TypeScript extension module. OMP loads it directly; no build step is required.

## What it shows

The statusline uses the active OMP theme and adapts to the terminal width.

### Top row

- The current session title, with the session accent color.
- Counts of running task and bash jobs.

### Bottom row

- The active model and thinking level.
- The current working directory, shortened when it is too long.
- Context usage as a percentage and formatted token count.
- Subscription usage and reset countdown when the provider exposes usage data.
- Current output throughput in tokens per second.

The top editor border is replaced by the two statusline rows; the bottom border remains as the editor's trailing edge.

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

## How it works

The extension registers the widget during session, agent, and tool lifecycle events. The widget is placed `aboveEditor` and renders two full-width rows using the current theme.

Subscription usage is optional:

- Usage reports are fetched only when the active provider exposes `fetchUsageReports`.
- Reports are matched to the active OAuth account when account identity is available.
- The most relevant available window is preferred in this order: `5h`, `1d`, `7d`, `30d`, then any other window.
- Results are cached for five minutes and refreshed in the background approximately once per minute.
- A report request has a two-second timeout; unavailable usage data is omitted from the statusline.

The widget is removed and the custom editor is restored on `session_shutdown`.

## Requirements

- Oh My Pi with TUI support.
- A provider/model supported by the active OMP session.
- A terminal that supports ANSI true-color escape sequences for the intended appearance.

The source imports OMP's bundled extension and TUI APIs:

```ts
@oh-my-pi/pi-coding-agent
@oh-my-pi/pi-tui
```

It is intended to run inside OMP, not as a standalone Node.js script.

## Repository layout

```text
two-row-statusline.ts  # Extension entry point
README.md              # This file
```

## Troubleshooting

- **Nothing appears:** confirm the file is under `~/.omp/agent/extensions`, `.omp/extensions`, or an `extensions` setting, then restart OMP or run `/reload`.
- **Only one row appears or content is clipped:** widen the terminal; both rows are width-aware and truncate their content to fit.
- **Subscription usage is missing:** the provider may not expose usage reports, the account may not match a report, or the request may have timed out. The rest of the statusline remains available.
- **The editor border is still visible:** the extension only changes the editor in TUI mode and only while the extension is loaded.
