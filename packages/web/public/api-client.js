async function api(path, options = {}) {
  const headers = new Headers(options.headers || {});
  if (options.body !== undefined) headers.set("Content-Type", "application/json");
  const response = await fetch(path, { ...options, headers, credentials: "same-origin", cache: "no-store" });
  const data = response.status === 204 ? null : await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data?.error || `HTTP ${response.status}`);
  return data;
}

function openEventStream(path, handlers = {}) {
  const source = new EventSource(path);
  if (handlers.onHello) source.addEventListener("hello", handlers.onHello);
  source.onopen = handlers.onOpen || null;
  source.onerror = handlers.onError || null;
  source.onmessage = handlers.onMessage || null;
  for (const type of handlers.eventTypes || []) source.addEventListener(type, handlers.onMessage);
  return source;
}

globalThis.tokenCouponClient = Object.freeze({ api, openEventStream });
