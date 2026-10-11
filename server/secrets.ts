import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import type { Store } from './store';

export class AgentVault {
  constructor(private store: Store, private namespace = 'agent') {}
  private recordKey(owner: string) { return this.namespace + ':' + owner.toLowerCase(); }
  get configured() { return /^[a-fA-F0-9]{64}$/.test(process.env.AGENT_ENCRYPTION_KEY || ''); }
  private key() {
    if (!this.configured) throw new Error('Set AGENT_ENCRYPTION_KEY to 32 random bytes encoded as 64 hex characters in the server .env. No wallet private key is needed.');
    return Buffer.from(process.env.AGENT_ENCRYPTION_KEY!, 'hex');
  }
  create(owner: string) {
    const key = generatePrivateKey();
    const address = privateKeyToAccount(key).address;
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key(), iv);
    cipher.setAAD(Buffer.from(owner.toLowerCase()));
    const encrypted = Buffer.concat([cipher.update(key, 'utf8'), cipher.final()]);
    this.store.set(this.recordKey(owner), { address, iv: iv.toString('hex'), data: encrypted.toString('hex'), tag: cipher.getAuthTag().toString('hex'), approved: false });
    return address;
  }
  status(owner: string) { const r = this.store.get<{ address: string; approved: boolean }>(this.recordKey(owner)); return r ? { address: r.address, approved: r.approved } : null; }
  approve(owner: string) {
    const record = this.store.get<Record<string, unknown>>(this.recordKey(owner));
    if (!record) throw new Error('Agent not found');
    this.store.set(this.recordKey(owner), { ...record, approved: true });
  }
  privateKey(owner: string): `0x${string}` {
    const record = this.store.get<{ iv: string; data: string; tag: string; approved: boolean }>(this.recordKey(owner));
    if (!record?.approved) throw new Error('Agent has not been approved by this Hyperliquid account');
    const cipher = createDecipheriv('aes-256-gcm', this.key(), Buffer.from(record.iv, 'hex'));
    cipher.setAAD(Buffer.from(owner.toLowerCase()));
    cipher.setAuthTag(Buffer.from(record.tag, 'hex'));
    return Buffer.concat([cipher.update(Buffer.from(record.data, 'hex')), cipher.final()]).toString('utf8') as `0x${string}`;
  }
  revokeLocal(owner: string) { this.store.delete(this.recordKey(owner)); }
}
