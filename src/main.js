import { createPactEngine } from './engine.js';
import { createWebMcpRegistry } from './webmcp.js';
import { LocalStorageSnapshotStore } from './persistence.js';

const $ = id => document.getElementById(id);
const store = new LocalStorageSnapshotStore();
let revision = 0;
let engine;
let registry;

function toast(message) {
  $('toast').textContent = message; $('toast').hidden = false; $('live').textContent = message;
  clearTimeout(toast.timer); toast.timer = setTimeout(() => { $('toast').hidden = true; }, 2600);
}

async function boot() {
  let saved;
  try { saved = await store.read(); } catch (error) { throw new Error(`PERSISTENCE_INTEGRITY_FAILED:${error.message}`); }
  revision = saved.revision;
  engine = createPactEngine({ snapshot: saved.value ?? undefined });
  try { await engine.validateIntegrity(); } catch (error) { throw new Error(`PERSISTENCE_INTEGRITY_FAILED:${error.message}`); }
  if (engine.inspect().transaction?.state === 'APPROVED') {
    const before = engine.exportSnapshot();
    const reconciled = await engine.reconcileExpiredApproval();
    if (reconciled.expired) {
      try { await persist(); } catch (error) { engine.restoreSnapshot(before); throw error; }
    }
  }
  registry = createWebMcpRegistry({
    engine,
    onMutation: async () => {
      try {
        await persist();
      } catch (error) {
        setTimeout(() => location.reload(), 100);
        throw error;
      }
      setTimeout(() => refreshAll().catch(error => toast(error.message ?? String(error))), 0);
    }
  });
  await refreshAll();
}

async function persist() {
  try {
    const next = await store.write(revision, engine.exportSnapshot());
    revision = next.revision;
  } catch (error) {
    if (error.message === 'CAS_CONFLICT') {
      toast('Another tab changed PACT state. Reloading canonical snapshot.');
      setTimeout(() => location.reload(), 450);
      throw error;
    }
    throw error;
  }
}

async function refreshAll() {
  const state = engine.inspect();
  const tx = state.transaction;
  $('version-badge').textContent = `STATE v${state.canonical.version}`;
  $('state-version').textContent = state.canonical.version;
  $('billing').textContent = state.canonical.billing.plan.toUpperCase();
  $('deleted').textContent = state.canonical.deletedRecords;
  $('tx-state').textContent = tx?.state ?? 'IDLE';
  $('tx-id').textContent = tx?.id ?? '—';
  $('plan-hash').textContent = tx?.planHash ?? '—';
  $('lease').textContent = state.lease ? new Date(state.lease.expiresAt).toLocaleTimeString() : '—';
  $('people').innerHTML = Object.entries(state.canonical.people).map(([name,p]) => `<tr><td>${name}</td><td>${p.status}</td><td>${p.prod?'YES':'NO'}</td><td>${p.repo}</td></tr>`).join('');
  $('diffs').innerHTML = tx?.effects?.length ? tx.effects.map(e => `<div class="diff"><code>${e.path}</code><span>${String(e.before)} → ${String(e.after)}</span></div>`).join('') : '<div class="empty">Start the reference intent to construct an exact semantic plan.</div>';
  const recovery = $('recovery-status');
  if (recovery) recovery.hidden = tx?.state !== 'COMMITTED';
  $('receipt').hidden = tx?.state !== 'VERIFIED';
  $('receipt-hash').textContent = tx?.receipt?.receiptHash ?? '';
  $('trace').innerHTML = [...state.audit].reverse().map(e => `<div class="trace-item"><b>${e.type}</b> · ${e.hash.slice(0,12)}<br>${new Date(e.at).toLocaleTimeString()}</div>`).join('') || '<div class="empty">No audit events yet.</div>';

  const caps = engine.activeCapabilities();
  $('start').disabled = !caps.includes('pact_start_intent');
  $('preview').disabled = !caps.includes('pact_preview_transaction');
  $('approve').disabled = !caps.includes('pact_request_human_approval');
  $('commit').disabled = !caps.includes('pact_commit_transaction');
  $('verify').disabled = !caps.includes('pact_verify_transaction');
  $('rollback').disabled = !caps.includes('pact_rollback_transaction');
  $('cancel').disabled = !caps.includes('pact_cancel_transaction');
  $('race').disabled = tx?.state !== 'APPROVED';

  try {
    const reg = await registry.refresh();
    $('tools').innerHTML = reg.names.map(n => `<div class="tool">${n}</div>`).join('');
    $('webmcp-badge').textContent = reg.supported ? 'WEBMCP ACTIVE' : 'WEBMCP NOT DETECTED';
  } catch (error) {
    $('webmcp-badge').textContent = 'WEBMCP REGISTRATION ERROR';
    toast(error.message);
  }
}

async function mutate(action, { persistState = true } = {}) {
  const before = persistState ? engine.exportSnapshot() : null;
  try {
    await action();
    if (persistState) await persist();
    await refreshAll();
  } catch (error) {
    if (before) engine.restoreSnapshot(before);
    toast(error.message ?? String(error));
    await refreshAll();
  }
}

$('start').addEventListener('click', () => mutate(() => engine.startIntent()));
$('preview').addEventListener('click', () => mutate(() => engine.preview()));
$('approve').addEventListener('click', event => mutate(() => engine.approve({ trusted: event.isTrusted })));
$('commit').addEventListener('click', () => mutate(() => engine.commit()));
$('verify').addEventListener('click', () => mutate(() => engine.verify()));
$('rollback').addEventListener('click', () => mutate(() => engine.rollback()));
$('cancel').addEventListener('click', () => mutate(() => engine.cancel()));
$('race').addEventListener('click', () => mutate(() => engine.simulateConcurrentEdit()));
window.addEventListener('storage', event => { if (event.key === store.key) { toast('PACT changed in another tab. Reloading to avoid a stale writer.'); setTimeout(() => location.reload(), 450); } });
window.addEventListener('beforeunload', () => registry?.dispose());

boot().catch(error => toast(`BOOT_FAILED: ${error.message}`));
