/** @typedef {import("../src/api-client-contracts").ApiRequestOptions} ApiRequestOptions */
/** @typedef {import("../src/api-client-contracts").EventStreamHandlers} EventStreamHandlers */

/**
 * @param {string} path
 * @param {ApiRequestOptions} [options]
 * @returns {Promise<unknown|null>}
 */
async function api(path, options = {}) {
  const headers = new Headers(options.headers || {});
  if (options.body !== undefined) headers.set("Content-Type", "application/json");
  const response = await fetch(path, { ...options, headers, credentials: "same-origin", cache: "no-store" });
  const data = response.status === 204 ? null : await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data?.error || `HTTP ${response.status}`);
  return data;
}

/**
 * @param {string} path
 * @param {EventStreamHandlers} [handlers]
 * @returns {EventSource}
 */
function openEventStream(path, handlers = {}) {
  const source = new EventSource(path);
  if (handlers.onHello) source.addEventListener("hello", handlers.onHello);
  source.onopen = handlers.onOpen || null;
  source.onerror = handlers.onError || null;
  source.onmessage = handlers.onMessage || null;
  if (handlers.onMessage) for (const type of handlers.eventTypes || []) source.addEventListener(type, event => handlers.onMessage?.(event));
  return source;
}

globalThis.tokenCouponClient = Object.freeze({ api, openEventStream });
