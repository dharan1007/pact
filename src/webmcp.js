const READ_ONLY = new Set(['pact_inspect','pact_get_transaction_receipt','pact_request_human_approval']);
const MUTATING = new Set(['pact_start_intent','pact_preview_transaction','pact_commit_transaction','pact_verify_transaction','pact_rollback_transaction','pact_cancel_transaction','pact_autopilot_prepare','pact_autopilot_finish','pact_autopilot_resume_verify']);

export function createWebMcpRegistry({ engine, modelContext, onMutation = async () => {} }) {
  let controller = null;
  let names = [];
  const context = () => modelContext ?? globalThis.document?.modelContext ?? globalThis.navigator?.modelContext ?? null;

  function capabilityNames() {
    const expert = engine.activeCapabilities();
    const state = engine.inspect().transaction?.state ?? 'IDLE';
    const automated = [];
    if (state === 'IDLE' || ['CANCELLED','ROLLED_BACK'].includes(state)) automated.push('pact_autopilot_prepare');
    if (state === 'APPROVED' && expert.includes('pact_commit_transaction')) automated.push('pact_autopilot_finish');
    if (state === 'COMMITTED') automated.push('pact_autopilot_resume_verify');
    return [...automated, ...expert];
  }

  async function executeAutopilotFinish() {
    const approved = engine.exportSnapshot();
    let committed;
    try {
      await engine.commit();
      committed = engine.exportSnapshot();
      await onMutation({ name: 'pact_autopilot_finish_commit', result: { state: 'COMMITTED' }, snapshot: committed });
    } catch (error) {
      engine.restoreSnapshot(approved);
      throw error;
    }

    try {
      const receipt = await engine.verify();
      const result = { state: 'VERIFIED', receipt };
      await onMutation({ name: 'pact_autopilot_finish_verify', result, snapshot: engine.exportSnapshot() });
      return result;
    } catch (error) {
      engine.restoreSnapshot(committed);
      throw error;
    }
  }

  async function execute(name) {
    if (name === 'pact_autopilot_finish') return executeAutopilotFinish();
    if (name === 'pact_autopilot_resume_verify') {
      const before = engine.exportSnapshot();
      try {
        const receipt = await engine.verify();
        const result = { state: 'VERIFIED', receipt, recovered: true };
        await onMutation({ name, result, snapshot: engine.exportSnapshot() });
        return result;
      } catch (error) {
        engine.restoreSnapshot(before);
        throw error;
      }
    }
    const mutating = MUTATING.has(name);
    const before = mutating ? engine.exportSnapshot() : null;
    try {
      let result;
      if (name === 'pact_inspect') result = engine.inspect();
      else if (name === 'pact_start_intent') result = engine.startIntent();
      else if (name === 'pact_preview_transaction') result = await engine.preview();
      else if (name === 'pact_autopilot_prepare') {
        engine.startIntent();
        const transaction = await engine.preview();
        result = { transaction, requiresHumanInteraction: true, message: 'Plan and safety checks are complete. Human approval is required once before PACT can finish automatically.' };
      }
      else if (name === 'pact_request_human_approval') result = { requiresHumanInteraction: true, message: 'Approval must come from a trusted human UI gesture.' };
      else if (name === 'pact_commit_transaction') result = await engine.commit();
      else if (name === 'pact_verify_transaction') result = await engine.verify();
      else if (name === 'pact_get_transaction_receipt') result = await engine.getReceipt();
      else if (name === 'pact_rollback_transaction') result = await engine.rollback();
      else if (name === 'pact_cancel_transaction') result = engine.cancel();
      else throw new Error('UNKNOWN_TOOL');
      if (mutating) await onMutation({ name, result, snapshot: engine.exportSnapshot() });
      return result;
    } catch (error) {
      if (mutating && before) engine.restoreSnapshot(before);
      throw error;
    }
  }

  async function refresh() {
    controller?.abort();
    controller = new AbortController();
    const ctx = context();
    names = [];
    if (!ctx?.registerTool) return { supported: false, names: [] };
    const nextNames = capabilityNames();
    try {
      for (const name of nextNames) {
        await ctx.registerTool({
          name,
          description: `PACT transactional capability: ${name}`,
          inputSchema: { type: 'object', properties: {}, additionalProperties: false },
          annotations: { readOnlyHint: READ_ONLY.has(name) },
          execute: async () => execute(name)
        }, { signal: controller.signal });
      }
      names = nextNames;
      return { supported: true, names: [...names] };
    } catch (cause) {
      controller.abort(); names = [];
      throw new Error('WEBMCP_REGISTRATION_FAILED', { cause });
    }
  }
  return { refresh, activeNames: () => [...names], dispose: () => controller?.abort() };
}
