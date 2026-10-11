import { afterEach, describe, expect, it, vi } from 'vitest';
import { jsonRequest, VenueError } from '../src/venues/http';

const endpoint = 'https://venue.example.invalid/private/order';
function stub(response: Response | object) {
  const fetch = vi.fn(async () => response); vi.stubGlobal('fetch', fetch); return fetch;
}
function jsonError(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}
async function requestError() { return await jsonRequest('Derive', endpoint, { amount: '1' }).catch(error => error) as VenueError; }
afterEach(() => vi.unstubAllGlobals());

describe('bounded venue HTTP diagnostics', () => {
  it('recognizes explicit regional/policy venue codes from JSON without claiming authentication failed', async () => {
    for (const code of ['restricted_region', 16000]) {
      const fetch = stub(jsonError(403, { error: { code, message: 'Restricted region' } }));
      const error = await requestError();
      expect(error).toBeInstanceOf(VenueError); expect(error.status).toBe(403); expect(error.ambiguous).toBe(false);
      expect(error.details).toEqual({ contentType: 'application/json', code, message: 'Restricted region' });
      expect(error.message).toContain('venue reports an access policy restriction'); expect(fetch).toHaveBeenCalledTimes(1);
    }
  });
  it('does not read an HTML403 body and explains that its cause is not known', async () => {
    const secret = `0x${'a'.repeat(64)}`;
    const response = new Response(`<html>Forbidden; signature=${secret}; Authorization: Bearer private-token</html>`,
      { status: 403, headers: { 'Content-Type': 'text/html', 'X-Request-Id': secret, 'Set-Cookie': 'secret-session' } });
    const read = vi.spyOn(response.body!, 'getReader'), cancel = vi.spyOn(response.body!, 'cancel'), fetch = stub(response);
    const error = await requestError();
    expect(error.details).toEqual({ contentType: 'text/html' }); expect(read).not.toHaveBeenCalled(); expect(cancel).toHaveBeenCalledTimes(1);
    expect(error.message).toContain('cannot distinguish authentication failure'); expect(error.message).toContain('edge-service rejection');
    expect(error.message).not.toMatch(/geo.?block/i); expect(JSON.stringify(error)).not.toContain(secret); expect(error.message).not.toContain('private-token');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('uses root JSON error fields and offers re-authentication for401', async () => {
    stub(jsonError(401, { code: 'invalid_signature', message: 'Invalid authentication signature.' }));
    const error = await requestError();
    expect(error.details).toEqual({ contentType: 'application/json', code: 'invalid_signature', message: 'Invalid authentication signature' });
    expect(error.message).toContain('Re-authenticate'); expect(error.ambiguous).toBe(false);
  });
  it('suppresses arbitrary messages, signatures, credentials, error data and response headers', async () => {
    const signature = `0x${'b'.repeat(130)}`, key = `0x${'c'.repeat(64)}`;
    stub(jsonError(403, { error: { code: 'unauthorized', message: `Unauthorized; signature=${signature}; api_key=${key}; Authorization: Bearer secret-token`,
      data: { private_key: key, token: 'hidden-data-token' } } }, { 'X-Request-Id': key, 'Authorization': 'Bearer response-secret' }));
    const error = await requestError(), serialized = JSON.stringify(error);
    expect(error.details).toEqual({ contentType: 'application/json', code: 'unauthorized' });
    for (const secret of [signature, key, 'secret-token', 'hidden-data-token', 'response-secret']) {
      expect(error.message).not.toContain(secret); expect(serialized).not.toContain(secret);
    }
  });
  it('rejects arbitrary string codes while retaining integer codes for adapter-specific diagnostics', async () => {
    for (const code of ['arbitrary_unverified_cause', `0x${'d'.repeat(64)}`, 14000]) {
      stub(jsonError(403, { error: { code, message: 'Account not found' } }));
      const error = await requestError();
      expect(error.details?.code).toBe(typeof code === 'number' ? code : undefined);
      expect(error.details?.message).toBe('Account not found');
    }
  });
  it('canonicalizes structured JSON media types instead of retaining credential-like header subtypes', async () => {
    const secret = `0x${'e'.repeat(48)}`;
    stub(new Response(JSON.stringify({ code: 'unauthorized' }), { status: 403, headers: { 'Content-Type': `application/${secret}+json` } }));
    const error = await requestError();
    expect(error.details).toEqual({ contentType: 'application/*+json', code: 'unauthorized' });
    expect(JSON.stringify(error)).not.toContain(secret);
  });
  it('does not read a declared oversized JSON body', async () => {
    const response = jsonError(403, { error: { code: 16000 } }, { 'Content-Length': '9000' });
    const read = vi.spyOn(response.body!, 'getReader'), cancel = vi.spyOn(response.body!, 'cancel'); stub(response);
    const error = await requestError();
    expect(read).not.toHaveBeenCalled(); expect(cancel).toHaveBeenCalledTimes(1); expect(error.details?.code).toBeUndefined();
    expect(error.message).toContain('cannot distinguish');
  });
  it('accepts at most8KiB and cancels a stream that exceeds the byte limit without parsing a partial prefix', async () => {
    const prefix = JSON.stringify({ error: { code: 16000, message: 'Restricted region' } });
    for (const size of [8192, 8193]) {
      const cancel = vi.fn(), bytes = new TextEncoder().encode(prefix + ' '.repeat(size - prefix.length));
      const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes); }, cancel });
      // Complete the exact-limit stream; the oversized stream must be canceled while still open.
      if (size === 8192) {
        stub(new Response(bytes, { status: 403, headers: { 'Content-Type': 'application/problem+json' } }));
      } else stub(new Response(stream, { status: 403, headers: { 'Content-Type': 'application/json' } }));
      const error = await requestError();
      expect(error.details?.code).toBe(size === 8192 ? 16000 : undefined);
      expect(cancel).toHaveBeenCalledTimes(size === 8192 ? 0 : 1);
    }
  });
  it('preserves ambiguous500/408 order outcomes and never retries the request', async () => {
    for (const status of [500, 408]) {
      const fetch = stub(jsonError(status, { message: 'Internal server error' }));
      const error = await requestError();
      expect(error.status).toBe(status); expect(error.ambiguous).toBe(true); expect(fetch).toHaveBeenCalledTimes(1);
    }
  });
  it('keeps existing minimal error-response mocks functional without reading json()', async () => {
    const json = vi.fn(async () => ({ error: { code: 16000 } })); stub({ ok: false, status: 403, json });
    const error = await requestError();
    expect(error.status).toBe(403); expect(error.ambiguous).toBe(false); expect(error.details).toEqual({});
    expect(json).not.toHaveBeenCalled(); expect(error.message).toContain('cannot distinguish');
  });
  it('keeps malformed diagnostic JSON secondary to the received HTTP status', async () => {
    stub(new Response('{invalid-json', { status: 400, headers: { 'Content-Type': 'application/json' } }));
    const error = await requestError();
    expect(error.status).toBe(400); expect(error.ambiguous).toBe(false); expect(error.details).toEqual({ contentType: 'application/json' });
  });
  it('keeps network timeouts ambiguous with one attempt and preserves successful response shape', async () => {
    const fetch = vi.fn().mockRejectedValue(new Error('socket closed')); vi.stubGlobal('fetch', fetch);
    await expect(jsonRequest('Derive', endpoint, { amount: '1' })).rejects.toMatchObject({ ambiguous: true, status: undefined });
    expect(fetch).toHaveBeenCalledTimes(1);
    const body = { result: { positions: [{ amount: '2' }] } }; stub({ ok: true, status: 200, json: async () => body });
    await expect(jsonRequest('Derive', endpoint)).resolves.toBe(body);
  });
});
