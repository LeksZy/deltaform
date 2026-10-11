import { randomBytes, createPublicKey, verify } from 'node:crypto';
import { PublicKey } from '@solana/web3.js';
import { verifyMessage } from 'viem';
import type { Store } from './store';

type Venue = 'meteora' | 'derive' | 'hyperliquid';
interface Challenge { venue: Venue; address: string; message: string; expiresAt: number }
export class WalletAuth {
  constructor(private store: Store) {}
  challenge(venue: Venue, address: string) {
    if (venue === 'meteora') new PublicKey(address);
    else if (!/^0x[\da-fA-F]{40}$/.test(address)) throw new Error('Invalid EVM wallet address');
    const challengeId = randomBytes(20).toString('hex');
    const message = `DLMM Hedge Lab\nVerify ownership of your ${venue} account.\nAddress: ${address}\nNonce: ${challengeId}\nIssued: ${new Date().toISOString()}\nThis signature connects your account. It does not authorize trades or transfers.`;
    this.store.set('challenge:' + challengeId, { venue, address, message, expiresAt: Date.now() + 300000 } satisfies Challenge);
    return { challengeId, message };
  }
  async verify(venue: Venue, address: string, challengeId: string, signature: string) {
    const key = 'challenge:' + challengeId;
    const challenge = this.store.get<Challenge>(key);
    if (!challenge || challenge.expiresAt < Date.now() || challenge.venue !== venue || challenge.address !== address) throw new Error('Wallet challenge is missing, expired, or belongs to another account');
    let valid = false;
    if (venue === 'meteora') {
      const bytes = new PublicKey(address).toBuffer();
      const publicKey = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), bytes]), type: 'spki', format: 'der' });
      valid = verify(null, Buffer.from(challenge.message), publicKey, Buffer.from(signature, 'base64'));
    } else valid = await verifyMessage({ address: address as `0x${string}`, message: challenge.message, signature: signature as `0x${string}` });
    if (!valid) throw new Error('Wallet ownership signature could not be verified');
    this.store.delete(key);
  }
}
