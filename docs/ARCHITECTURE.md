# Architecture & implementation notes

How the command palette is built, for contributors and the curious. For
installing and using it, see the [README](../README.md).

Built and verified 2026-09-25 against Herdr v0.9.0 (protocol 22) on macOS;
Windows support added 2026-09-29 (Herdr 0.9.0, Windows 11).

## Palette behavior details

### config.json loading

All user settings live in one file, `config.json`, in the plugin's config dir
(`herdr plugin config-dir atd.command-palette`), with a `spaces` list and a
`tabs` list (both optional). It is read fresh on every palette open. An older
`spaces.json` is still read when `config.json` doesn't exist; the first edit
through the palette writes `config.json` (carrying the old spaces over) and
leaves `spaces.json` alone.

- A missing file just hides the config-driven sections.
- An unparseable one shows a single "config.json is invalid" row that
  explains the error when selected.
- A preset path that doesn't exist is reported instead of being sent to Herdr.
- Space presets: `label` defaults to the path's last folder name; `path` may
  start with `~`.
- Add/remove commands write the file and show a confirmation but don't
  refresh the in-memory list; reopen the palette to see the change.
- **Open config.json** runs `$EDITOR` (falls back to `vi`, or `notepad` on
  Windows) in a new tab; **Copy config.json path** uses `pbcopy` (`clip` on
  Windows).

### What each built-in row calls

- **Predefined space**: `workspace.create {cwd, label, focus: true}` — always
  a brand-new workspace, even if one with that label is already open.
- **New `<agent>` tab** (from `tabs`, or the default **New Claude tab**
  running `claude`): for an open space, `tab.create {workspace_id, focus:
  true}` plus `workspace.focus` if that space isn't current; for a config
  space, `workspace.create {cwd, label, focus: true}`, whose first tab counts
  as the new tab. Then `pane.send_input` with the command + Enter. If `tabs`
  is missing, invalid, or empty, the palette falls back to the single Claude
  row; `label` defaults to the command's first word.
- **New tab**: same as above, no command sent.
- **New space**: `workspace.create {focus: true}`, no picker.
- **Space commands**: shown only for the config space whose `path` contains
  the focused pane's working directory (deepest match if spaces nest; all
  commands if Herdr reports no directory). Selecting one opens a tab in that
  space (the open space with the same label, or a new space at its path),
  names the tab after `label` (defaults to the command), and runs it.
- **Agent row**: `agent.focus` with the agent's pane id. **Workspace row**:
  `workspace.focus`.

### Row styling and icons

A green `●` marks the current agent, space, or id; agent tab names are bold;
preset paths and method names are dim. Styles only use attribute-specific
resets (`22`/`39`, never `0`), so the inverse-video highlight on the selected
row survives them. `truncate` counts only visible characters.

Icons show what a row does: green `+` creates something, red `−` is
destructive, `→` switches focus. For generated registry actions this is
inferred from the method name's last `.`-segment (`methodIcon` —
`*.create` → `+`, `*.close`/`*.stop`/`*.remove`/`*.unlink`/`*.disable`/
`*.delete` → `−`, anything with `focus` or `*.activate` → `→`); others (e.g.
`pane.split`, `pane.read`) get no icon. **Open config.json** uses `✎`,
**Copy config.json path** uses `⧉`.

Destructive methods needing confirmation: `server.stop`, `pane.close`,
`tab.close`, `workspace.close`, `worktree.remove`, `plugin.unlink`,
`plugin.disable` (the `DESTRUCTIVE` set in `palette.js`).

## File layout

```
herdr-plugin.toml         # manifest: popup pane, open action, prefix+t keybinding
src/
  palette.js               # runtime: everything the popup process runs
  registry.json             # generated, checked in — the action list itself
scripts/
  generate-registry.mjs    # dev-time: herdr api schema --json -> registry.json
  smoke-test.py            # dev-time: drives palette.js through a real pty
```

## Two-stage design

**Two stages, generation and runtime, kept deliberately separate** so the
popup never has to shell out to `herdr` or parse the ~275 KB schema on every
launch — it just reads a small pre-built JSON file.

### 1. `scripts/generate-registry.mjs` (run manually, not at runtime)

Runs `herdr api schema --json`, walks `schemas.request.oneOf` (one entry per
socket method: `{method: {const}, params: {$ref}}`) plus the referenced
`$defs`, and writes `src/registry.json`: one entry per method with:

- `title` — derived mechanically from the method name (`pane.wait_for_output`
  → "Pane: Wait For Output"), no hand-authored copy for 100+ entries.
