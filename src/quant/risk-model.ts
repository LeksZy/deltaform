import type { OptionInstrument } from '../shared/types';
export interface LpModelSettings { expiry: number; ivMode: 'market' | 'manual'; ivPercent: number }
export function resolveLpModel(instruments: OptionInstrument[], spot: number, settings: LpModelSettings, fallbackExpiry: number, maxAge: number, now = Date.now(), underlying?: string) {
  const expiry = settings.expiry || fallbackExpiry;
  const asset = underlying ?? (new Set(instruments.map(i => i.underlying)).size === 1 ? instruments[0]?.underlying : undefined);
  const candidates = instruments.filter(i => asset !== undefined && i.underlying === asset && i.expiry === expiry && i.iv != null && i.iv > 0 && i.iv <= 5
    && now - i.timestamp <= maxAge && i.timestamp <= now + 5000)
    .sort((a,b) => Math.abs(a.strike-spot)-Math.abs(b.strike-spot));
  const iv = settings.ivMode === 'manual' ? settings.ivPercent/100 : candidates[0]?.iv ?? null;
  return { expiry, iv: iv != null && Number.isFinite(iv) && iv > 0 && iv <= 5 ? iv : null,
    ivSource: settings.ivMode === 'manual' ? 'Manual flat IV' : candidates[0] ? `${candidates[0].source === 'fixture' ? 'Fixture' : 'Bybit'} ATM IV · ${candidates[0].name}` : 'Market IV unavailable' };
}
