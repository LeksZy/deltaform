import { getWallets, type Wallets } from '@wallet-standard/app';
import type { Wallet, WalletAccount, WalletWithFeatures } from '@wallet-standard/base';
import { StandardConnect, type StandardConnectFeature } from '@wallet-standard/features';
import { SolanaSignMessage, type SolanaSignMessageFeature } from '@solana/wallet-standard-features';

type SigningWallet = WalletWithFeatures<StandardConnectFeature & SolanaSignMessageFeature>;
export interface LegacySolanaProvider {
  name?: string; isPhantom?: boolean; isSolflare?: boolean;
  publicKey?: { toString(): string } | null;
  connect(): Promise<{ publicKey?: { toString(): string } }>;
  signMessage(message: Uint8Array, encoding: string): Promise<{ signature: Uint8Array } | Uint8Array>;
}
export interface SolanaWalletChoice {
  id: string; name: string; kind: 'standard' | 'legacy';
  wallet?: SigningWallet; provider?: LegacySolanaProvider;
}
export interface SolanaConnection {
  address: string; walletName: string;
  signMessage(message: string): Promise<string>;
}
const walletIds = new WeakMap<object, string>();
let nextId = 0;
function idFor(wallet: object) {
  let id = walletIds.get(wallet);
  if (!id) { id = `solana-wallet-${++nextId}`; walletIds.set(wallet, id); }
  return id;
}
export function supportsSolanaSigning(wallet: Wallet): wallet is SigningWallet {
  const connect = wallet.features[StandardConnect] as StandardConnectFeature[typeof StandardConnect] | undefined;
  const sign = wallet.features[SolanaSignMessage] as SolanaSignMessageFeature[typeof SolanaSignMessage] | undefined;
  return wallet.chains.includes('solana:mainnet') && typeof connect?.connect === 'function' && typeof sign?.signMessage === 'function';
}
export function discoverSolanaWallets(registry: Wallets = getWallets(), legacy?: LegacySolanaProvider): SolanaWalletChoice[] {
  const choices: SolanaWalletChoice[] = registry.get().filter(supportsSolanaSigning)
    .map(wallet => ({ id: idFor(wallet), name: wallet.name, kind: 'standard', wallet }));
  const provider = legacy ?? (typeof window === 'undefined' ? undefined : (window as unknown as { solana?: LegacySolanaProvider }).solana);
  if (provider && typeof provider.connect === 'function' && typeof provider.signMessage === 'function') {
    const name = provider.name || (provider.isPhantom ? 'Phantom' : provider.isSolflare ? 'Solflare' : 'Injected Solana wallet');
    // Prefer the standard implementation when the same known wallet also injects the legacy API.
    if (!choices.some(choice => choice.name.toLowerCase() === name.toLowerCase())) choices.push({ id: idFor(provider), name, kind: 'legacy', provider });
  }
  return choices.sort((a, b) => Number(b.name === 'Jupiter') - Number(a.name === 'Jupiter') || a.name.localeCompare(b.name));
}
export function watchSolanaWallets(onChange: (choices: SolanaWalletChoice[]) => void, registry: Wallets = getWallets()): () => void {
  const refresh = () => onChange(discoverSolanaWallets(registry));
  const offRegister = registry.on('register', refresh), offUnregister = registry.on('unregister', refresh);
  if (typeof window !== 'undefined') window.addEventListener('focus', refresh);
  refresh();
  return () => { offRegister(); offUnregister(); if (typeof window !== 'undefined') window.removeEventListener('focus', refresh); };
}
function sameBytes(a: Uint8Array, b: Uint8Array) { return a.length === b.length && a.every((byte, i) => byte === b[i]); }
function base64Signature(signature: Uint8Array) {
  if (!(signature instanceof Uint8Array) || signature.length !== 64) throw new Error('Wallet returned an invalid Ed25519 message signature.');
  return btoa(Array.from(signature, byte => String.fromCharCode(byte)).join(''));
}
function supportsAccount(account: WalletAccount) {
  return account.chains.includes('solana:mainnet') && account.features.includes(SolanaSignMessage) && account.publicKey.length === 32;
}
export async function connectSolanaWallet(choice: SolanaWalletChoice): Promise<SolanaConnection> {
  if (choice.kind === 'standard' && choice.wallet) {
    const wallet = choice.wallet;
    const { accounts } = await wallet.features[StandardConnect].connect();
    const account = accounts.find(supportsAccount);
    if (!account) throw new Error(`${wallet.name} did not authorize a Solana mainnet account with message signing. Select your SOL account in the wallet and try again.`);
    const requireAccount = () => {
      if (!wallet.accounts.some(current => current.address === account.address && supportsAccount(current) && sameBytes(new Uint8Array(current.publicKey), new Uint8Array(account.publicKey)))) throw new Error('The wallet account changed or disconnected. Connect again before verifying ownership.');
    };
    return { address: account.address, walletName: wallet.name, signMessage: async message => {
      requireAccount();
      const bytes = new TextEncoder().encode(message);
      const outputs = await wallet.features[SolanaSignMessage].signMessage({ account, message: bytes });
      requireAccount();
      const output = outputs[0];
      if (!output || outputs.length !== 1 || !(output.signedMessage instanceof Uint8Array) || !sameBytes(output.signedMessage, bytes)) throw new Error('The wallet changed the ownership message. An exact message signature is required to connect.');
      if (output.signatureType && output.signatureType !== 'ed25519') throw new Error('The wallet returned an unsupported message signature type.');
      return base64Signature(output.signature);
    } };
  }
  if (choice.kind === 'legacy' && choice.provider) {
    const provider = choice.provider, connected = await provider.connect();
    const address = (connected.publicKey ?? provider.publicKey)?.toString();
    if (!address) throw new Error('The Solana wallet did not return an account.');
    const requireAccount = () => {
      if ('publicKey' in provider && provider.publicKey?.toString() !== address) throw new Error('The wallet account changed or disconnected. Connect again before verifying ownership.');
    };
    return { address, walletName: choice.name, signMessage: async message => {
      requireAccount();
      const output = await provider.signMessage(new TextEncoder().encode(message), 'utf8');
      requireAccount();
      return base64Signature(output instanceof Uint8Array ? output : output.signature);
    } };
  }
  throw new Error('This wallet is no longer available. Refresh the wallet list.');
}
