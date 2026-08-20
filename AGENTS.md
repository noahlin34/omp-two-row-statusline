# OMP Two-Row Statusline

## Project purpose

This repository contains a single Oh My Pi (OMP) TypeScript extension. Its purpose is to provide a custom two-row statusline around a borderless composer:

```text
session/jobs row
model/context/usage row
composer prompt and cursor
```

The extension is loaded directly by OMP. There is no build step and no generated output. The source entry point is `two-row-statusline.ts`; `README.md` contains user-facing installation and configuration instructions.

## OMP documentation is authoritative

This extension runs inside OMP, not as a standalone Node.js program. When an OMP API, lifecycle event, UI behavior, Composer layout rule, theme API, extension-loading rule, or package type is unclear, consult the internal OMP documentation before relying on memory, inference, or old source patterns.

For agents running inside OMP, read the internal documentation with the `read` tool and an `omp://` URI, for example:

```text
read("omp://extensions.md")
read("omp://extension-loading.md")
read("omp://tui.md")
read("omp://theme.md")
```

Relevant references:

- `omp://extensions.md` — extension lifecycle, `ExtensionAPI`, `ExtensionContext`, and Composer Shape registration.
- `omp://extension-loading.md` — discovery paths, explicit extension loading, reload behavior, and trust rules.
- `omp://tui.md` and `omp://tui-runtime-internals.md` — TUI rendering and layout behavior.
- `omp://theme.md` — theme and color APIs.

The internal OMP documentation and the currently installed OMP package types are authoritative for OMP behavior. This file and the README describe this extension's intended behavior; they do not override OMP's API contract. Do not revive an older integration based on assumptions when the current OMP documentation says otherwise.

## Composer API architecture

The extension intentionally uses OMP's native Composer Shape API:

- `two-row-statusline.ts` imports `ComposerStyle` from `@oh-my-pi/pi-tui`.
- `registerStatuslineComposer(...)` calls `pi.registerComposerShape(...)` during extension initialization.
- The registered shape is named `OMP Two-Row Statusline` and has the stable style id `omp-two-row-statusline`.
- The style uses `sideBorders: false`, `verticalChrome: 2`, `statusAttachment: "none"`, `bottomBar: "none"`, and `bottomBarGap: false`.
- The prompt is borderless with no horizontal side chrome (`defaultPaddingX: () => 0`, `sideChromeWidth: () => 0`) and a default `❯ ` gutter.
- OMP owns the editor lifecycle, input handling, cursor, keybindings, editor sizing, and composer rendering. The extension supplies the custom chrome and status data.

Do **not** replace this with a custom `CustomEditor`, `ctx.ui.setEditorComponent(...)`, manual max-height subtraction, direct editor-border manipulation, or `setThemeInstance(...)` synchronization. Those were part of the old implementation and defeated the purpose of the native Composer API by taking over OMP internals.

### Why `renderRow` carries the second status row

The final layout must put both status rows above the composer. In the current Composer contract, `renderBottom` runs after the cursor/input rows, so it would place the second status row below the composer. The implementation therefore:

1. resets `contentRowIndex` in `renderTop` at the start of each render pass;
2. renders the first status row from `renderTop`;
3. prepends the second status row to the first `renderRow` result; and
4. returns only the normal editor row for later `renderRow` calls.

`renderBottom` intentionally returns `undefined`. Preserve this ordering unless the authoritative OMP Composer contract changes. If it changes, update the implementation and README together and verify the actual TUI placement.

Every normal Composer row must honor the current OMP rendering contract. Preserve the supplied `gutter`, `text`, and `pad`; use visible-width-aware helpers when composing custom rows; and ensure emitted rows fit the requested width. Do not reflow the editor input from the extension.

## Runtime and lifecycle

The factory registers the Composer Shape immediately, then tracks the active `ExtensionContext` from lifecycle events:

- `session_start`
- `session_switch`
- `session_branch`
- `session_tree`
- `agent_start` / `agent_end`
- `tool_execution_start` / `tool_execution_end`

