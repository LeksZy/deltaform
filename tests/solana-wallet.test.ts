import { generateKeyPairSync, sign, verify } from 'node:crypto';
import { PublicKey } from '@solana/web3.js';
import type { Wallet, WalletAccount, WalletWithFeatures } from '@wallet-standard/base';
import type { Wallets } from '@wallet-standard/app';
import type { StandardConnectFeature } from '@wallet-standard/features';
import type { SolanaSignMessageFeature, SolanaSignMessageOutput } from '@solana/wallet-standard-features';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { connectSolanaWallet, discoverSolanaWallets, supportsSolanaSigning, watchSolanaWallets, type LegacySolanaProvider } from '../src/client/solana-wallet';
import { WalletAuth } from '../server/auth';
import { Store } from '../server/store';

type TestWallet = WalletWithFeatures<StandardConnectFeature & SolanaSignMessageFeature>;
const account = (overrides: Partial<WalletAccount> = {}): WalletAccount => ({
  address: '11111111111111111111111111111111', publicKey: new Uint8Array(32),
  chains: ['solana:mainnet'], features: ['solana:signMessage'], ...overrides,
});
function wallet(name = 'Jupiter', initialAccounts: readonly WalletAccount[] = [account()]) {
  let accounts = initialAccounts;
  const connect = vi.fn(async () => ({ accounts }));
  const signMessage = vi.fn(async (...inputs: { account: WalletAccount; message: Uint8Array }[]) => inputs.map(input => ({
    signedMessage: input.message, signature: Uint8Array.from({ length: 64 }, (_, i) => i),
    signatureType: 'ed25519' as const,
  })));
  const standard: TestWallet = {
    version: '1.0.0', name, icon: 'data:image/png;base64,AA==', chains: ['solana:mainnet'],
    features: { 'standard:connect': { version: '1.0.0', connect }, 'solana:signMessage': { version: '1.1.0', signMessage } },
    get accounts() { return accounts; },
  };
  return { standard, connect, signMessage, setAccounts(next: readonly WalletAccount[]) { accounts = next; } };
}
function registry(initial: readonly Wallet[] = []) {
  let wallets = [...initial];
  const listeners = { register: new Set<(...wallets: Wallet[]) => void>(), unregister: new Set<(...wallets: Wallet[]) => void>() };
  const api: Wallets = {
    get: () => wallets,
    on: (event, listener) => { listeners[event].add(listener); return () => { listeners[event].delete(listener); }; },
    register: (...added) => {
      wallets.push(...added); listeners.register.forEach(fn => fn(...added));
      return () => { wallets = wallets.filter(w => !added.includes(w)); listeners.unregister.forEach(fn => fn(...added)); };
    },
  };
  return { api, listeners };
}
function legacy(name = 'Phantom') {
  const provider: LegacySolanaProvider = {
    name, publicKey: { toString: () => '11111111111111111111111111111111' },
    connect: vi.fn(async () => ({ publicKey: provider.publicKey ?? undefined })),
    signMessage: vi.fn(async () => ({ signature: new Uint8Array(64).fill(255) })),
  };
  return provider;
}
function choice(standard: TestWallet) { return discoverSolanaWallets(registry([standard]).api)[0]!; }
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('Solana wallet discovery', () => {
  it('finds Jupiter through Wallet Standard without a window.solana injection', () => {
    vi.stubGlobal('window', new EventTarget());
    const jupiter = wallet('Jupiter').standard, phantom = wallet('Phantom').standard;
    const found = discoverSolanaWallets(registry([phantom, jupiter]).api);
    expect(found.map(w => [w.name, w.kind])).toEqual([['Jupiter', 'standard'], ['Phantom', 'standard']]);
    expect(found[0]!.wallet).toBe(jupiter);
    expect(discoverSolanaWallets(registry([jupiter]).api)[0]!.id).toBe(found[0]!.id);
  });
  it('filters wallets on incompatible chains and without usable connect or sign features', () => {
    const valid = wallet().standard;
    const testnet: Wallet = { ...valid, name: 'Testnet', chains: ['solana:devnet'] };
    const ethereum: Wallet = { ...valid, name: 'EVM', chains: ['eip155:1'] };
    const noConnect: Wallet = { ...valid, name: 'No connect', features: { 'solana:signMessage': valid.features['solana:signMessage'] } };
    const noSign: Wallet = { ...valid, name: 'No sign', features: { 'standard:connect': valid.features['standard:connect'] } };
    const malformed: Wallet = { ...valid, name: 'Malformed', features: { 'standard:connect': {}, 'solana:signMessage': {} } };
    expect([testnet, ethereum, noConnect, noSign, malformed].map(supportsSolanaSigning)).toEqual([false, false, false, false, false]);
    expect(discoverSolanaWallets(registry([testnet, ethereum, noConnect, noSign, malformed, valid]).api).map(w => w.name)).toEqual(['Jupiter']);
  });
  it('prefers the standard adapter over duplicate case-insensitive legacy wallet names', () => {
    const standard = wallet('Phantom').standard;
    const found = discoverSolanaWallets(registry([standard]).api, legacy('phantom'));
    expect(found).toHaveLength(1); expect(found[0]!.kind).toBe('standard');
  });
  it('discovers a usable legacy window provider and omits providers without message signing', () => {
    const provider = legacy();
    vi.stubGlobal('window', Object.assign(new EventTarget(), { solana: provider }));
    expect(discoverSolanaWallets(registry().api)).toMatchObject([{ name: 'Phantom', kind: 'legacy', provider }]);
    expect(discoverSolanaWallets(registry().api, { ...provider, signMessage: undefined } as unknown as LegacySolanaProvider)).toEqual([]);
  });
  it('updates for later registration, unregistration and focus, then removes listeners', () => {
    const browser = new EventTarget(), add = vi.spyOn(browser, 'addEventListener'), remove = vi.spyOn(browser, 'removeEventListener');
    vi.stubGlobal('window', browser);
    const catalog = registry(), change = vi.fn();
    const stop = watchSolanaWallets(change, catalog.api);
    expect(change).toHaveBeenLastCalledWith([]);
    const unregister = catalog.api.register(wallet().standard);
    expect(change.mock.lastCall![0].map((w: { name: string }) => w.name)).toEqual(['Jupiter']);
    unregister(); expect(change).toHaveBeenLastCalledWith([]);
    browser.dispatchEvent(new Event('focus')); expect(change).toHaveBeenCalledTimes(4);
    stop();
    expect(catalog.listeners.register.size).toBe(0); expect(catalog.listeners.unregister.size).toBe(0);
    expect(remove).toHaveBeenCalledWith('focus', add.mock.calls[0]![1]);
    catalog.api.register(wallet().standard); browser.dispatchEvent(new Event('focus'));
    expect(change).toHaveBeenCalledTimes(4);
  });
});

