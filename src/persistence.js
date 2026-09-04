const clone = value => structuredClone(value);

export class MemorySnapshotStore {
  #snapshot;
  constructor(initial = { revision: 0, value: null }) { this.#snapshot = clone(initial); }
  async read() { return clone(this.#snapshot); }
  async write(expectedRevision, value) {
    if (this.#snapshot.revision !== expectedRevision) throw new Error('CAS_CONFLICT');
    this.#snapshot = { revision: expectedRevision + 1, value: clone(value) };
    return this.read();
  }
}

export class LocalStorageSnapshotStore {
  constructor(key = 'pact.snapshot.v1', storage = globalThis.localStorage, lockManager = globalThis.navigator?.locks ?? null) {
    this.key = key;
    this.storage = storage;
    this.lockManager = lockManager;
    this.lockName = `pact:snapshot:${key}`;
  }
  async read() {
    try {
      const raw = this.storage.getItem(this.key);
      if (!raw) return { revision: 0, value: null };
      const parsed = JSON.parse(raw);
      if (!Number.isInteger(parsed.revision) || parsed.revision < 0 || !('value' in parsed)) throw new Error('CORRUPT_SNAPSHOT');
      return clone(parsed);
    } catch (error) {
      if (error?.message === 'CORRUPT_SNAPSHOT') throw error;
      throw new Error('PERSISTENCE_READ_FAILED');
    }
  }
  async write(expectedRevision, value) {
    if (!this.lockManager?.request) throw new Error('PERSISTENCE_LOCK_UNAVAILABLE');
    return this.lockManager.request(this.lockName, { mode: 'exclusive' }, async () => {
      const current = await this.read();
      if (current.revision !== expectedRevision) throw new Error('CAS_CONFLICT');
      const next = { revision: expectedRevision + 1, value: clone(value) };
      this.storage.setItem(this.key, JSON.stringify(next));
      return clone(next);
    });
  }
}
