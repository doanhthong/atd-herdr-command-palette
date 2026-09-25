#!/usr/bin/env node
// Dev-time only: regenerate src/registry.json from the live Herdr socket schema.
// Run this again after upgrading Herdr to pick up new/changed methods.

import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const herdr = process.env.HERDR_BIN_PATH ?? "herdr";

const proc = spawnSync(herdr, ["api", "schema", "--json"], {
  encoding: "utf8",
  maxBuffer: 32 * 1024 * 1024,
});
if (proc.status !== 0) {
  console.error(proc.stderr || `herdr api schema --json exited ${proc.status}`);
  process.exit(1);
}

const schema = JSON.parse(proc.stdout);
const request = schema.schemas.request;
const defs = request.$defs;

// Field name -> socket method that returns a live list to pick a value from.
const ENTITY_LIST_SOURCE = {
  pane_id: "pane.list",
  target_pane_id: "pane.list",
  source_pane_id: "pane.list",
  workspace_id: "workspace.list",
  source_workspace_id: "workspace.list",
  tab_id: "tab.list",
  plugin_id: "plugin.list",
};

function titleCaseWord(w) {
  return w.length ? w[0].toUpperCase() + w.slice(1) : w;
}

function titleFor(method) {
  return method
    .split(".")
    .map((seg) => seg.split("_").map(titleCaseWord).join(" "))
    .join(": ");
}

// Resolve a JSON-Schema property to a small descriptor the runtime palette
// can act on directly, without needing a general-purpose schema walker.
function resolveProp(propSchema) {
  if (!propSchema) return { kind: "unknown" };

  if (propSchema.$ref) {
    const defName = propSchema.$ref.split("/").pop();
    const def = defs[defName];
    if (def && Array.isArray(def.enum)) {
      return { kind: "enum", values: def.enum };
    }
    return { kind: "object" };
  }

  if (Array.isArray(propSchema.anyOf)) {
    const nonNull = propSchema.anyOf.find((v) => v.type !== "null");
    if (nonNull) return resolveProp(nonNull);
    return { kind: "unknown" };
  }

  let type = propSchema.type;
  if (Array.isArray(type)) type = type.find((t) => t !== "null");

  if (type === "array") return { kind: "array" };
  if (type === "object") return { kind: "object" };
  if (type === "string" || type === "number" || type === "integer" || type === "boolean") {
    return { kind: type };
  }
  return { kind: "unknown" };
}

const PROMPTABLE_KINDS = new Set(["string", "number", "integer", "boolean", "enum", "id"]);

function buildParams(method, paramsRef) {
  if (!paramsRef) return [];
  const defName = paramsRef.split("/").pop();
  const def = defs[defName];
  if (!def || !def.properties) return [];

  const required = new Set(def.required ?? []);
  const params = [];

  for (const [name, propSchema] of Object.entries(def.properties)) {
    const resolved = resolveProp(propSchema);
    const entitySource =
      ENTITY_LIST_SOURCE[name] ?? (name === "target" && method.startsWith("agent.") ? "agent.list" : undefined);

    const kind = entitySource ? "id" : resolved.kind;
    params.push({
      name,
      required: required.has(name),
      kind,
      ...(resolved.kind === "enum" ? { values: resolved.values } : {}),
      ...(entitySource ? { listSource: entitySource } : {}),
      promptable: PROMPTABLE_KINDS.has(kind),
    });
  }

  return params;
}

const entries = [];
const warnings = [];

for (const variant of request.oneOf) {
  const method = variant.properties?.method?.const;
  const paramsRef = variant.properties?.params?.$ref;
  if (!method) continue;

  const params = buildParams(method, paramsRef);
  const unsupportedRequired = params.filter((p) => p.required && !p.promptable);
  if (unsupportedRequired.length > 0) {
    warnings.push(`${method}: required param(s) not promptable: ${unsupportedRequired.map((p) => p.name).join(", ")}`);
  }

  entries.push({
    method,
    title: titleFor(method),
    category: method.split(".")[0],
    params,
    hasUnsupportedRequiredParams: unsupportedRequired.length > 0,
  });
}

entries.sort((a, b) => a.method.localeCompare(b.method));

const outPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "registry.json");
writeFileSync(
  outPath,
  JSON.stringify(
    {
      generatedFromProtocol: schema.protocol,
      generatedAt: new Date().toISOString(),
      actions: entries,
    },
    null,
    2,
  ) + "\n",
);

console.log(`Wrote ${entries.length} actions to ${outPath}`);
if (warnings.length > 0) {
  console.log(`\n${warnings.length} action(s) have required params the palette can't prompt for yet (will be shown as unsupported):`);
  for (const w of warnings) console.log(`  - ${w}`);
}