- `category` — the method's first dot-segment.
- `params[]` — every top-level property of that method's params schema, each
  tagged with a `kind`:
  - `"enum"` when the property is a `$ref` to a def with an `enum` array
    (values included).
  - `"id"` when the property name matches a small hardcoded map
    (`ENTITY_LIST_SOURCE` in the script: `pane_id`/`target_pane_id`/
    `source_pane_id` → `pane.list`, `workspace_id`/`source_workspace_id` →
    `workspace.list`, `tab_id` → `tab.list`, `plugin_id` → `plugin.list`, and
    `target` → `agent.list` when the method is under `agent.*`). This mapping
    is **not** derivable from the schema itself — it's tribal knowledge about
    what those id strings mean, encoded once here.
  - `"string"` / `"number"` / `"integer"` / `"boolean"` for plain scalars.
  - `"object"` / `"array"` for anything else (nested objects, arrays) — these
    are marked `promptable: false`.
- `hasUnsupportedRequiredParams` — true when any *required* param isn't
  promptable. Those 13 actions (as of protocol 22 — e.g. `pane.send_keys`'s
  `keys` array, `layout.apply`'s tree, `events.subscribe`'s subscription
  list) are filtered out of the palette entirely rather than invoked with
  missing required fields. See **Known limitations** below.

Regenerate after upgrading Herdr:

```bash
node scripts/generate-registry.mjs
```

It prints the count written and re-lists any unsupported actions.

### 2. `src/palette.js` (the popup process, zero npm dependencies)

Launched by Herdr as the manifest's `[[panes]] placement = "popup"`
entrypoint — a session-modal terminal that owns all keyboard input until its
process exits (which closes the popup). Everything lives in this one file:

- **Socket client** (`callMethod`) — opens a fresh `net.createConnection` to
  `HERDR_SOCKET_PATH` per call, writes one `{id, method, params}` line, reads
  one response line, closes. This is not a simplification for v1 — it's
  required: Herdr's socket really does close after one response (confirmed
  by directly probing the running server; a second write on the same
  connection gets `EPIPE`). No reconnect/keep-alive logic exists because none
  is needed.
- **Fuzzy matcher** (`fuzzyMatch`, `rankItems`) — an in-house subsequence
  scorer (~30 lines): bonus for matching at the start of the string or right
  after a separator (space/`:`/`.`/`_`/`-`), bonus for consecutive runs,
  small penalty for longer targets. No `fzf` dependency, no npm package.
- **Raw-mode UI primitives** (`parseKeys`, `pickFromList`, `promptText`,
  `waitForAnyKey`) — hand-rolled ANSI TUI. Every render is a full-screen
  redraw (`\x1b[2J\x1b[H` then the whole frame); there's no partial/diff
  rendering. `parseKeys` only recognizes plain chars, Enter, Backspace,
  Ctrl+C, Escape, and Up/Down arrows — no Home/End/PageUp/mouse/etc.
