import { createPublicClient, encodeFunctionData, formatEther, getAddress, http, isAddress, parseAbi, type Address, type Hex } from 'viem';
import { deriveConfig } from './derive.js';
import { VenueError } from './http.js';

const MATCHING = '0xeB8d770ec18DB98Db922E9D83260A585b9F0DeAD' as const;
const FACTORY = '0x000000893A26168158fbeaDD9335Be5bC96592E2' as const;
// Sources: alchemyplatform/light-account v1.0.1 src/LightAccount{,Factory}.sol;
// derivexyz/v2-matching src/ActionVerifier.sol and deployments/957/matching.json.
// Verified by the current Derive factory's accountImplementation(), and the
// official LightAccount v1.0.1 deployment. The app SDK's v1.1.0 label does not
// change which implementation this custom factory actually deploys.
const IMPLEMENTATION = '0xc1B2fC4197c9187853243E6e4eb5A4aF8879a1c0' as const;
const IMPLEMENTATION_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc' as const;
const LIGHT_ABI = parseAbi(['function owner() view returns (address)', 'function execute(address dest,uint256 value,bytes func)']);
const FACTORY_ABI = parseAbi(['function accountImplementation() view returns (address)']);
const MATCHING_ABI = parseAbi(['function sessionKeys(address signer,address owner) view returns (uint256)', 'function registerSessionKey(address sessionKey,uint256 expiry)']);

export interface DeriveSessionPreview {
  wallet: Address; signer: Address; version: 'v2'; network: 'mainnet'; chainId: 957; checkedAt: number;
  expirySec: number; currentExpirySec: number; implementation: Address; implementationVersion: '1.0.1';
  transaction: { from: Address; to: Address; value: '0x0'; data: Hex };
  gasEstimate: { gasUnits: string | null; gasPriceWei: string | null; estimatedCostWei: string | null;
    estimatedCostEth: string | null; nativeBalanceWei: string; nativeBalanceEth: string;
    sufficientNativeGas: boolean | null; error: string | null };
  readyToSubmit: boolean;
  warnings: string[];
}
export interface DeriveSessionConfirmation {
  status: 'confirmed' | 'pending'; txHash: Hex; checkedAt: number; expirySec: number | null; message: string;
}
/** Only a matched transaction and its consistent mined reverted receipt establish this outcome. */
export class DeriveSessionRevertedError extends VenueError {
  constructor() {
    super('Derive', 'The authorization transaction reverted; session authorization was not confirmed');
    this.name = 'DeriveSessionRevertedError';
  }
}
/** A matched successful transaction is final, but its expected current permission is no longer present. */
export class DeriveSessionInactiveError extends VenueError {
  constructor() {
    super('Derive', 'The transaction was mined successfully but the expected active session permission is absent, shortened or expired; no successful authorization is assumed. Review current permission before preparing a new authorization');
    this.name = 'DeriveSessionInactiveError';
  }
}

