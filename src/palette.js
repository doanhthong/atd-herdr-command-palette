#!/usr/bin/env node
// Runtime UI for the Herdr command palette. Zero dependencies: only Node core
// modules. Launched by Herdr as a `popup` pane, so it owns the whole terminal
// until it exits (which closes the popup).

"use strict";

const net = require("node:net");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const REGISTRY_PATH = path.join(__dirname, "registry.json");
const PLUGIN_ID = "atd.command-palette";

// Methods that destroy or end something with no undo. Selecting one of these
// requires an extra confirmation step.
const DESTRUCTIVE = new Set([
  "server.stop",
  "pane.close",
  "tab.close",
  "workspace.close",
  "worktree.remove",
  "plugin.unlink",
  "plugin.disable",
]);

// How to turn a `*.list` response into pickable {id, label} rows.
const LIST_SHAPES = {
  "pane.list": {
    arrayKey: "panes",
    idField: "pane_id",
    labelFn: (p) => p.label || p.cwd || p.pane_id,
  },
  "workspace.list": {
    arrayKey: "workspaces",
    idField: "workspace_id",
    labelFn: (w) => w.label || w.workspace_id,
  },
  "tab.list": {
    arrayKey: "tabs",
    idField: "tab_id",
    labelFn: (t) => t.label || t.tab_id,
  },
  "plugin.list": {
    arrayKey: "plugins",
    idField: "plugin_id",
    labelFn: (p) => p.name || p.plugin_id,
  },
  "agent.list": {
    arrayKey: "agents",
    idField: "pane_id",
    labelFn: (a) => `${a.agent ?? "agent"} — ${a.terminal_title_stripped || a.terminal_title || a.agent_status || ""}`,
  },
};

// ---- socket client -------------------------------------------------------
// Confirmed empirically: Herdr's socket is one JSON request per connection;
// it replies once and closes. Always dial fresh.

