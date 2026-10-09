/** Pure endpoint validation. Callers inject the application's base URL; no DOM access. */
export function socialEndpoint(value, { baseUrl = 'https://shahr-nur.invalid/', allowedOrigins = [] } = {}) {
  if (typeof value !== 'string' || !value || /[\s\\\u0000-\u001f]/u.test(value)) return null;
  try {
    const base = new URL(baseUrl);
    const endpoint = new URL(value, base);
    if (endpoint.protocol === 'https:') endpoint.protocol = 'wss:';
    else if (endpoint.protocol === 'http:') endpoint.protocol = 'ws:';
    if (!['ws:', 'wss:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.hash) return null;
    if (base.protocol === 'https:' && endpoint.protocol !== 'wss:') return null;
    const httpOrigin = new URL(endpoint.href);
    httpOrigin.protocol = endpoint.protocol === 'wss:' ? 'https:' : 'http:';
    const allowed = allowedOrigins.some((origin) => {
      try {
        const candidate = new URL(origin);
        if (candidate.username || candidate.password || !['http:', 'https:', 'ws:', 'wss:'].includes(candidate.protocol)) return false;
        if (candidate.protocol === 'wss:') candidate.protocol = 'https:';
        if (candidate.protocol === 'ws:') candidate.protocol = 'http:';
        return candidate.origin === httpOrigin.origin;
      } catch { return false; }
    });
    return httpOrigin.origin === base.origin || allowed ? endpoint.href : null;
  } catch { return null; }
}

/** Only a relative, same-origin JSON path; reject traversal before URL normalization. */
export function quranPath(value, { baseUrl = 'https://shahr-nur.invalid/' } = {}) {
  if (typeof value !== 'string' || !value || value.startsWith('//') || /^[a-z][a-z\d+.-]*:/i.test(value)) return null;
  if (/[\\\s\u0000-\u001f?#]/u.test(value)) return null;
  try {
    const decoded = decodeURIComponent(value);
    if (decoded.startsWith('//') || /[\\\u0000-\u001f?#]/u.test(decoded)) return null;
    if (decoded.split('/').includes('..') || /%/u.test(decoded)) return null;
    const base = new URL(baseUrl);
    const url = new URL(value, base);
    if (url.origin !== base.origin || !url.pathname.endsWith('.json')) return null;
    return value.startsWith('./') || value.startsWith('/') ? value : `./${value}`;
  } catch { return null; }
}
