import { createPublicClient, getAddress, http, isAddress, parseAbi } from 'viem';
import { deriveConfig } from './derive.js';
import { VenueError } from './http.js';

export interface DeriveSignerAccess {
  wallet: string;
  signer: string;
  version: 'v2' | 'v3';
  network: 'mainnet' | 'testnet';
  checkedAt: number;
  onchainActionPermission: 'direct-owner' | 'active' | 'expired' | 'unregistered' | 'not-checked';
  expirySec: number | null;
  message: string;
}

const MATCHING = {
  mainnet: '0xeB8d770ec18DB98Db922E9D83260A585b9F0DeAD',
  testnet: '0x3cc154e220c2197c5337b7Bd13363DD127Bc0C6E',
} as const;
const ABI = parseAbi(['function sessionKeys(address signer,address owner) view returns (uint256)']);
const SCOPE = 'This checks on-chain action permission only. It does not establish HTTP authentication, off-chain read_only scope, or account registration. A missing on-chain key does not rule out a valid off-chain read-only session.';

/** Public RPC reads only: never signs, authenticates, registers keys, or sends transactions. */
export async function checkDeriveSignerAccess(wallet: string, signer: string): Promise<DeriveSignerAccess> {
  if (!isAddress(wallet) || !isAddress(signer)) throw new VenueError('Derive', 'Valid account wallet and signer addresses are required');
  const config = deriveConfig();
  const base: DeriveSignerAccess = { wallet: getAddress(wallet), signer: getAddress(signer),
    version: config.version, network: config.network, checkedAt: Date.now(),
    onchainActionPermission: 'not-checked', expirySec: null, message: '' };
  if (base.wallet === base.signer) return { ...base, onchainActionPermission: 'direct-owner',
    message: `The supplied signer is the account owner address. This is address equality, not verification of a signature or an existing Derive account. ${SCOPE}` };
  if (config.version !== 'v2') return { ...base,
    message: `This public permission check supports Derive v2 only. For v3, verify the selected owner's delegated signer and required API/session permissions. ${SCOPE}` };
  const rpcUrl = process.env.DERIVE_RPC_URL || (config.network === 'mainnet' ? 'https://rpc.lyra.finance' : null);
  if (!rpcUrl) return { ...base,
    message: `Set DERIVE_RPC_URL to a verified Derive v2 testnet RPC on chain 901, or inspect this signer's permission in Derive. No testnet RPC is assumed. ${SCOPE}` };
  try {
    const client = createPublicClient({ transport: http(rpcUrl, { timeout: 10_000, retryCount: 0 }) });
    const chainId = await client.getChainId();
    if (chainId !== config.chainId) throw new VenueError('Derive', `RPC chain ${chainId} does not match the selected network's chain ${config.chainId}`);
    const block = await client.getBlock({ blockTag: 'latest' });
    if (block.number === null || block.timestamp <= 0n) throw new VenueError('Derive', 'RPC did not return a mined block with a valid timestamp');
    const address = MATCHING[config.network];
    const code = await client.getBytecode({ address, blockNumber: block.number });
    if (!code || code === '0x') throw new VenueError('Derive', 'Matching contract is unavailable at the verified address');
    const expiry = await client.readContract({ address, abi: ABI, functionName: 'sessionKeys',
      args: [base.signer as `0x${string}`, base.wallet as `0x${string}`], blockNumber: block.number });
    if (typeof expiry !== 'bigint' || expiry < 0n) throw new VenueError('Derive', 'Matching returned an invalid session-key expiry');
    // ActionVerifier rejects expiry < block.timestamp; equality remains valid in that block.
    const status = expiry === 0n ? 'unregistered' : expiry < block.timestamp ? 'expired' : 'active';
    const expirySec = expiry <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(expiry) : null;
    const statusText = status === 'unregistered'
      ? 'Matching has no on-chain action authorization for this signer and account wallet.'
      : status === 'expired' ? 'The on-chain action authorization has expired.'
        : 'The on-chain action authorization is active at the checked block; it can expire or be revoked before execution.';
    return { ...base, checkedAt: Date.now(), onchainActionPermission: status, expirySec,
      message: `${statusText} Checked block ${block.number.toString()} at timestamp ${block.timestamp.toString()} seconds.${expirySec === null ? ' The expiry exceeds the precise numeric range of this interface.' : ''} ${SCOPE}` };
  } catch (error) {
    // Viem errors may contain the configured RPC URL, including an API token.
    const reason = error instanceof VenueError ? error.message : 'RPC request failed or returned incompatible data';
    return { ...base, checkedAt: Date.now(),
      message: `On-chain permission could not be checked: ${reason}. ${SCOPE}` };
  }
}