The render callbacks read the active context lazily. They return `undefined` outside an interactive TUI context (`!ctx.hasUI` or `ctx.mode !== "tui"`). Keep this guard so print, RPC, headless, and subagent paths do not attempt terminal rendering.

On `session_shutdown`, clear the active context when it is the current one and clear the extension's status refresh key. Do not unregister the Composer Shape or restore a replaced editor: the shape is registered for the extension lifetime, while its callbacks stop emitting rows when no active TUI context exists.

Subscription usage is optional and asynchronous. Rendering must remain synchronous and cheap. Keep network access, refresh timers, and caching outside render callbacks; usage data should be read from the existing cached state. Use OMP-managed timers and lifecycle cleanup according to `omp://extensions.md` if changing refresh behavior.

## Statusline content

The top row currently contains:

- the session name with its session accent color;
- running task and bash-job counts, right-aligned and styled with the success color.

The second row currently contains:

- model and thinking level;
- shortened current working directory;
- context usage percentage and formatted token count;
- optional provider subscription usage and reset countdown;
- output throughput in tokens per second.

Use the active OMP theme instead of hard-coded theme assumptions. Preserve the existing width-aware truncation and ANSI-safe visible-width handling when changing labels or adding fields.

## Editing guidance

- Prefer small, direct changes in `two-row-statusline.ts`; avoid new abstractions unless the existing rendering contract requires them.
- Use public OMP extension and TUI APIs documented by OMP. Avoid private OMP imports and implementation details.
- Before changing an exported API, event, or Composer contract, inspect all call sites and the corresponding OMP documentation.
- Keep the native shape selectable through **Settings → Appearance → Composer Shape**. Registration does not automatically select the shape; do not silently alter OMP's configured composer.
- If the shape id, label, layout, row ordering, installation flow, or observable status content changes, update `README.md` in the same change.
- Do not add a build pipeline for this one-file extension.
- Do not add mocks, no-op fallbacks, or compatibility shims for obsolete editor APIs.

## Installing and running a local copy

From the repository root, use one of these development workflows.

### One-shot run

Load the working tree without copying it:

```bash
omp --extension ./two-row-statusline.ts
# or
omp -e ./two-row-statusline.ts
```

After OMP starts, select **OMP Two-Row Statusline** in **Settings → Appearance → Composer Shape**. The shape is registered by the extension but is not selected automatically.

### Project-local installation

Install the working tree for the current project:

```bash
mkdir -p .omp/extensions
cp ./two-row-statusline.ts .omp/extensions/two-row-statusline.ts
```

Restart OMP or run `/reload` after changing the copied file, then select the shape in Appearance settings.

### User-wide installation

Install it for every project:

```bash
mkdir -p ~/.omp/agent/extensions
cp ./two-row-statusline.ts ~/.omp/agent/extensions/two-row-statusline.ts
```

Restart OMP or run `/reload`, then select the shape if it is not already configured.

### Explicit configuration

An absolute or configured path can be added to the active OMP configuration:

```yaml
extensions:
  - ~/projects/omp-two-row-statusline/two-row-statusline.ts
```

Follow `omp://extension-loading.md` if discovery, trust, reload, or configuration behavior differs from these examples.

## Verification after changes

There is no project build step. For a meaningful UI change, verify the real OMP surface rather than relying only on static inspection:

1. Launch OMP with the extension using `omp -e ./two-row-statusline.ts`.
2. Select **OMP Two-Row Statusline** under **Settings → Appearance → Composer Shape**.
3. Confirm the two status rows appear above the prompt and cursor, with no editor side borders.
4. Exercise a session/tool transition and confirm the session, job, model, context, and throughput values refresh as applicable.
5. Resize to a narrow terminal and confirm rows remain width-safe and content truncates rather than clips.
6. Confirm non-TUI loading does not fail if that execution mode is relevant to the change.

Use focused checks for changed behavior. Do not claim a UI change is verified from a TypeScript parse or diff alone.
