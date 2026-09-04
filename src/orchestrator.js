const clone = value => structuredClone(value);

export function createPactOrchestrator({ engine, persist = async () => {} }) {
  async function transact(action) {
    const before = engine.exportSnapshot();
    try {
      const result = await action();
      await persist(engine.exportSnapshot());
      return result;
    } catch (error) {
      engine.restoreSnapshot(before);
      throw error;
    }
  }

  async function begin() {
    const before = engine.exportSnapshot();
    try {
      engine.startIntent();
      const transaction = await engine.preview();
      await persist(engine.exportSnapshot());
      return { phase: 'AWAITING_APPROVAL', transaction: clone(transaction) };
    } catch (error) {
      engine.restoreSnapshot(before);
      throw error;
    }
  }

  async function finishApproved() {
    await transact(() => engine.commit());
    const receipt = await transact(() => engine.verify());
    return { phase: 'VERIFIED', receipt: clone(receipt) };
  }

  async function approveAndFinish({ trusted }) {
    await transact(() => engine.approve({ trusted }));
    return finishApproved();
  }

  async function resumeApproved() {
    if (engine.inspect().transaction?.state !== 'APPROVED') throw new Error('NOT_APPROVED');
    const before = engine.exportSnapshot();
    const reconciled = await engine.reconcileExpiredApproval();
    if (reconciled.expired) {
      try { await persist(engine.exportSnapshot()); } catch (error) { engine.restoreSnapshot(before); throw error; }
      return { phase: reconciled.state === 'PREVIEWED' ? 'AWAITING_APPROVAL' : 'STALE', expired: true, transaction: clone(engine.inspect().transaction) };
    }
    return finishApproved();
  }

  async function resumeCommitted() {
    if (engine.inspect().transaction?.state !== 'COMMITTED') throw new Error('NOT_COMMITTED');
    const receipt = await transact(() => engine.verify());
    return { phase: 'VERIFIED', receipt: clone(receipt), recovered: true };
  }

  return { begin, approveAndFinish, finishApproved, resumeApproved, resumeCommitted };
}
