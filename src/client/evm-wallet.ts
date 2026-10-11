import { recoverTypedDataAddress, type Hex, type TypedDataDefinition } from 'viem';
import { assertWalletSigningDomain } from '../shared/eip712';

export interface EvmWalletProvider {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
}

function positiveChainId(value: unknown): number {
  const valid = typeof value === 'number' || (typeof value === 'string' && /^(?:0x[\da-f]+|\d+)$/i.test(value));
  const id = valid ? Number(value) : NaN;
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error('A valid signing chain ID is required. Refresh and review the request again.');
  return id;
}

export function typedDataChainId(typedData: unknown): number {
  if (!typedData || typeof typedData !== 'object' || !('domain' in typedData)) throw new Error('The signing request has no EIP-712 domain.');
  const domain = typedData.domain;
  if (!domain || typeof domain !== 'object' || !('chainId' in domain)) throw new Error('The signing request has no domain chain ID.');
  return positiveChainId(domain.chainId);
}

function chainLabel(chainId: number): string {
  const names: Record<number, string> = { 1: 'Ethereum', 957: 'Derive Chain', 901: 'Derive testnet', 11155111: 'Sepolia', 42161: 'Arbitrum One' };
  return `${names[chainId] || 'Chain'} (${chainId})`;
}

async function assertSigner(provider: EvmWalletProvider, signer: string, label: string): Promise<void> {
  if (!/^0x[\da-f]{40}$/i.test(signer)) throw new Error(`${label}: the verified signer address is invalid.`);
  const accounts = await provider.request({ method: 'eth_accounts' });
  if (!Array.isArray(accounts) || typeof accounts[0] !== 'string' || accounts[0].toLowerCase() !== signer.toLowerCase()) {
    throw new Error(`${label}: select the connected, verified signer account in your wallet and review again. The wallet account may have changed.`);
  }
}

/** Read again before/after each signature. A context change aborts the entire basket. */
export async function assertWalletContext(provider: EvmWalletProvider, signer: string, chainId: number, label: string): Promise<void> {
  const required = positiveChainId(chainId);
  if (positiveChainId(await provider.request({ method: 'eth_chainId' })) !== required) {
    throw new Error(`${label}: the wallet network changed. ${chainLabel(required)} is required; review the request again.`);
  }
  await assertSigner(provider, signer, label);
}

export async function ensureWalletContext(provider: EvmWalletProvider, signer: string, chainId: number, label: string): Promise<void> {
  const required = positiveChainId(chainId);
  await assertSigner(provider, signer, label);
  if (positiveChainId(await provider.request({ method: 'eth_chainId' })) !== required) {
    try {
      await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: `0x${required.toString(16)}` }] });
    } catch (error) {
      const code = Number((error as { code?: unknown } | null)?.code);
      if (code === 4001) throw new Error(`${label}: network switch rejected. Approve switching to ${chainLabel(required)} before signing.`);
      if (code === 4902) {
        throw new Error(`${label}: add ${chainLabel(required)} to your wallet using the official venue app, then retry. The wallet does not recognize this network.`);
      }
      throw new Error(`${label}: the wallet could not switch to ${chainLabel(required)}. Select that network in your wallet, then retry.`);
    }
  }
  // A successful switch response alone is not proof that the wallet's context is correct.
  await assertWalletContext(provider, signer, required, label);
}

export async function signTypedDataBatch(provider: EvmWalletProvider, signer: string, typedData: readonly unknown[], options: {
  label: string; expiresAt?: number;
}): Promise<string[]> {
  if (!typedData.length) throw new Error(`${options.label}: no signing requests were prepared.`);
  const chains = typedData.map(typedDataChainId);
  const required = chains[0]!;
  if (chains.some(chain => chain !== required)) throw new Error(`${options.label}: signing requests span different chains. Refresh and review the request again.`);
  typedData.forEach(assertWalletSigningDomain);
  // Preserve the exact server-provided domain and payload; never replace it with the wallet's chain.
  const payloads = typedData.map(data => JSON.stringify(data));
  const assertDeadline = () => {
    if (options.expiresAt !== undefined && (!Number.isFinite(options.expiresAt) || Date.now() >= options.expiresAt)) {
      throw new Error(`${options.label}: purchase review expired during network selection or signing. Refresh the quote; no orders have been submitted.`);
    }
  };
  assertDeadline();
  await ensureWalletContext(provider, signer, required, options.label);
  const signatures: string[] = [];
  for (const payload of payloads) {
    await assertWalletContext(provider, signer, required, options.label);
    assertDeadline();
    const signature = await provider.request({ method: 'eth_signTypedData_v4', params: [signer, payload] });
    if (typeof signature !== 'string' || !/^0x[\da-f]{130}$/i.test(signature)) throw new Error(`${options.label}: the wallet returned an invalid signature.`);
    const recovered = await recoverTypedDataAddress({ ...JSON.parse(payload) as TypedDataDefinition, signature: signature as Hex });
    if (recovered.toLowerCase() !== signer.toLowerCase()) throw new Error(`${options.label}: wallet signature does not verify for the reviewed signer. Refresh the page and quote again; no orders have been submitted.`);
    await assertWalletContext(provider, signer, required, options.label);
    assertDeadline();
    signatures.push(signature);
  }
  return signatures;
}
