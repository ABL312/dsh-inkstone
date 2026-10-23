/**
 * dsh-inkstone tool kit.
 *
 * Host plugins in this bundle may not import `@deepseek-ai/*` packages (a
 * locally linked bundle resolves imports from its own directory). Everything
 * here uses Node built-ins only, and tools are registered as plain
 * definitions through `ctx.tools.register`.
 *
 * @module dsh-inkstone/lib/tool-kit
 */

/** Bundle version, mirrored into tool output for debugging. */
export const INKSTONE_VERSION = '0.1.0';

/** Hard cap for text handed back to the model in one tool result. */
export const DEFAULT_TEXT_LIMIT = 30000;

/**
 * One model-facing text content block.
 * @param {string} text
 * @returns {{type: 'text', text: string}[]}
 */
export function textBlocks(text) {
  return [{ type: 'text', text: String(text) }];
}

/**
 * Truncate text with an explicit marker instead of silently losing context.
 * @param {string} text
 * @param {number} [max]
 * @returns {string}
 */
export function truncate(text, max = DEFAULT_TEXT_LIMIT) {
  const value = String(text ?? '');
  if (value.length <= max) return value;
  return `${value.slice(0, max)}\n…[truncated ${value.length - max} chars]`;
}

/**
 * Render a short human summary plus an optional structured payload.
 * @param {string} summary
 * @param {unknown} [data]
 * @returns {{type: 'text', text: string}[]}
 */
export function renderSummary(summary, data) {
  const parts = [String(summary ?? '')];
  if (data !== undefined) {
    try {
      parts.push(JSON.stringify(data, null, 2));
    } catch {
      parts.push(String(data));
    }
  }
  return textBlocks(truncate(parts.join('\n\n')));
}

/**
 * Register one plain tool definition.
 *
 * The harness enforces a deliberately small JSON-Schema subset: `type`,
 * `properties`, `required`, boolean `additionalProperties`, `items`, scalar
 * `enum`/`const`, exact-one `oneOf` and annotations. Returned values are
 * validated against `schema` and then passed to `render`.
 *
 * @param {object} options
 * @param {string} options.name model-facing tool name (`snake_case`)
 * @param {string} options.description
 * @param {object} [options.parameters] raw JSON Schema for arguments
 * @param {object} [options.schema] raw JSON Schema for the returned value
 * @param {(args: any, value: any) => {type: string, text: string}[]} [options.render]
 * @param {(args: any, exec: any) => Promise<any>} options.execute
 * @param {number} [options.timeoutMs]
 * @returns {object} registry-ready definition
 */
export function defineTool(options) {
  if (!options || typeof options.name !== 'string' || options.name.length === 0) {
    throw new Error('defineTool: name is required');
  }
  const tool = {
    name: options.name,
    description: String(options.description ?? ''),
    parameters: options.parameters ?? { type: 'object', properties: {}, additionalProperties: false },
    output: {
      schema: options.schema ?? { type: 'object', additionalProperties: true },
      render: options.render ?? ((_args, value) => renderSummary('', value)),
    },
    async execute(args, exec) {
      return options.execute(args ?? {}, exec);
    },
  };
  if (options.timeoutMs !== undefined) tool.timeoutMs = options.timeoutMs;
  return tool;
}

/**
 * Normalize a plugin config object; Loader passes `undefined` when a row has no
 * config and may pass arbitrary user values.
 * @param {unknown} config
 * @returns {Record<string, any>}
 */
export function normalizeConfig(config) {
  return config !== null && typeof config === 'object' && !Array.isArray(config) ? config : {};
}

/**
 * Read a non-empty string argument.
 * @param {Record<string, any>} args
 * @param {string} name
 * @returns {string}
 */
export function requireString(args, name) {
  const value = args?.[name];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`invalid arguments: "${name}" must be a non-empty string`);
  }
  return value.trim();
}

/**
 * Read an optional string argument.
 * @param {Record<string, any>} args
 * @param {string} name
 * @returns {string | undefined}
 */
export function optionalString(args, name) {
  const value = args?.[name];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

/**
 * Read an optional positive integer argument with a default.
 * @param {Record<string, any>} args
 * @param {string} name
 * @param {number} fallback
 * @param {number} [max]
 * @returns {number}
 */
export function optionalInteger(args, name, fallback, max = 10000) {
  const value = args?.[name];
  if (value === undefined || value === null) return fallback;
  if (!Number.isInteger(value) || value < 1) throw new Error(`invalid arguments: "${name}" must be a positive integer`);
  return Math.min(value, max);
}

/**
 * Resolve the invoking session's working directory. Host tools run in the Host
 * process, whose own `process.cwd()` is unrelated to the session; the agent's
 * session header carries the effective directory.
 * @param {any} exec tool execution context
 * @returns {string}
 */
export function sessionCwd(exec) {
  const cwd = exec?.agent?.session?.header?.cwd;
  return typeof cwd === 'string' && cwd.length > 0 ? cwd : process.cwd();
}

/**
 * Read an environment variable, treating empty strings as absent.
 * @param {string} name
 * @returns {string | undefined}
 */
export function envValue(name) {
  const value = process.env[name];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Resolve a configured value with env fallback and a default.
 * @param {Record<string, any>} config
 * @param {string} key
 * @param {string | undefined} envName
 * @param {string | undefined} fallback
 * @returns {string | undefined}
 */
export function configured(config, key, envName, fallback) {
  const direct = config?.[key];
  if (typeof direct === 'string' && direct.length > 0) return direct;
  const fromEnv = envName ? envValue(envName) : undefined;
  return fromEnv ?? fallback;
}

/**
 * Format an unknown error for a tool message.
 * @param {unknown} error
 * @returns {string}
 */
export function errorMessage(error) {
  if (error instanceof Error) return error.message;
  return String(error);
}
