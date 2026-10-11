import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Store } from '../server/store';

describe('durable execution service storage', () => {
  it('commits or rolls back a recovery archive, state and audit together', () => {
    const store = new Store(':memory:');
    try {
      store.set('pending', { id: 'old-intent' });
      expect(() => store.transaction(() => {
        store.set('recovery', { id: 'old-intent' });
        store.delete('pending');
        store.appendEvent('live', { id: 'recovery', timestamp: 1, type: 'recovery', message: 'Archived locally' });
        throw new Error('Simulated storage failure');
      })).toThrow('Simulated storage failure');
      expect(store.get('pending')).toEqual({ id: 'old-intent' });
      expect(store.get('recovery')).toBeUndefined();
      expect(store.history('live')).toEqual([]);
      store.transaction(() => {
        store.set('recovery', { id: 'old-intent' });
        store.delete('pending');
        store.appendEvent('live', { id: 'recovery', timestamp: 2, type: 'recovery', message: 'Archived locally' });
      });
      expect(store.get('pending')).toBeUndefined();
      expect(store.get('recovery')).toEqual({ id: 'old-intent' });
      expect(store.history('live')).toHaveLength(1);
    } finally { store.close(); }
  });
  it('prevents a second worker on the same database and releases cleanly', () => {
    const directory = mkdtempSync(join(tmpdir(), 'dlmm-lock-'));
    const path = join(directory, 'state.sqlite');
    const first = new Store(path), second = new Store(path);
    try {
      first.acquireWorker();
      expect(() => second.acquireWorker()).toThrow('Another execution service');
      first.close();
      expect(() => second.acquireWorker()).not.toThrow();
    } finally { second.close(); rmSync(directory, { recursive: true, force: true }); }
  });

  it('keeps audit records independently of the recent dashboard state', () => {
    const store = new Store(':memory:');
    try {
      for (let i = 0; i < 1005; i++) store.appendEvent('paper', { id: String(i), timestamp: i, type: 'fill', message: 'Paper fill' });
      store.appendEvent('live', { id: 'live', timestamp: 2000, type: 'read', message: 'Read-only discovery' });
      store.set('state:paper', { events: [] });
      expect(store.history('paper')).toHaveLength(1005);
      expect(store.history('paper')[0]!.id).toBe('1004');
      expect(store.history('live')).toHaveLength(1);
      store.appendEvent('paper', { id: '0', timestamp: 0, type: 'fill', message: 'Duplicate migration' });
      expect(store.history('paper')).toHaveLength(1005);
    } finally { store.close(); }
  });
});
