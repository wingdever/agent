"use strict";

// The three shared model-facing resource tools. They are registered once, not
// per server: the server name is an argument, so a project with many servers
// still exposes exactly three resource tools. Like the DSH originals, each is
// read-only and safe to run concurrently.

// Resource results are JSON with an optional base64 `blob`. The blob stays out
// of model history — its size is reported instead, which is what a model can act
// on — and every result names the server it came from.
function renderResourceResult(server, value) {
  const rendered = JSON.stringify(value, (key, item) => {
    if (key === "blob" && typeof item === "string") {
      return `[binary resource: ${item.length} base64 characters; available to programmatic callers]`;
    }
    return item;
  });
  return { text: `MCP server: ${server}\n${rendered}` };
}

// A signal is attached only when the caller supplies one: an uncancellable call
// keeps the plain argument object it always had.
function withSignal(options, exec) {
  return exec && exec.signal ? { ...options, signal: exec.signal } : options;
}

const listParameters = {
  type: "object",
  properties: {
    server: { type: "string", description: "Configured MCP server name." },
    cursor: { type: "string", description: "Continuation cursor returned by this server." },
  },
  required: ["server"],
};

const readParameters = {
  type: "object",
  properties: {
    server: { type: "string", description: "Configured MCP server name." },
    uri: { type: "string", description: "Resource URI to read." },
  },
  required: ["server", "uri"],
};

// `providers()` returns the live server-name -> connection map. Resolving it per
// call means a server that reconnects or gains the resource capability later
// works without re-registering the tools.
function buildResourceTools(providers) {
  const resolve = (server) => {
    const connection = providers().get(server);
    if (!connection) {
      const known = [...providers().keys()].sort();
      throw new Error(
        `unknown MCP resource server "${server}" (known: ${known.length ? known.join(", ") : "none"})`,
      );
    }
    return connection;
  };

  const tool = (name, description, parameters, run) => ({
    name,
    description,
    parameters,
    type: "mcp",
    prompt: "",
    promptSection: "",
    concurrencySafe: true,
    defaultVisible: true,
    result: "text",
    run,
  });

  return {
    list_mcp_resources: tool(
      "list_mcp_resources",
      "List resources available from an MCP server.",
      listParameters,
      async (args = {}, exec = {}) => {
        const connection = resolve(args.server);
        const result = await connection.listResources(withSignal({ cursor: args.cursor }, exec));
        return renderResourceResult(args.server, result);
      },
    ),
    list_mcp_resource_templates: tool(
      "list_mcp_resource_templates",
      "List parameterized resource URI templates from an MCP server.",
      listParameters,
      async (args = {}, exec = {}) => {
        const connection = resolve(args.server);
        const result = await connection.listResourceTemplates(withSignal({ cursor: args.cursor }, exec));
        return renderResourceResult(args.server, result);
      },
    ),
    read_mcp_resource: tool(
      "read_mcp_resource",
      "Read an MCP resource by URI from the named server. Use a listed URI or an expanded resource template.",
      readParameters,
      async (args = {}, exec = {}) => {
        const connection = resolve(args.server);
        if (typeof args.uri !== "string" || !args.uri.trim()) throw new Error("uri must be a non-empty string");
        const result = await connection.readResource(args.uri, exec.signal);
        return renderResourceResult(args.server, result);
      },
    ),
  };
}

const __exports = { buildResourceTools, renderResourceResult };
export { buildResourceTools, renderResourceResult };
export default __exports;
