/**
 * Minimal HTTP helpers for the inkstone plugins (Node built-in `fetch`).
 *
 * @module dsh-inkstone/lib/http
 */

import { truncate } from './tool-kit.mjs';

/** A failed HTTP request with a model-facing message. */
export class HttpError extends Error {
  /**
   * @param {string} message
   * @param {{url?: string, status?: number, body?: string}} [details]
   */
  constructor(message, details = {}) {
    super(message);
    this.name = 'HttpError';
    this.url = details.url;
    this.status = details.status;
    this.body = details.body;
  }
}

/**
 * Merge an optional caller signal with a timeout.
 * @param {AbortSignal | undefined} signal
 * @param {number} timeoutMs
 * @returns {AbortSignal}
 */
function withTimeout(signal, timeoutMs) {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

/**
 * Perform an HTTP request and decode the response.
 *
 * @param {string} url
 * @param {object} [options]
 * @param {string} [options.method]
 * @param {Record<string, string>} [options.headers]
 * @param {BodyInit | undefined} [options.body]
 * @param {number} [options.timeoutMs]
 * @param {AbortSignal} [options.signal]
 * @param {'json' | 'text' | 'buffer'} [options.expect]
 * @param {number} [options.maxErrorBody]
 * @returns {Promise<any>} parsed body
 */
export async function httpRequest(url, options = {}) {
  const method = options.method ?? 'GET';
  const expect = options.expect ?? 'json';
  const timeoutMs = options.timeoutMs ?? 15000;
  let response;
  try {
    response = await fetch(url, {
      method,
      headers: options.headers,
      body: options.body,
      signal: withTimeout(options.signal, timeoutMs),
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new HttpError(`cannot reach ${url}: ${reason}`, { url });
  }

  if (!response.ok) {
    let body = '';
    try {
      body = await response.text();
    } catch {
      body = '';
    }
    throw new HttpError(
      `HTTP ${response.status} ${response.statusText} for ${method} ${url}: ${truncate(body.trim(), options.maxErrorBody ?? 1500)}`,
      { url, status: response.status, body },
    );
  }

  if (expect === 'text') return response.text();
  if (expect === 'buffer') return new Uint8Array(await response.arrayBuffer());
  const text = await response.text();
  if (text.trim().length === 0) return null;
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(`expected JSON from ${url}, got: ${truncate(text, 800)}`, { url, status: response.status, body: text });
  }
}

/**
 * Query-string helper that drops undefined/null/empty values.
 * @param {Record<string, string | number | boolean | null | undefined>} params
 * @returns {string}
 */
export function query(params) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    search.set(key, String(value));
  }
  const text = search.toString();
  return text.length > 0 ? `?${text}` : '';
}

/**
 * Join a base URL and a path without duplicated slashes.
 * @param {string} base
 * @param {string} suffix
 * @returns {string}
 */
export function joinUrl(base, suffix) {
  return `${base.replace(/\/+$/, '')}/${suffix.replace(/^\/+/, '')}`;
}
