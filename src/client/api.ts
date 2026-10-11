let displayedUnderlying: string | null = null;
export function setApiUnderlying(underlying: string | null) { displayedUnderlying = underlying; }

/** Account actions remain global; book mutations must match the asset visible to the trader. */
function isAssetMutation(path: string) {
  const route = path.split('?')[0];
  return route === '/assets/settings' || route.startsWith('/positions/') || route === '/markets/refresh'
    || route === '/quote' || route.startsWith('/quote/') || route.startsWith('/paper/')
    || route.startsWith('/hedge/') && route !== '/hedge/pause-all';
}

export async function api<T = unknown>(path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> | undefined = body === undefined ? undefined : { 'Content-Type': 'application/json' };
  if (headers && displayedUnderlying && isAssetMutation(path)) headers['X-Deltaform-Underlying'] = displayedUnderlying;
  const response = await fetch(`/api${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const content = await response.json().catch(() => { throw new Error(`Server returned an unreadable response (HTTP ${response.status}). Refresh the connection and reconcile pending orders.`); });
  if (!response.ok) throw new Error(content.error || content.message || `Request failed (${response.status})`);
  return content as T;
}

export const fmt = (value: number | null | undefined, digits = 2) => value == null || !Number.isFinite(value) ? '—' : new Intl.NumberFormat('en-US', { maximumFractionDigits: digits, minimumFractionDigits: digits }).format(value);
export const usd = (value: number | null | undefined, digits = 2) => value == null || !Number.isFinite(value) ? '—' : `${value < 0 ? '−' : ''}$${fmt(Math.abs(value), digits)}`;
export const signed = (value: number, digits = 2) => `${value > 0 ? '+' : ''}${fmt(value, digits)}`;
export const shortAddress = (address: string) => `${address.slice(0, 5)}…${address.slice(-4)}`;
export const timestamp = (value: number | null | undefined) => value ? new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—';
export const expiryLabel = (value: number) => new Date(value).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' });