describe('Wallet Standard ownership signing', () => {
  it('selects a usable mainnet account and signs exact UTF-8 bytes as base64 Ed25519', async () => {
    const authorized = account({ address: 'authorized', publicKey: new Uint8Array(32).fill(7) });
    const fixture = wallet('Jupiter', [account({ chains: ['solana:devnet'] }), account({ features: [] }), authorized]);
    const connected = await connectSolanaWallet(choice(fixture.standard));
    expect(connected.address).toBe('authorized'); expect(connected.walletName).toBe('Jupiter');
    expect(await connected.signMessage('Verify SOL ownership: α')).toBe(Buffer.from(Array.from({ length: 64 }, (_, i) => i)).toString('base64'));
    expect(fixture.connect).toHaveBeenCalledTimes(1);
    expect(fixture.signMessage).toHaveBeenCalledWith({ account: authorized, message: new TextEncoder().encode('Verify SOL ownership: α') });
  });
  it.each([
    { reason: 'empty accounts', accounts: [] },
    { reason: 'testnet only', accounts: [account({ chains: ['solana:testnet'] })] },
    { reason: 'missing signing', accounts: [account({ features: [] })] },
    { reason: 'invalid public key length', accounts: [account({ publicKey: new Uint8Array(31) })] },
  ])('rejects connect output with $reason', async ({ accounts }) => {
    await expect(connectSolanaWallet(choice(wallet('Jupiter', accounts).standard))).rejects.toThrow('did not authorize a Solana mainnet account');
  });
  it('rejects account changes or disconnects before signing, without prompting the old account', async () => {
    for (const replacement of [[], [account({ address: 'other' })], [account({ publicKey: new Uint8Array(32).fill(4) })]]) {
      const fixture = wallet(), connected = await connectSolanaWallet(choice(fixture.standard));
      fixture.setAccounts(replacement);
      await expect(connected.signMessage('challenge')).rejects.toThrow('account changed or disconnected');
      expect(fixture.signMessage).not.toHaveBeenCalled();
    }
  });
  it('rejects an account change while the wallet prompt is open', async () => {
    const fixture = wallet(), connected = await connectSolanaWallet(choice(fixture.standard));
    fixture.signMessage.mockImplementationOnce(async input => {
      fixture.setAccounts([account({ address: 'other' })]);
      return [{ signedMessage: input.message, signature: new Uint8Array(64), signatureType: 'ed25519' }];
    });
    await expect(connected.signMessage('challenge')).rejects.toThrow('account changed or disconnected');
  });
  it('rejects wallet-modified signed messages rather than sending the server an invalid signature', async () => {
    const fixture = wallet(), connected = await connectSolanaWallet(choice(fixture.standard));
    fixture.signMessage.mockResolvedValueOnce([{ signedMessage: new TextEncoder().encode('prefixed challenge'), signature: new Uint8Array(64), signatureType: 'ed25519' }]);
    await expect(connected.signMessage('challenge')).rejects.toThrow('changed the ownership message');
  });
  it('reports an actionable error when a wallet omits signedMessage', async () => {
    const fixture = wallet(), connected = await connectSolanaWallet(choice(fixture.standard));
    fixture.signMessage.mockResolvedValueOnce([{ signature: new Uint8Array(64), signatureType: 'ed25519' }] as unknown as Awaited<ReturnType<typeof fixture.signMessage>>);
    await expect(connected.signMessage('challenge')).rejects.toThrow('changed the ownership message');
  });
  it('rejects missing or extra outputs, malformed signature sizes and unsupported signature types', async () => {
    const message = new TextEncoder().encode('challenge');
    const output = { signedMessage: message, signature: new Uint8Array(64), signatureType: 'ed25519' as const };
    const badOutputs: SolanaSignMessageOutput[][] = [[], [output, output], [{ ...output, signature: new Uint8Array(63) }], [{ ...output, signatureType: 'ecdsa' as 'ed25519' }]];
    for (const outputs of badOutputs) {
      const fixture = wallet(), connected = await connectSolanaWallet(choice(fixture.standard));
      fixture.signMessage.mockResolvedValueOnce(outputs as ReturnType<typeof fixture.signMessage> extends Promise<infer O> ? O : never);
      await expect(connected.signMessage('challenge')).rejects.toThrow();
    }
  });
  it('propagates rejected connect and sign requests without fallback prompts', async () => {
    const fixture = wallet(); fixture.connect.mockRejectedValueOnce(new Error('User rejected connect'));
    await expect(connectSolanaWallet(choice(fixture.standard))).rejects.toThrow('User rejected connect');
    expect(fixture.signMessage).not.toHaveBeenCalled();
    const connected = await connectSolanaWallet(choice(fixture.standard));
    fixture.signMessage.mockRejectedValueOnce(new Error('User rejected sign'));
    await expect(connected.signMessage('challenge')).rejects.toThrow('User rejected sign');
    expect(fixture.connect).toHaveBeenCalledTimes(2); expect(fixture.signMessage).toHaveBeenCalledTimes(1);
  });
  it('produces a real Node-verified signature accepted once by the backend ownership challenge', async () => {
    const keys = generateKeyPairSync('ed25519');
    const raw = new Uint8Array(keys.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32));
    const owned = account({ address: new PublicKey(raw).toBase58(), publicKey: raw });
    const fixture = wallet('Jupiter', [owned]);
    fixture.signMessage.mockImplementation(async input => [{
      signedMessage: input.message, signature: new Uint8Array(sign(null, input.message, keys.privateKey)), signatureType: 'ed25519',
    }]);
    const store = new Store(':memory:');
    try {
      const auth = new WalletAuth(store), connected = await connectSolanaWallet(choice(fixture.standard));
      const challenge = auth.challenge('meteora', connected.address);
      const signature = await connected.signMessage(challenge.message);
      expect(verify(null, Buffer.from(challenge.message), keys.publicKey, Buffer.from(signature, 'base64'))).toBe(true);
      await expect(auth.verify('meteora', connected.address, challenge.challengeId, signature)).resolves.toBeUndefined();
      await expect(auth.verify('meteora', connected.address, challenge.challengeId, signature)).rejects.toThrow('missing, expired');
    } finally { store.close(); }
  });
});

