import { afterEach, describe, expect, it, vi } from 'vitest';
import { assetFitPayload, gammaTolerance, gammaToleranceCash, gammaToleranceFromCash } from '../src/client/asset-settings';
import { api, setApiUnderlying } from '../src/client/api';
import type { FitSettings } from '../src/shared/types';

const settings: FitSettings = { expiry: 1800000000000, coverage: 1, budget: 100, maxLegs: 4, objective: 'gamma', maxUndercoverage: null };
const model = { expiry: 0, ivMode: 'market' as const, ivPercent: 70, daysAhead: 0 };
afterEach(() => { vi.unstubAllGlobals(); setApiUnderlying(null); });

describe('asset-aware gamma configuration', () => {
  it('makes the initial gamma tolerance worth exactly $1 for a 1% move for all eight assets', () => {
    for (const spot of [84000, 2700, 120, 4100, 88, 1.5, .66, .095]) {
      const result = assetFitPayload(settings, model, spot);
      // Independently calculate the second-order cash contribution, avoiding a raw-unit constant.
      expect(.5 * result.gamma!.tolerance * (spot * .01) ** 2).toBeCloseTo(1, 12);
      expect(gammaToleranceCash(spot, result.gamma!.tolerance)).toBeCloseTo(1, 12);
    }
  });
  it('preserves explicitly saved raw tolerances across changes in asset price and model', () => {
    for (const tolerance of [0, .01, 2e6]) {
      const saved = { ...settings, gamma: { ...model, tolerance } };
      const changed = { expiry: settings.expiry, ivMode: 'manual' as const, ivPercent: 55, daysAhead: 2 };
      const result = assetFitPayload(saved, changed, 90000);
      expect(result.gamma).toEqual({ expiry: settings.expiry, ivMode: 'manual', ivPercent: 55, tolerance });
      expect(saved.gamma.tolerance).toBe(tolerance);
      expect(gammaTolerance(saved, .09)).toBe(tolerance);
    }
  });
  it('translates an edited cash limit to raw gamma and rejects missing or invalid units', () => {
    expect(gammaToleranceFromCash(200, 2)).toBe(1);
    expect(gammaToleranceFromCash(200, 0)).toBe(0);
    expect(() => gammaToleranceFromCash(0)).toThrow('positive reference price');
    expect(() => gammaToleranceFromCash(200, -1)).toThrow('nonnegative');
    expect(assetFitPayload({ ...settings, objective: 'payoff' }, model, 0).gamma).toBeUndefined();
  });
});

describe('visible-asset request scope', () => {
  it('guards book mutations and leaves shared account actions unscoped', async () => {
    const fetcher = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetcher); setApiUnderlying('BTC');
    for (const path of ['/assets/settings', '/positions/select', '/markets/refresh', '/quote', '/quote/submit', '/paper/price', '/hedge/enable']) {
      await api(path, {});
      expect((fetcher.mock.calls.at(-1) as unknown as [string, RequestInit])[1].headers).toMatchObject({ 'X-Deltaform-Underlying': 'BTC' });
    }
    for (const path of ['/assets/select', '/mode', '/demo/multi', '/hedge/pause-all', '/portfolio/limits', '/accounts/connect', '/agent/approve', '/capital/start']) {
      await api(path, {});
      expect((fetcher.mock.calls.at(-1) as unknown as [string, RequestInit])[1].headers).not.toHaveProperty('X-Deltaform-Underlying');
    }
  });
  it('surfaces a cross-tab rejection and an ambiguous response without retrying the mutation', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ error: 'Selected underlying changed. Refresh before trading.' }), { status: 409 }));
    vi.stubGlobal('fetch', fetcher); setApiUnderlying('ETH');
    await expect(api('/hedge/enable', {})).rejects.toThrow('Selected underlying changed');
    expect(fetcher).toHaveBeenCalledTimes(1);
    fetcher.mockImplementation(async () => new Response('<html>Loading</html>', { status: 200 }));
    await expect(api('/quote/submit', {})).rejects.toThrow('reconcile pending orders');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
