"use strict";

// PTC SDK projection: turn the visible native tools into a compact TypeScript
// declaration file for the model. It is prompt text, not a compiler input.

function literal(value) {
  return JSON.stringify(value);
}

function typeForSchema(schema) {
  if (!schema || typeof schema !== "object") return "unknown";
  if (Array.isArray(schema.enum)) {
    return schema.enum.map((value) => (value == null ? "null" : literal(value))).join(" | ") || "unknown";
  }
  if (Array.isArray(schema.anyOf) || Array.isArray(schema.oneOf)) {
    const list = schema.anyOf || schema.oneOf;
    return list.map(typeForSchema).join(" | ") || "unknown";
  }
  const type = schema.type;
  if (Array.isArray(type)) return type.map((item) => typeForSchema({ ...schema, type: item })).join(" | ");
  if (type === "string") return "string";
  if (type === "number" || type === "integer") return "number";
  if (type === "boolean") return "boolean";
  if (type === "null") return "null";
  if (type === "array") return typeForSchema(schema.items) + "[]";
  if (type === "object" && schema.properties && typeof schema.properties === "object") {
    const required = new Set(Array.isArray(schema.required) ? schema.required : []);
    const fields = Object.entries(schema.properties).map(([name, child]) => {
      const key = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ? name : literal(name);
      return "    " + key + (required.has(name) ? "" : "?") + ": " + typeForSchema(child) + ";";
    });
    return "{\n" + fields.join("\n") + "\n  }";
  }
  return "unknown";
}

function docComment(description, indent) {
  if (typeof description !== "string" || !description.trim()) return [];
  const safe = description.replaceAll("*/", "* /").replace(/\s+/g, " ").trim();
  return [indent + "/** " + safe + " */"];
}

function renderToolSdk(tools) {
  const lines = [
    "```typescript",
    "interface RunCodeTools {",
    "  inspect(...values: unknown[]): void;",
  ];
  for (const tool of tools || []) {
    if (!tool || typeof tool.name !== "string" || tool.name === "run_code") continue;
    const schema = tool.parameters && typeof tool.parameters === "object" ? tool.parameters : {};
    const properties = schema.properties && typeof schema.properties === "object" ? schema.properties : {};
    const required = new Set(Array.isArray(schema.required) ? schema.required : []);
    lines.push(...docComment(tool.description, "  "));
    if (Object.keys(properties).length === 0) {
      lines.push("  " + tool.name + "(args?: {}): Promise<string>;");
      continue;
    }
    lines.push("  " + tool.name + "(args: {");
    for (const [name, child] of Object.entries(properties)) {
      lines.push(...docComment(child && child.description, "    "));
      const key = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ? name : literal(name);
      lines.push("    " + key + (required.has(name) ? "" : "?") + ": " + typeForSchema(child) + ";");
    }
    lines.push("  }): Promise<string>;");
  }
  lines.push("}");
  lines.push("declare const tools: RunCodeTools;");
  lines.push("```");
  return lines.join("\n");
}

const __exports = { renderToolSdk, typeForSchema };
export { renderToolSdk, typeForSchema };
export default __exports;
