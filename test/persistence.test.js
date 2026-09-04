import test from 'node:test';
import assert from 'node:assert/strict';
import { MemorySnapshotStore } from '../src/persistence.js';

test('snapshot CAS rejects stale writers', async () => {
  const s=new MemorySnapshotStore({revision:0,value:{x:1}});
  const a=await s.read(); const b=await s.read();
  await s.write(a.revision,{x:2});
  await assert.rejects(()=>s.write(b.revision,{x:3}),/CAS_CONFLICT/);
  assert.equal((await s.read()).value.x,2);
});

test('store returns clones, preventing accidental shared mutation', async () => {
  const s=new MemorySnapshotStore({revision:0,value:{nested:{x:1}}});
  const a=await s.read(); a.value.nested.x=9;
  assert.equal((await s.read()).value.nested.x,1);
});

function serialLockManager() {
  let tail = Promise.resolve();
  return {
    request(_name, _options, callback) {
      const run = tail.then(callback, callback);
      tail = run.catch(() => {});
      return run;
    }
  };
}

function fakeStorage() {
  const values = new Map();
  return {
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); }
  };
}

test('localStorage CAS serializes competing tabs under a cross-tab lock', async () => {
  const storage = fakeStorage();
  const locks = serialLockManager();
  const { LocalStorageSnapshotStore } = await import('../src/persistence.js');
  const a = new LocalStorageSnapshotStore('shared', storage, locks);
  const b = new LocalStorageSnapshotStore('shared', storage, locks);
  const [ra, rb] = await Promise.all([a.read(), b.read()]);
  const results = await Promise.allSettled([
    a.write(ra.revision, { owner: 'a' }),
    b.write(rb.revision, { owner: 'b' })
  ]);
  assert.equal(results.filter(x => x.status === 'fulfilled').length, 1);
  assert.equal(results.filter(x => x.status === 'rejected' && /CAS_CONFLICT/.test(x.reason.message)).length, 1);
  assert.equal((await a.read()).revision, 1);
});

test('localStorage CAS fails closed when cross-tab locking is unavailable', async () => {
  const { LocalStorageSnapshotStore } = await import('../src/persistence.js');
  const s = new LocalStorageSnapshotStore('shared', fakeStorage(), null);
  await assert.rejects(() => s.write(0, { x: 1 }), /PERSISTENCE_LOCK_UNAVAILABLE/);
});