function fail(message: string): never { throw new VenueError('Derive', message); }
function publicClient() {
  const config = deriveConfig();
  if (config.version !== 'v2' || config.network !== 'mainnet') fail('Wallet session authorization is verified only for Derive v2 mainnet (chain 957)');
  return createPublicClient({ transport: http(process.env.DERIVE_RPC_URL || 'https://rpc.lyra.finance', { timeout: 10_000, retryCount: 0 }) });
}
function transaction(wallet: Address, signer: Address, expirySec: number): DeriveSessionPreview['transaction'] {
  const inner = encodeFunctionData({ abi: MATCHING_ABI, functionName: 'registerSessionKey', args: [signer, BigInt(expirySec)] });
  return { from: signer, to: wallet, value: '0x0', data: encodeFunctionData({ abi: LIGHT_ABI, functionName: 'execute', args: [MATCHING, 0n, inner] }) };
}
function safeExpiry(value: bigint): number {
  if (typeof value !== 'bigint' || value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) fail('On-chain session expiry is outside the supported exact integer range');
  return Number(value);
}
function validatePersistedPreview(preview: DeriveSessionPreview): DeriveSessionPreview['transaction'] {
  if (!preview || preview.version !== 'v2' || preview.network !== 'mainnet' || preview.chainId !== 957
    || !isAddress(preview.wallet) || !isAddress(preview.signer) || !Number.isSafeInteger(preview.expirySec) || preview.expirySec <= 0
    || preview.implementation !== IMPLEMENTATION || preview.implementationVersion !== '1.0.1'
    || !preview.transaction || !isAddress(preview.transaction.from) || !isAddress(preview.transaction.to)
    || typeof preview.transaction.data !== 'string') fail('Invalid persisted session preview');
  const wallet = getAddress(preview.wallet), signer = getAddress(preview.signer);
  if (wallet === signer) fail('This setup is for a deployed LightAccount owned by the connected EOA');
  const expected = transaction(wallet, signer, preview.expirySec);
  if (preview.transaction.from.toLowerCase() !== expected.from.toLowerCase() || preview.transaction.to.toLowerCase() !== expected.to.toLowerCase()
    || preview.transaction.value !== '0x0' || preview.transaction.data.toLowerCase() !== expected.data.toLowerCase()) fail('Persisted preview does not match the supported session authorization action');
  return expected;
}
async function inspectAccount(client: ReturnType<typeof publicClient>, ownerWallet: Address, ownerSigner: Address) {
  if (await client.getChainId() !== 957) fail('The configured RPC must be on Derive v2 mainnet chain 957');
  const block = await client.getBlock({ blockTag: 'latest' });
  if (block.number === null || block.timestamp <= 0n) fail('A mined block and valid on-chain timestamp are required');
  const addresses = [ownerWallet, FACTORY, MATCHING, IMPLEMENTATION] as const;
  const codes = await Promise.all(addresses.map(address => client.getBytecode({ address, blockNumber: block.number })));
  if (codes.some(code => !code || code === '0x')) fail('The account wallet, verified factory, implementation and Matching must already be deployed; this action does not deploy accounts');
  const [owner, factoryImplementation, slot, existing] = await Promise.all([
    client.readContract({ address: ownerWallet, abi: LIGHT_ABI, functionName: 'owner', blockNumber: block.number }),
    client.readContract({ address: FACTORY, abi: FACTORY_ABI, functionName: 'accountImplementation', blockNumber: block.number }),
    client.getStorageAt({ address: ownerWallet, slot: IMPLEMENTATION_SLOT, blockNumber: block.number }),
    client.readContract({ address: MATCHING, abi: MATCHING_ABI, functionName: 'sessionKeys', args: [ownerSigner, ownerWallet], blockNumber: block.number }),
  ]);
  if (getAddress(owner) !== ownerSigner) fail('The connected signer is not the account wallet owner; no authorization transaction can be prepared');
  if (getAddress(factoryImplementation) !== IMPLEMENTATION || !slot || !/^0x[0-9a-fA-F]{64}$/.test(slot)
    || getAddress(`0x${slot.slice(-40)}`) !== IMPLEMENTATION) fail('Unsupported account implementation: only the verified Derive factory LightAccount v1.0.1 implementation is supported; upgraded or custom wallets need separate verification');
  safeExpiry(existing);
  return { block, existing };
}