- **Main flow** (`main`) — a `while (true)` loop:
  1. Show one fuzzy list (`pickFromList`) combining, in order: currently running
     agents (from a one-time `agent.list` + `tab.list` + `workspace.list` call
     at startup, each row rendered as two stacked lines — `<workspace label>`
     then `<agent> — <tab label>` — via `pickFromList`'s `getDisplay` option,
     current agent marked with a green `●` and sorted first), then all open
     workspaces (from that same `workspace.list` call, one row per workspace,
     current workspace marked with `●` and sorted first), then the
     predefined spaces from `config.json` (`loadSpacePresets`, see
     the README's **Jump to your projects**), then all actions
     where `!hasUnsupportedRequiredParams`. The list is
     rendered with non-selectable group headers (`pickFromList`'s `getGroup`
     option) — an "Agents" header over the agent rows, a "Spaces" header over
     the workspace rows, a "New Space" header over the presets, then one header per action `category` (`Agent`,
     `Pane`, `Tab`, `Workspace`, ...). Headers are inferred purely from item
     order, so they only look right when same-group items are contiguous,
     which holds here because `registry.json` is generated sorted by method
     name (grouping categories together) and the agent/workspace rows are
     contiguous blocks prepended before them, in that order. Escape here
     exits the whole palette. Picking an agent row calls `agent.focus`
     directly with that agent's pane id, and picking a workspace row calls
     `workspace.focus` with that workspace's id, and picking a preset calls
     `workspace.create` with its path/label and `focus: true` — all exit
     immediately, no result screen, no param prompts, since the target is
     already known.
  2. For a selected **action** (not an agent row), walk its **required** params in order
     (optional params are never prompted — always omitted). Each param is
     either another `pickFromList` (enum values, or a live `*.list` lookup
     for `"id"` params, pre-sorted so the value matching
     `HERDR_PLUGIN_CONTEXT_JSON`'s focused pane/workspace/tab sorts first) or
     a `promptText` free-text prompt. Escape on the *first* required param
     returns to the top-level action list (not full exit); Escape on any
     later param steps back one param.
  3. If the method is in the `DESTRUCTIVE` set, show one more confirm
     `pickFromList` ("Yes — `<title>`" / "No, cancel"). Cancelling returns to
     the top-level list without calling anything.
  4. Call the method for real, render the JSON result or `{code, message}`
     error, wait for any keypress, then exit the process (closing the
     popup). The palette is single-shot by design — one action per open,
     matching the plan — not a persistent session.
- `LIST_SHAPES` is the other hardcoded table this depends on: for each
  `*.list` socket method, which array field holds the rows
  (`panes`/`workspaces`/`tabs`/`agents`/`plugins`), which field is the id,
  and how to render a human label. Confirmed against real responses from the
  running server, not guessed from docs (see git history / this session's
  transcript for the actual probed shapes).

## Known limitations

- **13 of 102 methods are excluded** because their required params are
  arrays or nested objects (`hasUnsupportedRequiredParams: true`). Notably
  this means **you can't send arbitrary key combos or text-with-newlines
  through the palette** (`pane.send_keys`, `agent.send_keys` need a `keys`
  array) — only plain single-line string/number/boolean/enum/id params are
  supported. Extending this would mean teaching `generate-registry.mjs` to
  emit a descriptor for array-of-string params and teaching `palette.js` a
  comma-separated-list prompt type.
- **Optional params are never offered**, only required ones. E.g.
  `notification.show`'s optional `position`/`sound` can't be set from the
  palette even though the schema supports them. This was a deliberate v1
  scope cut, not an oversight.
- **`platforms = ["macos", "windows"]`** in the manifest. Linux is untested.
  On Windows, `HERDR_SOCKET_PATH` points at a marker file, not a Unix socket
  (connecting to it gives `ENOTSOCK`); the real endpoint is the named pipe
  `\\.\pipe\<HERDR_SOCKET_PATH>`, which `callMethod` dials. Other platform differences: the config
  dir falls back to `%APPDATA%\herdr\...`, "Copy config.json path" uses `clip`
  instead of `pbcopy`, and "Open config.json" falls back to `notepad` and
  double-quotes the path.
- **No automated regression suite**, just `scripts/smoke-test.py` (manual,
  see below). It checks a handful of representative paths, not all 89
  actions.
- No CI.

## Testing

There's no unit test framework here — the interesting logic is an
interactive raw-mode TUI, and Herdr popups have no pane ID and aren't
reachable through `pane.*` APIs, so you can't script keystrokes into a
*running popup* over the socket. Instead:

```bash
python3 scripts/smoke-test.py
```

This spawns `node src/palette.js` directly under a real pty (Python's
stdlib `pty` module) with the same env vars Herdr would inject, and drives
it through four scenarios: a zero-param action executed for real (`ping`),
an enum-param action with Escape back-navigation (`pane.split`, never
executed), the destructive-confirm gate choosing cancel (`server.stop`,
never executed), and the live dynamic id-picker (`pane.focus` pulling real
`pane.list` data). It exits 0 only if every scenario exited cleanly with no
crash text in its output. Run it from inside a Herdr pane (so
`HERDR_SOCKET_PATH` is already set) or export it manually first.

This is the same script used to verify the initial implementation — rerun it
after any change to `palette.js` or after regenerating the registry.

## Extending

- **New prompt kind for array params**: add a `kind: "string_list"` (or
  similar) case in `generate-registry.mjs`'s `resolveProp`/`PROMPTABLE_KINDS`
  for `{type: "array", items: {type: "string"}}` shapes, then handle it in
  `promptOneParam` in `palette.js` (e.g. a `promptText` whose value is split
  on commas before being sent).
- **Offer optional params too**: after the required-param loop in `main`,
  add an optional "add another field?" step that lists `action.params`
  where `!required && promptable`.
- **New destructive method**: just add its method name to the `DESTRUCTIVE`
  set in `palette.js`. Nothing else needs to change.
- **New id-entity mapping**: add a name → `*.list` method entry to
  `ENTITY_LIST_SOURCE` in `generate-registry.mjs`, then add the matching
  `LIST_SHAPES` entry in `palette.js` describing how to read that list
  method's response.
