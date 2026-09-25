#!/usr/bin/env node
// Runtime UI for the Herdr command palette. Zero dependencies: only Node core
// modules. Launched by Herdr as a `popup` pane, so it owns the whole terminal
// until it exits (which closes the popup).

"use strict";

const net = require("node:net");
const fs = require("node:fs");
const path = require("node:path");

const REGISTRY_PATH = path.join(__dirname, "registry.json");

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

function truncate(str, width) {
  if (width <= 1) return "";
  if (str.length <= width) return str;
  return str.slice(0, Math.max(0, width - 1)) + "…";
}

function terminalSize() {
  return {
    cols: process.stdout.columns || 80,
    rows: process.stdout.rows || 24,
  };
}

function pickFromList({ items, getText, getGroup, title, help }) {
  return new Promise((resolve) => {
    let query = "";
    let index = 0;
    let scrollOffset = 0;
    let filtered = rankItems(items, query, getText);

    // How many items starting at `start` fit within `maxRows` lines, counting
    // a header line whenever `getGroup` changes (so header overhead doesn't
    // silently push rows past the terminal height).
    function windowSize(start, maxRows) {
      let used = 0;
      let lastGroup;
      let count = 0;
      for (let i = start; i < filtered.length; i++) {
        const group = getGroup ? getGroup(filtered[i].item) : undefined;
        const cost = (getGroup && group !== lastGroup ? 1 : 0) + 1;
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
        const text = truncate(getText(visible[i].item), cols - 2);
        if (scrollOffset + i === index) out += `\x1b[7m› ${text}\x1b[0m\n`;
        else out += `  ${text}\n`;
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
      getText: (it) => `${it.label}  ·  ${it.id}${it.id === defaultId ? "  (current)" : ""}`,
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

async function loadAgentQuickJumpItems(context) {
  const agentsResult = await safeCallMethod("agent.list", {});
  if (agentsResult.error) return [];
  const agents = (agentsResult.result && agentsResult.result.agents) || [];
  if (agents.length === 0) return [];

  const tabsResult = await safeCallMethod("tab.list", {});
  const tabLabelById = new Map();
  if (!tabsResult.error) {
    for (const t of (tabsResult.result && tabsResult.result.tabs) || []) {
      tabLabelById.set(t.tab_id, t.label || t.tab_id);
    }
  }

  const items = agents.map((a) => {
    const isCurrent = a.pane_id === context.pane_id;
    const tabLabel = tabLabelById.get(a.tab_id) || a.terminal_title_stripped || a.terminal_title || a.tab_id;
    return {
      __kind: "agent",
      pane_id: a.pane_id,
      isCurrent,
      text: `${a.agent ?? "agent"} — ${tabLabel}${isCurrent ? "  (current)" : ""}`,
    };
  });
  items.sort((a, b) => (a.isCurrent === b.isCurrent ? 0 : a.isCurrent ? -1 : 1));
  return items;
}

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
  const agentItems = await loadAgentQuickJumpItems(context);
  const topItems = [...agentItems, ...supported];

  process.stdin.setEncoding("utf8");
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdout.write("\x1b[?25l");
  process.on("SIGINT", () => exitPalette(0));
  process.on("SIGTERM", () => exitPalette(0));

  while (true) {
    const top = await pickFromList({
      items: topItems,
      getText: (item) => (item.__kind === "agent" ? item.text : `${item.title}   (${item.method})`),
      getGroup: (item) => (item.__kind === "agent" ? "Agents" : humanParamName(item.category)),
      title: "Herdr Command Palette",
    });
    if (top.result === "cancel") break;

    const action = top.item;

    if (action.__kind === "agent") {
      const outcome = await safeCallMethod("agent.focus", { target: action.pane_id });
      if (outcome.error) await showMessage("Failed to focus agent", outcome.error.message);
      break;
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