/** Read-only preparation and gas simulation; the connected owner wallet sends the reviewed transaction. */
export async function prepareDeriveSession(wallet: string, signer: string, hours = 1): Promise<DeriveSessionPreview> {
  if (!isAddress(wallet) || !isAddress(signer)) fail('Valid Derive account wallet and owner signer addresses are required');
  if (!Number.isFinite(hours) || hours < 1 || hours > 24) fail('Session duration must be between 1 and 24 hours');
  const ownerWallet = getAddress(wallet), ownerSigner = getAddress(signer);
  if (ownerWallet === ownerSigner) fail('This setup is for a deployed LightAccount owned by the connected EOA');
  const client = publicClient();
  try {
    const { block, existing } = await inspectAccount(client, ownerWallet, ownerSigner);
    const currentExpirySec = safeExpiry(existing), expirySec = safeExpiry(block.timestamp + BigInt(Math.round(hours * 3600)));
    if (expirySec <= currentExpirySec) fail('The requested expiry does not exceed the existing session deadline. Keep the existing authorization or explicitly choose a later duration within the 24-hour limit; this action will not silently extend it');
    const tx = transaction(ownerWallet, ownerSigner, expirySec);
    const balance = await client.getBalance({ address: ownerSigner });
    const [gas, price] = await Promise.allSettled([
      client.estimateGas({ account: ownerSigner, to: ownerWallet, value: 0n, data: tx.data }),
      client.getGasPrice(),
    ]);
    const cost = gas.status === 'fulfilled' && price.status === 'fulfilled' ? gas.value * price.value : null;
    const sufficient = cost === null ? (balance === 0n ? false : null) : balance >= cost;
    const error = gas.status !== 'fulfilled' || price.status !== 'fulfilled'
      ? 'Gas estimation is unavailable. Resolve the RPC or wallet simulation error before submitting.'
      : sufficient ? null : 'The owner EOA has insufficient native ETH on chain 957 for the estimated execution gas.';
    return { wallet: ownerWallet, signer: ownerSigner, version: 'v2', network: 'mainnet', chainId: 957,
      checkedAt: Date.now(), expirySec, currentExpirySec, implementation: IMPLEMENTATION, implementationVersion: '1.0.1', transaction: tx,
      gasEstimate: { gasUnits: gas.status === 'fulfilled' ? gas.value.toString() : null,
        gasPriceWei: price.status === 'fulfilled' ? price.value.toString() : null,
        estimatedCostWei: cost?.toString() ?? null, estimatedCostEth: cost === null ? null : formatEther(cost),
        nativeBalanceWei: balance.toString(), nativeBalanceEth: formatEther(balance), sufficientNativeGas: sufficient, error },
      readyToSubmit: error === null && sufficient === true,
      warnings: [
        'This grants the connected EOA broad Matching action authority for this account until expiry, including trading, collateral transfers between same-owner subaccounts and withdrawals back to the account owner. It is not a read-only or SOL-only permission.',
        'Deregistration uses a 10-minute on-chain cooldown; it does not revoke authority immediately.',
        'The transaction sends zero ETH to Matching. Native ETH in the owner EOA on chain 957 pays gas; USDC collateral does not pay this transaction fee.',
        'The displayed gas cost is an execution estimate at the current gas price. Additional chain data fees and wallet gas buffers are not included; review the wallet final fee and keep extra native ETH available.',
        'A successful on-chain transaction does not prove HTTP access or off-chain scopes. Wait for venue indexing, then sign a fresh timestamp and reconcile the account. Read-only server delegation is a separate step.',
      ] };
  } catch (error) {
    if (error instanceof VenueError) throw error;
    // RPC error objects can include endpoint credentials; do not forward them to the UI.
    fail('Read-only session preparation failed. Verify the RPC connection, deployed account implementation and owner, then prepare a fresh preview');
  }
}

