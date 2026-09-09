const READ_ONLY = new Set(['pact_inspect','pact_get_transaction_receipt','pact_request_human_approval']);
const MUTATING = new Set(['pact_start_intent','pact_preview_transaction','pact_commit_transaction','pact_verify_transaction','pact_rollback_transaction','pact_cancel_transaction','pact_autopilot_prepare','pact_autopilot_finish','pact_autopilot_resume_verify']);

const TOOL_META = {
  pact_inspect: ['Inspect PACT state', 'Read the current PACT transaction, canonical state and audit status without changing application state.'],
  pact_start_intent: ['Start transaction', 'Start a new PACT transaction draft. This does not approve or commit any change.'],
  pact_preview_transaction: ['Preview transaction', 'Build the exact transaction plan and safety constraints against the current canonical state.'],
  pact_autopilot_prepare: ['Prepare transaction', 'Start and preview the transaction in one call, then stop for trusted human approval.'],
  pact_request_human_approval: ['Request human approval', 'Report that trusted human interaction is required. This tool cannot synthesize or grant approval.'],
  pact_commit_transaction: ['Commit approved transaction', 'Commit the exact previously approved transaction while its authority lease is valid.'],
  pact_verify_transaction: ['Verify transaction', 'Verify committed postconditions and negative invariants and produce a tamper-evident receipt.'],
  pact_get_transaction_receipt: ['Get transaction receipt', 'Return the verified receipt after checking its hash and audit-chain anchor.'],
  pact_rollback_transaction: ['Rollback transaction', 'Rollback a verified transaction only when rollback preconditions still hold.'],
  pact_cancel_transaction: ['Cancel transaction', 'Cancel a transaction before commit and revoke any active approval lease.'],
  pact_autopilot_finish: ['Finish approved transaction', 'Commit and verify an already human-approved transaction. It never grants approval itself.'],
  pact_autopilot_resume_verify: ['Resume verification', 'Resume verification for a transaction that was durably committed before verification completed.']
};

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

export function toWebMcpResult(result) {
  return clone(result);
}

export function createWebMcpRegistry({ engine, modelContext, onMutation = async () => {} }) {
  let controller = null;
  let names = [];
  const context = () => modelContext ?? globalThis.document?.modelContext ?? null;

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
        const [title, description] = TOOL_META[name] ?? [name, `PACT transactional capability: ${name}`];
        await ctx.registerTool({
          name,
          title,
          description,
          inputSchema: { type: 'object', properties: {}, additionalProperties: false },
          annotations: {
            readOnlyHint: READ_ONLY.has(name),
            untrustedContentHint: false
          },
          // Current WebMCP ToolExecuteCallback receives the input object only.
          // Registration lifetime is controlled by the AbortSignal supplied as
          // the second registerTool() argument below.
          execute: async _input => toWebMcpResult(await execute(name))
        }, { signal: controller.signal });
      }
      names = nextNames;
      return { supported: true, names: [...names] };
    } catch (cause) {
      controller.abort();
      names = [];
      throw new Error('WEBMCP_REGISTRATION_FAILED', { cause });
    }
  }

  return { refresh, activeNames: () => [...names], dispose: () => controller?.abort() };
}