describe('legacy ownership signing', () => {
  it('supports publicKey fallback and both legacy signature output shapes', async () => {
    const provider = legacy(), message = 'ownership';
    vi.mocked(provider.connect).mockResolvedValueOnce({});
    const connected = await connectSolanaWallet(discoverSolanaWallets(registry().api, provider)[0]!);
    expect(connected.address).toBe(provider.publicKey!.toString());
    expect(await connected.signMessage(message)).toBe(Buffer.alloc(64, 255).toString('base64'));
    expect(provider.signMessage).toHaveBeenLastCalledWith(new TextEncoder().encode(message), 'utf8');
    vi.mocked(provider.signMessage).mockResolvedValueOnce(new Uint8Array(64).fill(4));
    expect(await connected.signMessage(message)).toBe(Buffer.alloc(64, 4).toString('base64'));
  });
  it('rejects legacy account changes before and during the signature prompt', async () => {
    const provider = legacy(), connected = await connectSolanaWallet(discoverSolanaWallets(registry().api, provider)[0]!);
    provider.publicKey = { toString: () => 'changed' };
    await expect(connected.signMessage('challenge')).rejects.toThrow('account changed');
    expect(provider.signMessage).not.toHaveBeenCalled();
    provider.publicKey = { toString: () => connected.address };
    vi.mocked(provider.signMessage).mockImplementationOnce(async () => {
      provider.publicKey = { toString: () => 'changed' }; return { signature: new Uint8Array(64) };
    });
    await expect(connected.signMessage('challenge')).rejects.toThrow('account changed');
  });
  it('rejects an explicit legacy disconnect before signing without requesting a signature', async () => {
    const provider = legacy(), connected = await connectSolanaWallet(discoverSolanaWallets(registry().api, provider)[0]!);
    provider.publicKey = null;
    await expect(connected.signMessage('challenge')).rejects.toThrow('account changed');
    expect(provider.signMessage).not.toHaveBeenCalled();
  });
  it('rejects an explicit legacy disconnect while the signature prompt is open', async () => {
    const provider = legacy(), connected = await connectSolanaWallet(discoverSolanaWallets(registry().api, provider)[0]!);
    vi.mocked(provider.signMessage).mockImplementationOnce(async () => {
      provider.publicKey = null; return { signature: new Uint8Array(64) };
    });
    await expect(connected.signMessage('challenge')).rejects.toThrow('account changed');
    expect(provider.signMessage).toHaveBeenCalledTimes(1);
  });
  it('rejects an unavailable choice or a legacy provider returning no account', async () => {
    await expect(connectSolanaWallet({ id: 'removed', name: 'Jupiter', kind: 'standard' })).rejects.toThrow('no longer available');
    const provider = legacy(); provider.publicKey = null;
    await expect(connectSolanaWallet(discoverSolanaWallets(registry().api, provider)[0]!)).rejects.toThrow('did not return an account');
  });
});