/** Fresh read-only checks immediately before requesting the already reviewed, unchanged wallet transaction. */
export async function validateDeriveSessionForSubmission(preview: DeriveSessionPreview): Promise<void> {
  const expected = validatePersistedPreview(preview), client = publicClient();
  try {
    const { block, existing } = await inspectAccount(client, expected.to, expected.from);
    const expiry = BigInt(preview.expirySec);
    if (expiry <= block.timestamp + 60n) fail('The reviewed session deadline has expired or is less than 61 seconds away. Prepare and review a fresh preview; the deadline will not be extended automatically');
    if (expiry > block.timestamp + 86_400n) fail('The reviewed session deadline exceeds the 24-hour authorization limit');
    if (existing >= expiry) fail('The on-chain session deadline now equals or exceeds the reviewed deadline. Do not submit this superseded authorization; refresh the current permission');
    const [gas, price, balance] = await Promise.all([
      client.estimateGas({ account: expected.from, to: expected.to, value: 0n, data: expected.data }),
      client.getGasPrice(), client.getBalance({ address: expected.from }),
    ]);
    if (gas <= 0n || price < 0n) fail('A valid current gas estimate is required before requesting the wallet transaction');
    if (balance < gas * price) fail('The owner EOA has insufficient native ETH on chain 957 for the current estimated execution gas');
  } catch (error) {
    if (error instanceof VenueError) throw error;
    fail('Read-only pre-submission validation or gas simulation failed. Resolve the RPC or wallet simulation error and recheck the same preview before requesting the wallet transaction');
  }
}

/** Checks the persisted preview against a mined transaction. Never sends or replaces a transaction. */
export async function confirmDeriveSession(preview: DeriveSessionPreview, txHash: string): Promise<DeriveSessionConfirmation> {
  if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) fail('A valid transaction hash is required');
  const expected = validatePersistedPreview(preview);
  const hash = txHash as Hex, client = publicClient();
  const pending = (message: string): DeriveSessionConfirmation => ({ status: 'pending', txHash: hash, checkedAt: Date.now(), expirySec: null, message });
  try {
    if (await client.getChainId() !== 957) fail('The configured RPC must be on Derive v2 mainnet chain 957');
    const tx = await client.getTransaction({ hash });
    if (tx.from.toLowerCase() !== expected.from.toLowerCase() || tx.to?.toLowerCase() !== expected.to.toLowerCase()
      || tx.value !== 0n || tx.input.toLowerCase() !== expected.data.toLowerCase()
      || (tx.chainId !== undefined && tx.chainId !== 957)) fail('The transaction does not match the reviewed owner, wallet, network and exact authorization calldata');
    if (tx.blockNumber === null) return pending('The exact authorization transaction is still pending; no session permission is assumed');
    const receipt = await client.getTransactionReceipt({ hash });
    if (receipt.transactionHash.toLowerCase() !== hash.toLowerCase() || receipt.blockHash !== tx.blockHash || receipt.blockNumber !== tx.blockNumber) fail('Transaction and receipt are inconsistent; authorization is unresolved');
    if (receipt.status === 'reverted') throw new DeriveSessionRevertedError();
    if (receipt.status !== 'success') fail('The authorization receipt has an unsupported status; authorization remains unresolved');
    const block = await client.getBlock({ blockTag: 'latest' });
    if (block.number === null || block.timestamp <= 0n) fail('Cannot verify current session permission without a mined block');
    if (block.number < receipt.blockNumber) fail('The permission snapshot predates the mined receipt; authorization remains unresolved');
    const expiry = await client.readContract({ address: MATCHING, abi: MATCHING_ABI, functionName: 'sessionKeys',
      args: [expected.from, expected.to], blockNumber: block.number });
    const currentExpirySec = safeExpiry(expiry);
    if (expiry < BigInt(preview.expirySec) || expiry < block.timestamp) throw new DeriveSessionInactiveError();
    return { status: 'confirmed', txHash: hash, checkedAt: Date.now(), expirySec: currentExpirySec,
      message: 'The exact owner transaction succeeded and its on-chain Matching permission is active. Venue indexing and HTTP authentication must still be confirmed separately.' };
  } catch (error) {
    if (error instanceof VenueError) throw error;
    if (error instanceof Error && ['TransactionNotFoundError', 'TransactionReceiptNotFoundError'].includes(error.name)) return pending('The transaction or its mined receipt is not yet available. Recheck this hash; do not submit a replacement blindly');
    fail('Read-only transaction confirmation failed. Recheck the same transaction hash after the RPC recovers; its outcome remains unresolved');
  }
}
