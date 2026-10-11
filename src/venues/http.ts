export interface VenueHttpDetails {
  /** Normalized media type, never arbitrary header contents. */
  contentType?: string;
  code?: number | string;
  /** Canonical allowlisted wording only; raw response messages are never retained. */
  message?: string;
}
export class VenueError extends Error {
  constructor(public venue: string, message: string, public status?: number, public ambiguous = false, public details?: VenueHttpDetails) {
    super(`${venue}: ${message}`); this.name = 'VenueError';
  }
}

const MAX_ERROR_JSON_BYTES = 8 * 1024;
const SAFE_ERROR_CODES = new Set(['restricted_region', 'access_restricted', 'region_restricted', 'unauthorized',
  'authentication_failed', 'invalid_signature', 'signature_expired', 'invalid_api_key', 'invalid_session_key',
  'session_key_expired', 'forbidden', 'permission_denied', 'rate_limited', 'too_many_requests', 'service_unavailable']);
const SAFE_ERROR_MESSAGES = new Map([
  ['account not found', 'Account not found'], ['unauthorized', 'Unauthorized'], ['forbidden', 'Forbidden'],
  ['invalid signature', 'Invalid signature'], ['invalid authentication signature', 'Invalid authentication signature'],
  ['authentication failed', 'Authentication failed'], ['invalid api key', 'Invalid API key'], ['signature expired', 'Signature expired'],
  ['invalid timestamp', 'Invalid timestamp'], ['invalid session key', 'Invalid session key'], ['session key not found', 'Session key not found'],
  ['session key expired', 'Session key expired'], ['restricted region', 'Restricted region'], ['access restricted', 'Access restricted'],
  ['region not supported', 'Region not supported'], ['too many requests', 'Too many requests'], ['rate limit exceeded', 'Rate limit exceeded'],
  ['internal server error', 'Internal server error'], ['service unavailable', 'Service unavailable'], ['request timed out', 'Request timed out'],
]);
function safeErrorCode(value: unknown): number | string | undefined {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
  if (typeof value === 'string' && value.length <= 48 && SAFE_ERROR_CODES.has(value.toLowerCase())) return value.toLowerCase();
}
function safeErrorMessage(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 256) return;
  // Exact allowlisting also excludes appended signatures, private keys and credentials.
  return SAFE_ERROR_MESSAGES.get(value.trim().toLowerCase().replace(/\s+/g, ' ').replace(/[.!]+$/, ''));
}
function normalizedContentType(response: Response): string | undefined {
  const raw = response.headers?.get?.('content-type');
  if (!raw) return;
  const mediaType = raw.split(';', 1)[0]!.trim().toLowerCase();
  if (['application/json', 'application/problem+json', 'text/html', 'text/plain', 'application/octet-stream'].includes(mediaType)) return mediaType;
  // Recognize structured JSON without retaining an arbitrary vendor subtype from a header.
  if (/^application\/[a-z0-9][a-z0-9.+-]*\+json$/.test(mediaType) && mediaType.length <= 80) return 'application/*+json';
}
async function discardErrorBody(response: Response) {
  try { await response.body?.cancel?.(); } catch { /* Optional diagnostics never override the HTTP status. */ }
}
async function errorDetails(response: Response): Promise<VenueHttpDetails> {
  const contentType = normalizedContentType(response), details: VenueHttpDetails = { ...(contentType ? { contentType } : {}) };
  if (!contentType || !(contentType === 'application/json' || contentType.endsWith('+json'))) { await discardErrorBody(response); return details; }
  const length = response.headers?.get?.('content-length');
  if (length && /^\d+$/.test(length) && Number(length) > MAX_ERROR_JSON_BYTES) { await discardErrorBody(response); return details; }
  // Actual Fetch responses supply a stream. Do not fall back to unbounded text()/json() reads.
  if (!response.body?.getReader) return details;
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      total += item.value.byteLength;
      if (total > MAX_ERROR_JSON_BYTES) { await reader.cancel(); return details; }
      chunks.push(item.value);
    }
    const bytes = new Uint8Array(total); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const parsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return details;
    const root = parsed as Record<string, unknown>;
    const error = root.error && typeof root.error === 'object' && !Array.isArray(root.error) ? root.error as Record<string, unknown> : undefined;
    const code = safeErrorCode(error?.code) ?? safeErrorCode(root.code);
    const message = safeErrorMessage(error?.message) ?? safeErrorMessage(root.message);
    if (code !== undefined) details.code = code;
    if (message !== undefined) details.message = message;
  } catch {
    // The HTTP status remains authoritative when its optional diagnostic body is unavailable.
  } finally { reader.releaseLock(); }
  return details;
}
function httpErrorMessage(venue: string, status: number, details: VenueHttpDetails): string {
  const code = details.code === undefined ? '' : ` (venue code ${details.code})`;
  const message = details.message ? ` ${details.message}.` : '';
  const accessPolicy = ['restricted_region', 'access_restricted', 'region_restricted'].includes(String(details.code))
    || (venue.toLowerCase() === 'derive' && details.code === 16000)
    || ['Restricted region', 'Access restricted', 'Region not supported'].includes(details.message ?? '');
  if (accessPolicy) return `HTTP ${status}${code}; the venue reports an access policy restriction.${message} Check venue access requirements or contact venue support.`;
  if (status === 401) return `HTTP 401${code}; authentication was rejected.${message} Re-authenticate with the supported venue signing flow.`;
  if (status === 403) return `HTTP 403${code}; venue access was denied.${message} Without a recognized venue access code, this response cannot distinguish authentication failure from an access policy or edge-service rejection.`;
  return `HTTP ${status}${code}; venue access or service unavailable.${message}`;
}

/** Single attempt: mutations MUST reconcile after timeouts, never retry blindly. */
export async function jsonRequest<T>(venue: string, url: string, body?: unknown, headers: Record<string, string> = {}, timeoutMs = 15_000): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, { method: body === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(timeoutMs) });
  } catch {
    throw new VenueError(venue, 'request failed or timed out; reconcile before any order retry', undefined, true);
  }
  if (!response.ok) {
    const details = await errorDetails(response);
    throw new VenueError(venue, httpErrorMessage(venue, response.status, details), response.status,
      response.status >= 500 || response.status === 408, details);
  }
  try { return await response.json() as T; }
  catch { throw new VenueError(venue, 'response was not valid JSON', response.status, true); }
}
export function finite(value: unknown, label: string): number {
  const n = Number(value);
  if (value === null || value === undefined || value === '' || !Number.isFinite(n)) throw new Error(`Invalid ${label}`);
  return n;
}
export function positive(value: unknown, label: string): number {
  const n = finite(value, label); if (n <= 0) throw new Error(`Nonpositive ${label}`); return n;
}