function callMethod(method, params) {
  return new Promise((resolve, reject) => {
    const socketPath = process.env.HERDR_SOCKET_PATH;
    if (!socketPath) {
      reject(new Error("HERDR_SOCKET_PATH is not set"));
      return;
    }
    const id = `palette_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const sock = net.createConnection(socketPath);
    let buf = "";
    sock.on("connect", () => {
      sock.write(JSON.stringify({ id, method, params: params ?? {} }) + "\n");
    });
    sock.on("data", (d) => {
      buf += d.toString("utf8");
    });
    sock.on("close", () => {
      if (!buf.trim()) {
        reject(new Error("empty response from herdr socket"));
        return;
      }
      try {
        const line = buf.split("\n").find(Boolean) ?? buf;
        resolve(JSON.parse(line));
      } catch (err) {
        reject(err);
      }
    });
    sock.on("error", reject);
  });
}

async function safeCallMethod(method, params) {
  try {
    return await callMethod(method, params);
  } catch (err) {
    return { error: { code: "transport_error", message: err.message } };
  }
}

// ---- fuzzy matching -------------------------------------------------------

function fuzzyMatch(query, target) {
  if (!query) return { score: 0 };
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  let qi = 0;
  let score = 0;
  let consecutive = 0;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) {
      let bonus = 1;
      if (ti === 0) bonus += 3;
      else if (" :._-/".includes(t[ti - 1])) bonus += 2;
      consecutive += 1;
      bonus += consecutive;
      score += bonus;
      qi += 1;
    } else {
      consecutive = 0;
    }
  }
  if (qi < q.length) return null;
  score -= t.length * 0.01;
  return { score };
}

function rankItems(items, query, getText) {
  if (!query) return items.map((item) => ({ item, score: 0 }));
  const scored = [];
  for (const item of items) {
    const m = fuzzyMatch(query, getText(item));
    if (m) scored.push({ item, score: m.score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored;
}

// ---- terminal input -------------------------------------------------------

function parseKeys(chunk) {
  const keys = [];
  let i = 0;
  while (i < chunk.length) {
    const c = chunk[i];
    if (c === "\x1b") {
      if (chunk[i + 1] === "[") {
        const c3 = chunk[i + 2];
        if (c3 === "A") keys.push({ type: "up" });
        else if (c3 === "B") keys.push({ type: "down" });
        i += 3;
        continue;
      }
      keys.push({ type: "escape" });
      i += 1;
      continue;
    }
    if (c === "\r" || c === "\n") {
      keys.push({ type: "enter" });
      i += 1;
      continue;
    }
    if (c === "\x7f" || c === "\x08") {
      keys.push({ type: "backspace" });
      i += 1;
      continue;
    }
    if (c === "\x03") {
      keys.push({ type: "ctrlc" });
      i += 1;
      continue;
    }
    if (c >= " ") keys.push({ type: "char", value: c });
    i += 1;
  }
  return keys;
}

function exitPalette(code) {
  process.stdout.write("\x1b[?25h\x1b[2J\x1b[H");
  try {
    process.stdin.setRawMode(false);
  } catch {
    // not a TTY / already restored
  }
  process.exit(code ?? 0);
}

// Row styling. These only toggle their own attribute (22 = normal intensity,
// 39 = default foreground) instead of a full `\x1b[0m` reset, so they can sit
// inside a selected row without cancelling its inverse-video highlight.
const bold = (s) => `\x1b[1m${s}\x1b[22m`;
const dim = (s) => `\x1b[2m${s}\x1b[22m`;
const green = (s) => `\x1b[32m${s}\x1b[39m`;
const red = (s) => `\x1b[31m${s}\x1b[39m`;
const currentMark = (isCurrent) => (isCurrent ? `${green("●")} ` : "  ");

// A 2-char "icon slot" prefixed to a row: `icon` (styled) + a space, or two
// blank spaces when there's nothing to show — so icon and non-icon rows stay
// aligned with each other and with `currentMark`.
const iconSlot = (icon) => (icon ? `${icon} ` : "  ");

// Registry actions have no per-action metadata beyond their method name, so
// the icon is inferred from its last `.`-segment: what the action *does*
// (create something, tear something down, switch focus) rather than what
// it's about.
const DESTRUCTIVE_VERBS = new Set(["close", "stop", "remove", "unlink", "disable", "delete"]);
function methodIcon(method) {
  const verb = method.split(".").pop();
  if (verb === "create") return green("+");
  if (DESTRUCTIVE_VERBS.has(verb)) return red("−");
  if (verb.includes("focus") || verb === "activate") return "→";
  return null;
}

// Icons for the palette's own synthetic rows (quick actions, space-config
// commands, presets) — these know exactly what they do, so the icon is
// hard-coded rather than inferred.
function itemIcon(item) {
  if (item.__kind === "quick") return green("+"); // new tab / new Claude tab / new space
  if (item.__kind === "preset") return green("+"); // creates a new workspace
  if (item.__kind === "space_config") {
    if (item.action === "add") return green("+");
    if (item.action === "remove") return red("−");
    if (item.action === "open") return "✎";
    if (item.action === "copy") return "⧉";
  }
  return null;
}

// Truncates to `width` visible characters, skipping over SGR escape sequences
// so styled strings neither miscount nor get cut mid-sequence.
function truncate(str, width) {
  if (width <= 1) return "";
  const sgr = /\x1b\[[0-9;]*m/y;
  let visible = 0;
  for (let i = 0; i < str.length; ) {
    sgr.lastIndex = i;
    const m = sgr.exec(str);
    if (m) {
      i += m[0].length;
      continue;
    }
    visible += 1;
    i += 1;
  }
  if (visible <= width) return str;
  let out = "";
  let kept = 0;
  for (let i = 0; i < str.length && kept < width - 1; ) {
    sgr.lastIndex = i;
    const m = sgr.exec(str);
    if (m) {
      out += m[0];
      i += m[0].length;
      continue;
    }
    out += str[i];
    kept += 1;
    i += 1;
  }
  return out + "\x1b[22;39m…";
}

function terminalSize() {
  return {
    cols: process.stdout.columns || 80,
    rows: process.stdout.rows || 24,
  };
}

function pickFromList({ items, getText, getGroup, getDisplay, title, help }) {
  return new Promise((resolve) => {
    let query = "";
    let index = 0;
    let scrollOffset = 0;
    let filtered = rankItems(items, query, getText);

    // `getText` is the plain string fuzzy matching runs against; `getDisplay`
    // is what's drawn — a styled string, or an array of stacked lines (e.g.
    // an agent row). Falls back to `getText` for items it doesn't apply to.
    function linesFor(item) {
      const display = getDisplay && getDisplay(item);
      if (Array.isArray(display) && display.length > 0) return display;
      if (typeof display === "string") return [display];
      return [getText(item)];
    }

    // How many items starting at `start` fit within `maxRows` lines, counting
    // a header line whenever `getGroup` changes (so header overhead doesn't
    // silently push rows past the terminal height), plus each item's own
    // line count.
    function windowSize(start, maxRows) {
      let used = 0;
      let lastGroup;
      let count = 0;
      for (let i = start; i < filtered.length; i++) {
        const group = getGroup ? getGroup(filtered[i].item) : undefined;
        const cost = (getGroup && group !== lastGroup ? 1 : 0) + linesFor(filtered[i].item).length;
        if (used + cost > maxRows) break;
        used += cost;
        lastGroup = group;
        count += 1;
      }
      return Math.max(count, 1);
    }

    function render() {
      const { cols, rows } = terminalSize();
      const maxRows = Math.max(3, rows - 5);

      // Keep `index` inside the visible window, scrolling as needed.
      if (index < scrollOffset) scrollOffset = index;
      let size = windowSize(scrollOffset, maxRows);
      while (index >= scrollOffset + size && scrollOffset < filtered.length - 1) {
        scrollOffset += 1;
        size = windowSize(scrollOffset, maxRows);
      }

      let out = "\x1b[2J\x1b[H";
      out += `\x1b[1m${truncate(title, cols)}\x1b[0m\n`;
      out += `> ${query}\x1b[K\n\n`;
      const visible = filtered.slice(scrollOffset, scrollOffset + size);
      let lastGroup;
      for (let i = 0; i < visible.length; i++) {
        if (getGroup) {
          const group = getGroup(visible[i].item);
          if (group !== lastGroup) {
            out += `\x1b[2m${truncate(group, cols)}\x1b[0m\n`;
            lastGroup = group;
          }
        }
        const selected = scrollOffset + i === index;
        const lines = linesFor(visible[i].item);
        lines.forEach((line, li) => {
          const text = truncate(line, cols - 2);
          const prefix = li === 0 && selected ? "› " : "  ";
          if (selected) out += `\x1b[7m${prefix}${text}\x1b[0m\n`;
          else out += `${prefix}${text}\n`;
        });
      }
      if (filtered.length === 0) out += "\x1b[2m  (no matches)\x1b[0m\n";
      out += `\n\x1b[2m${help || "Enter select · Esc back"} · ${filtered.length}/${items.length}\x1b[0m`;
      process.stdout.write(out);
    }

    function refilter() {
      filtered = rankItems(items, query, getText);
      index = 0;
      scrollOffset = 0;
    }

    function onData(chunk) {
      for (const key of parseKeys(chunk.toString("utf8"))) {
        if (key.type === "ctrlc") {
          exitPalette(0);
          return;
        }
        if (key.type === "escape") {
          detach();
          resolve({ result: "cancel" });
          return;
        }
        if (key.type === "enter") {
          if (filtered.length === 0) continue;
          detach();
          resolve({ result: "select", item: filtered[index].item });
          return;
        }
        if (key.type === "up") index = Math.max(0, index - 1);
        else if (key.type === "down") index = Math.min(Math.max(0, filtered.length - 1), index + 1);
        else if (key.type === "backspace") {
          query = query.slice(0, -1);
          refilter();
        } else if (key.type === "char") {
          query += key.value;
          refilter();
        }
      }
      render();
    }

    function detach() {
      process.stdin.off("data", onData);
    }

    process.stdin.on("data", onData);
    render();
  });
}

function promptText({ title, initial, help }) {
  return new Promise((resolve) => {
    let value = initial || "";

    function render() {
      const { cols } = terminalSize();
      let out = "\x1b[2J\x1b[H";
      out += `\x1b[1m${truncate(title, cols)}\x1b[0m\n`;
      out += `> ${value}\x1b[K\n\n`;
      out += `\x1b[2m${help || "Enter confirm · Esc back"}\x1b[0m`;
      process.stdout.write(out);
    }

    function onData(chunk) {
      for (const key of parseKeys(chunk.toString("utf8"))) {
        if (key.type === "ctrlc") {
          exitPalette(0);
          return;
        }
        if (key.type === "escape") {
          detach();
          resolve({ result: "cancel" });
          return;
        }
        if (key.type === "enter") {
          detach();
          resolve({ result: "select", value });
          return;
        }
        if (key.type === "backspace") value = value.slice(0, -1);
        else if (key.type === "char") value += key.value;
      }
      render();
    }

    function detach() {
      process.stdin.off("data", onData);
    }

    process.stdin.on("data", onData);
    render();
  });
}

function waitForAnyKey() {
  return new Promise((resolve) => {
    function onData(chunk) {
      process.stdin.off("data", onData);
      // Ctrl+C during the result screen still exits cleanly.
      resolve();
    }
    process.stdin.on("data", onData);
  });
}

// ---- context / params -----------------------------------------------------

function parseContext() {
  let raw = {};
  try {
    raw = JSON.parse(process.env.HERDR_PLUGIN_CONTEXT_JSON || "{}");
  } catch {
    raw = {};
  }
  return {
    pane_id: raw.focused_pane_id,
    target_pane_id: raw.focused_pane_id,
    source_pane_id: raw.focused_pane_id,
    workspace_id: raw.workspace_id,
    source_workspace_id: raw.workspace_id,
    tab_id: raw.tab_id,
  };
}

function humanParamName(name) {
  return name.split("_").map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w)).join(" ");
}

async function promptOneParam(action, param, context) {
  const title = `${action.title} → ${humanParamName(param.name)}`;

  if (param.kind === "enum") {
    const items = param.values.map((v) => ({ value: v }));
    const picked = await pickFromList({ items, getText: (it) => it.value, title });
    if (picked.result === "cancel") return { result: "cancel" };
    return { result: "select", value: picked.item.value };
  }

  if (param.kind === "id") {
    const shape = LIST_SHAPES[param.listSource];
    const listResult = await safeCallMethod(param.listSource, {});
    if (listResult.error) {
      await showMessage(`Failed to load ${param.listSource}`, listResult.error.message);
      return { result: "cancel" };
    }
    const arr = (listResult.result && listResult.result[shape.arrayKey]) || [];
    const items = arr.map((entry) => ({ id: entry[shape.idField], label: shape.labelFn(entry) }));
    const defaultId = context[param.name];
    items.sort((a, b) => {
      if (a.id === defaultId) return -1;
      if (b.id === defaultId) return 1;
      return 0;
    });
    if (items.length === 0) {
      await showMessage(title, `${param.listSource} returned no items.`);
      return { result: "cancel" };
    }
    const picked = await pickFromList({
      items,
      getText: (it) => `${it.label}  ·  ${it.id}`,
      getDisplay: (it) => `${currentMark(it.id === defaultId)}${it.label}  ${dim(it.id)}`,
      title,
    });
    if (picked.result === "cancel") return { result: "cancel" };
    return { result: "select", value: picked.item.id };
  }

  if (param.kind === "boolean") {
    const items = [
      { value: true, label: "true" },
      { value: false, label: "false" },
    ];
    const picked = await pickFromList({ items, getText: (it) => it.label, title });
    if (picked.result === "cancel") return { result: "cancel" };
    return { result: "select", value: picked.item.value };
  }

  // string / number / integer: free text.
  const initial = context[param.name] != null ? String(context[param.name]) : "";
  const text = await promptText({ title: `${title}  (${param.kind})`, initial });
  if (text.result === "cancel") return { result: "cancel" };
  if (param.kind === "number" || param.kind === "integer") {
    const n = Number(text.value);
    return { result: "select", value: Number.isFinite(n) ? n : text.value };
  }
  return { result: "select", value: text.value };
}

async function loadQuickJumpItems(context) {
  // agent.list, tab.list, and workspace.list are independent requests, each
  // paying its own fresh socket connect + round-trip (see callMethod) — fire
  // them together instead of one after another. Both the agent rows and the
  // workspace rows below are built from this one fetch.
  const [agentsResult, tabsResult, workspacesResult] = await Promise.all([
    safeCallMethod("agent.list", {}),
    safeCallMethod("tab.list", {}),
    safeCallMethod("workspace.list", {}),
  ]);

  const tabLabelById = new Map();
  if (!tabsResult.error) {
    for (const t of (tabsResult.result && tabsResult.result.tabs) || []) {
      tabLabelById.set(t.tab_id, t.label || t.tab_id);
    }
  }

  const workspaces = (!workspacesResult.error && workspacesResult.result && workspacesResult.result.workspaces) || [];
  const workspaceLabelById = new Map();
  for (const w of workspaces) {
    workspaceLabelById.set(w.workspace_id, w.label || w.workspace_id);
  }

  let agentItems = [];
  if (!agentsResult.error) {
    const agents = (agentsResult.result && agentsResult.result.agents) || [];
    agentItems = agents.map((a) => {
      const isCurrent = a.pane_id === context.pane_id;
      const tabLabel = tabLabelById.get(a.tab_id) || a.terminal_title_stripped || a.terminal_title || a.tab_id;
      const workspaceLabel = workspaceLabelById.get(a.workspace_id) || a.workspace_id;
      const agentName = a.agent ?? "agent";
      return {
        __kind: "agent",
        pane_id: a.pane_id,
        isCurrent,
        text: `${workspaceLabel} — ${agentName} — ${tabLabel}`,
        display: [`${currentMark(isCurrent)}${workspaceLabel}`, `  ${agentName} — ${bold(tabLabel)}`],
      };
    });
    agentItems.sort((a, b) => (a.isCurrent === b.isCurrent ? 0 : a.isCurrent ? -1 : 1));
  }

  const workspaceItems = workspaces.map((w) => {
    const isCurrent = w.workspace_id === context.workspace_id;
    const label = w.label || w.workspace_id;
    return {
      __kind: "workspace",
      workspace_id: w.workspace_id,
      isCurrent,
      text: label,
      display: `${currentMark(isCurrent)}${label}`,
    };
  });
  workspaceItems.sort((a, b) => (a.isCurrent === b.isCurrent ? 0 : a.isCurrent ? -1 : 1));

  return { agentItems, workspaceItems };
}

// ---- predefined spaces ------------------------------------------------------
// User-maintained list of frequently used spaces, kept outside the repo in the
// plugin's config dir (`herdr plugin config-dir atd.command-palette`).

function configDir() {
  return process.env.HERDR_PLUGIN_CONFIG_DIR || path.join(os.homedir(), ".config", "herdr", "plugins", "config", PLUGIN_ID);
}

function expandHome(p) {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

function loadSpacePresets() {
  const file = path.join(configDir(), "spaces.json");
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return []; // no config file: feature simply stays hidden
  }
  let spaces;
  try {
    const parsed = JSON.parse(raw);
    spaces = parsed && parsed.spaces;
    if (!Array.isArray(spaces)) throw new Error('expected a top-level "spaces" array');
  } catch (err) {
    return [{ __kind: "preset_error", file, message: err.message, text: "spaces.json is invalid — select for details" }];
  }
  return spaces
    .filter((s) => s && typeof s.path === "string" && s.path)
    .map((s) => {
      const dir = expandHome(s.path);
      const label = s.label || path.basename(dir);
      return { __kind: "preset", label, path: dir, text: `${label}  ·  ${s.path}`, display: `${iconSlot(green("+"))}${label}  ${dim(s.path)}` };
    });
}

function spacesConfigPath() {
  return path.join(configDir(), "spaces.json");
}

// Reads spaces.json for editing (as opposed to `loadSpacePresets`, which
// reads it for display and swallows errors into a row). A missing file reads
// as an empty list — the file is only created once something is added.
function readSpacesConfig() {
  const file = spacesConfigPath();
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return { file, spaces: [] };
    throw err;
  }
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed.spaces)) throw new Error('expected a top-level "spaces" array');
  return { file, spaces: parsed.spaces };
}

function writeSpacesConfig(spaces) {
  const file = spacesConfigPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ spaces }, null, 2) + "\n", "utf8");
  return file;
}

function shellQuote(s) {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

// Commands that manage spaces.json itself, shown alongside the presets it
// produces so "add a space" and "use a space" live in the same group.
const SPACE_CONFIG_ACTIONS = [
  { __kind: "space_config", action: "add", text: "Add space to config…" },
  { __kind: "space_config", action: "remove", text: "Remove space from config…" },
  { __kind: "space_config", action: "open", text: "Open spaces.json" },
  { __kind: "space_config", action: "copy", text: "Copy spaces.json path" },
];

async function showMessage(title, body) {
  const { cols } = terminalSize();
  let out = "\x1b[2J\x1b[H";
  out += `\x1b[1m${truncate(title, cols)}\x1b[0m\n\n${body}\n\n`;
  out += "\x1b[2mpress any key\x1b[0m";
  process.stdout.write(out);
  await waitForAnyKey();
}

async function showResult(action, params, outcome) {
  const { cols } = terminalSize();
  let out = "\x1b[2J\x1b[H";
  out += `\x1b[1m${truncate(action.title, cols)}\x1b[0m  \x1b[2m${action.method}\x1b[0m\n\n`;
  if (Object.keys(params).length > 0) out += `params: ${JSON.stringify(params)}\n\n`;
  if (outcome.error) {
    out += `\x1b[31merror: ${outcome.error.code}\x1b[0m\n${outcome.error.message}\n`;
  } else {
    out += `\x1b[32mok\x1b[0m\n${JSON.stringify(outcome.result, null, 2)}\n`;
  }
  out += "\n\x1b[2mpress any key to close\x1b[0m";
  process.stdout.write(out);
  await waitForAnyKey();
}

// ---- quick actions ----------------------------------------------------------

const QUICK_ACTIONS = [
  { __kind: "quick", quick: "claude_tab", text: "New Claude tab", runClaude: true },
  { __kind: "quick", quick: "tab", text: "New tab", runClaude: false },
  { __kind: "quick", quick: "space", text: "New space" },
];

// Opens a fresh tab in `target` — an open workspace row or a spaces.json
// preset — focuses it, and optionally starts `claude` in it. A preset has no
// workspace yet, so the new workspace's own first tab serves as "the new tab"
// rather than stacking a second one on top. Returns an error message or null.
async function openTabIn(target, { runClaude }, context) {
  let outcome;
  if (target.__kind === "preset") {
    if (!fs.existsSync(target.path)) return `Path does not exist: ${target.path}`;
    outcome = await safeCallMethod("workspace.create", { cwd: target.path, label: target.label, focus: true });
  } else {
    outcome = await safeCallMethod("tab.create", { workspace_id: target.workspace_id, focus: true });
    if (!outcome.error && target.workspace_id !== context.workspace_id) {
      const focused = await safeCallMethod("workspace.focus", { workspace_id: target.workspace_id });
      if (focused.error) return focused.error.message;
    }
  }
  if (outcome.error) return outcome.error.message;
  if (runClaude) {
    const pane = outcome.result && outcome.result.root_pane;
    if (!pane) return "Herdr did not return the new tab's pane";
    const sent = await safeCallMethod("pane.send_input", { pane_id: pane.pane_id, text: "claude", keys: ["Enter"] });
    if (sent.error) return sent.error.message;
  }
  return null;
}

// ---- main flow --------------------------------------------------------

async function confirmDestructive(action) {
  const items = [
    { value: true, label: `Yes — ${action.title}` },
    { value: false, label: "No, cancel" },
  ];
  const picked = await pickFromList({
    items,
    getText: (it) => it.label,
    title: `Confirm: ${action.title}`,
    help: "This action cannot be undone",
  });
  if (picked.result === "cancel") return false;
  return picked.item.value === true;
}

async function main() {
  if (!process.env.HERDR_ENV) {
    console.error("This must be run inside a Herdr pane (HERDR_ENV not set).");
    process.exit(1);
  }
  if (!process.stdin.isTTY) {
    console.error("This must be run in an interactive terminal (stdin is not a TTY).");
    process.exit(1);
  }

  const registry = JSON.parse(fs.readFileSync(REGISTRY_PATH, "utf8"));
  const supported = registry.actions.filter((a) => !a.hasUnsupportedRequiredParams);
  const context = parseContext();

  // agent.list/tab.list/workspace.list round-trip before the palette can
  // render its first frame; show something immediately instead of leaving
  // the terminal looking hung.
  process.stdout.write("\x1b[2J\x1b[H\x1b[2mLoading…\x1b[0m");
  const { agentItems, workspaceItems } = await loadQuickJumpItems(context);
  const presetItems = loadSpacePresets();
  const topItems = [...QUICK_ACTIONS, ...agentItems, ...workspaceItems, ...presetItems, ...SPACE_CONFIG_ACTIONS, ...supported];
  const isQuickItem = (item) => item.__kind != null;
  const groupFor = (item) => {
    if (item.__kind === "quick") return "Quick Actions";
    if (item.__kind === "agent") return "Agents";
    if (item.__kind === "workspace") return "Spaces";
    if (item.__kind === "preset" || item.__kind === "preset_error") return "New Space";
    if (item.__kind === "space_config") return "Space Config";
    return humanParamName(item.category);
  };

  process.stdin.setEncoding("utf8");
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdout.write("\x1b[?25l");
  process.on("SIGINT", () => exitPalette(0));
  process.on("SIGTERM", () => exitPalette(0));

  while (true) {
    const top = await pickFromList({
      items: topItems,
      getText: (item) => (isQuickItem(item) ? item.text : `${item.title}   (${item.method})`),
      getGroup: groupFor,
      getDisplay: (item) => {
        if (item.__kind === "quick" || item.__kind === "space_config") return `${iconSlot(itemIcon(item))}${item.text}`;
        if (isQuickItem(item)) return item.display;
        return `${iconSlot(methodIcon(item.method))}${item.title}   ${dim(`(${item.method})`)}`;
      },
      title: "Herdr Command Palette",
    });
    if (top.result === "cancel") break;

    const action = top.item;

    if (action.__kind === "quick" && action.quick === "space") {
      const outcome = await safeCallMethod("workspace.create", { focus: true });
      if (outcome.error) await showMessage("Failed to create space", outcome.error.message);
      break;
    }

    if (action.__kind === "quick") {
      const targets = [...workspaceItems, ...presetItems.filter((p) => p.__kind === "preset")];
      const picked = await pickFromList({
        items: targets,
        getText: (item) => item.text,
        getGroup: (item) => (item.__kind === "workspace" ? "Spaces" : "From config"),
        getDisplay: (item) => item.display,
        title: `${action.text} → Space`,
      });
      if (picked.result === "cancel") continue;
      const error = await openTabIn(picked.item, action, context);
      if (error) await showMessage(`${action.text} failed`, error);
      break;
    }

    if (action.__kind === "agent") {
      const outcome = await safeCallMethod("agent.focus", { target: action.pane_id });
      if (outcome.error) await showMessage("Failed to focus agent", outcome.error.message);
      break;
    }

    if (action.__kind === "workspace") {
      const outcome = await safeCallMethod("workspace.focus", { workspace_id: action.workspace_id });
      if (outcome.error) await showMessage("Failed to focus workspace", outcome.error.message);
      break;
    }

    if (action.__kind === "preset_error") {
      await showMessage("Invalid spaces.json", `${action.file}\n\n${action.message}`);
      continue;
    }

    if (action.__kind === "preset") {
      if (!fs.existsSync(action.path)) {
        await showMessage(`Can't create "${action.label}"`, `Path does not exist: ${action.path}`);
        continue;
      }
      const outcome = await safeCallMethod("workspace.create", { cwd: action.path, label: action.label, focus: true });
      if (outcome.error) await showMessage("Failed to create workspace", outcome.error.message);
      break;
    }

    if (action.__kind === "space_config") {
      if (action.action === "add") {
        const pathInput = await promptText({ title: "Add space to config → Path", help: "~ ok · Enter confirm · Esc cancel" });
        if (pathInput.result === "cancel") continue;
        const pathValue = pathInput.value.trim();
        if (!pathValue) continue;
        const labelInput = await promptText({ title: "Add space to config → Label (optional)", help: "Enter confirm · Esc cancel" });
        if (labelInput.result === "cancel") continue;
        const labelValue = labelInput.value.trim();
        try {
          const { spaces } = readSpacesConfig();
          spaces.push(labelValue ? { path: pathValue, label: labelValue } : { path: pathValue });
          const file = writeSpacesConfig(spaces);
          await showMessage("Space added", `${pathValue}\n\nSaved to ${file}.\nReopen the palette to see it under New Space.`);
        } catch (err) {
          await showMessage("Failed to add space", err.message);
        }
        break;
      }

      if (action.action === "remove") {
        const removable = presetItems.filter((p) => p.__kind === "preset");
        if (removable.length === 0) {
          await showMessage("Remove space from config", "spaces.json has no entries to remove.");
          continue;
        }
        const picked = await pickFromList({
          items: removable,
          getText: (it) => it.text,
          getDisplay: (it) => `${iconSlot(red("−"))}${it.label}  ${dim(it.path)}`,
          title: "Remove space from config",
          help: "Enter remove · Esc cancel",
        });
        if (picked.result === "cancel") continue;
        try {
          const { spaces } = readSpacesConfig();
          const idx = spaces.findIndex((s) => expandHome(s.path) === picked.item.path);
          if (idx === -1) {
            await showMessage("Remove space from config", "That entry no longer matches spaces.json — it may have changed on disk.");
          } else {
            spaces.splice(idx, 1);
            const file = writeSpacesConfig(spaces);
            await showMessage("Space removed", `${picked.item.label}\n\nSaved to ${file}.\nReopen the palette to refresh the list.`);
          }
        } catch (err) {
          await showMessage("Failed to remove space", err.message);
        }
        break;
      }

      if (action.action === "open") {
        const file = spacesConfigPath();
        try {
          fs.mkdirSync(path.dirname(file), { recursive: true });
          if (!fs.existsSync(file)) writeSpacesConfig([]);
        } catch (err) {
          await showMessage("Failed to open spaces.json", err.message);
          break;
        }
        const outcome = await safeCallMethod("tab.create", { workspace_id: context.workspace_id, focus: true });
        const pane = outcome.result && outcome.result.root_pane;
        if (outcome.error || !pane) {
          await showMessage("Failed to open spaces.json", outcome.error ? outcome.error.message : "Herdr did not return the new tab's pane");
          break;
        }
        const editor = process.env.EDITOR || "vi";
        const sent = await safeCallMethod("pane.send_input", { pane_id: pane.pane_id, text: `${editor} ${shellQuote(file)}`, keys: ["Enter"] });
        if (sent.error) await showMessage("Failed to open spaces.json", sent.error.message);
        break;
      }

      if (action.action === "copy") {
        const file = spacesConfigPath();
        try {
          execFileSync("pbcopy", [], { input: file });
          await showMessage("Copied", `spaces.json path copied to clipboard:\n\n${file}`);
        } catch (err) {
          await showMessage("Failed to copy path", err.message);
        }
        continue;
      }
    }

    const required = action.params.filter((p) => p.required);
    const filled = {};
    let i = 0;
    let backToTop = false;
    while (i < required.length) {
      const param = required[i];
      const outcome = await promptOneParam(action, param, context);
      if (outcome.result === "cancel") {
        if (i === 0) {
          backToTop = true;
          break;
        }
        i -= 1;
        continue;
      }
      filled[param.name] = outcome.value;
      i += 1;
    }
    if (backToTop) continue;

    if (DESTRUCTIVE.has(action.method)) {
      const confirmed = await confirmDestructive(action);
      if (!confirmed) continue;
    }

    const outcome = await safeCallMethod(action.method, filled);
    await showResult(action, filled, outcome);
    break;
  }

  exitPalette(0);
}

main().catch((err) => {
  process.stdout.write("\x1b[?25h\x1b[2J\x1b[H");
  console.error(err);
  process.exit(1);
});
