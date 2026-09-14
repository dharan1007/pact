export type ReleaseSectionName =
  | 'source' | 'model' | 'prompts' | 'skills' | 'tools' | 'mcp'
  | 'retrieval' | 'memory' | 'permissions' | 'evals' | 'runtime';

export interface ReleaseSection {
  hash: `sha256:${string}`;
  content: unknown;
}

export interface ReleaseLock {
  lockVersion: 1;
  agent: string;
  environment: string;
  capturedAt: number;
  sections: Partial<Record<ReleaseSectionName, ReleaseSection>>;
  releaseId: `pact_${string}`;
}

export interface AgentDescriptor {
  agent: string;
  environment: string;
  [section: string]: unknown;
}

export declare function lockSectionNames(): ReleaseSectionName[];
export declare function createReleaseLock(
  descriptor?: AgentDescriptor,
  options?: { now?: () => number }
): Promise<ReleaseLock>;
export declare function validateReleaseLock(lock: unknown): Promise<ReleaseLock>;

export type FindingSeverity = 'high' | 'medium' | 'low';

export interface DiffFinding {
  section: string;
  kind: string;
  severity: FindingSeverity;
  detail: string;
  paths?: Array<{ path: string; before: unknown; after: unknown }>;
}

export interface ReleaseDiff {
  agent: string;
  environment: string;
  beforeReleaseId: string;
  afterReleaseId: string;
  unchanged: boolean;
  findings: DiffFinding[];
  summary: { high: number; medium: number; low: number };
}

export declare function classifySectionChange(name: string, beforeContent: unknown, afterContent: unknown): { kind: string; severity: FindingSeverity };
export declare function diffReleaseLocks(beforeLock: unknown, afterLock: unknown): Promise<ReleaseDiff>;

export interface AtomicStore {
  get(key: string): Promise<unknown>;
  create(key: string, value: unknown): Promise<boolean>;
  compareAndSwap(key: string, expectedVersion: number, value: unknown): Promise<boolean>;
}

export declare function createReleaseRegistry(options?: { store: AtomicStore; prefix?: string }): {
  pin(lock: unknown): Promise<{ lock: ReleaseLock }>;
  get(releaseId: string): Promise<ReleaseLock>;
  history(options?: { agent: string; environment: string }): Promise<string[]>;
};

export interface DriftFinding extends DiffFinding {
  changeKind?: string;
}

export interface DriftReport {
  agent: string;
  environment: string;
  releaseId: string;
  drifted: boolean;
  findings: DriftFinding[];
}

export declare function evaluateDrift(pinnedLock: unknown, observedDescriptor?: Record<string, unknown>): Promise<DriftReport>;

export type GateDecision = 'ALLOW' | 'WARN' | 'BLOCK';

export interface GatePolicy {
  blockOnSeverities?: FindingSeverity[];
  blockOnKinds?: string[];
  warnOnSeverities?: FindingSeverity[];
  blockOnDrift?: boolean;
  replayCeilings?: {
    maxChangedOutcomeRate?: number;
    maxNewFailureRate?: number;
    maxDestructiveCount?: number;
    maxCostRisePct?: number;
    maxP95LatencyRisePct?: number;
    blockOnChangedConsequential?: boolean;
    blockOnUnknowns?: boolean;
    protectedTraceIds?: string[];
  };
}

export interface GateResult {
  decision: GateDecision;
  reasons: string[];
  diffSummary: ReleaseDiff['summary'] | null;
  drifted: boolean | null;
  replaySample?: unknown;
  policy: Record<string, unknown>;
}

export declare function evaluateGate(options?: { diff?: { findings: DiffFinding[]; summary?: ReleaseDiff['summary'] } | null; drift?: { findings: DriftFinding[]; drifted?: boolean } | null; replay?: unknown; policy?: GatePolicy }): GateResult;

export interface TraceToolCall {
  tool: string;
  args: unknown;
}

export interface TraceEvent {
  traceId: string;
  agent: string;
  releaseId: string | null;
  model: string | null;
  promptHash: string | null;
  toolCalls: TraceToolCall[];
  output: unknown;
  latencyMs: number | null;
  costUsd: number | null;
  outcome: 'success' | 'failure' | 'escalated' | 'unknown';
  ts: number | null;
}

export declare function normalizeTraceEvent(event?: unknown): TraceEvent;
export declare function fromOtelSpan(span?: unknown): TraceEvent;
export declare function redactEvent(
  event: unknown,
  options?: { paths?: string[]; keys?: RegExp }
): { event: unknown; redacted: string[] };
export declare function mulberry32(seed: number): () => number;
export declare function createTraceCorpus(options?: { store: AtomicStore; prefix?: string }): {
  append(event: unknown): Promise<{ event: TraceEvent; idempotentReplay: boolean }>;
  get(traceId: string): Promise<TraceEvent>;
  list(agent: string): Promise<string[]>;
  sample(agent: string, options?: { n?: number; seed?: number }): Promise<TraceEvent[]>;
};
export declare function corpusEventHash(event: unknown): Promise<string>;

export interface DiscoveryResult {
  provider: string;
  sections: Record<string, Record<string, unknown>>;
}

export declare function discoverGit(options?: { exec?: (command: string, args: string[], cwd: string) => string; cwd?: string }): DiscoveryResult;
export declare function discoverPackage(options?: { root?: string }): DiscoveryResult;
export declare function discoverMcpServer(options?: { url: string; fetchImpl?: typeof fetch; headers?: Record<string, string>; timeoutMs?: number }): Promise<DiscoveryResult>;
export declare function discoverOpenaiModel(options?: { apiKey: string; model: string; baseUrl?: string; fetchImpl?: typeof fetch }): Promise<DiscoveryResult>;
export declare function discoverAnthropicModel(options?: { apiKey: string; model: string; baseUrl?: string; fetchImpl?: typeof fetch }): Promise<DiscoveryResult>;
export declare function composeDescriptor(options?: { agent: string; environment: string; discoveries?: DiscoveryResult[] }): {
  descriptor: AgentDescriptor;
  provenance: Record<string, string[]>;
};

export type SchemaVerdict = 'compatible' | 'incompatible' | 'unknown';

export declare function validateAgainstSchema(value: unknown, schema: unknown, path?: string): { verdict: SchemaVerdict; reasons: string[] };
export declare function decisionCompatReplay(options?: {
  traces?: unknown[];
  baselineLock?: unknown;
  candidateLock: unknown;
  contracts?: { tools?: Record<string, unknown>; scopes?: string[]; toolScopes?: Record<string, string[]> };
}): Promise<{
  traces: number;
  candidateReleaseId: string;
  baselineReleaseId: string | null;
  totals: { calls: number; compatible: number; broken: number; incompatible: number; unknown: number };
  details: Array<{ traceId: string; tool: string; verdict: string; reason: string }>;
}>;
export declare function createReplayToolClient(options?: { recorded?: Array<{ tool: string; args?: unknown; result?: unknown }>; onPropose?: (proposal: unknown) => Promise<void> }): {
  invoke(tool: string, args?: unknown): Promise<{ result: unknown; executed: boolean; matched: boolean; unmatched?: boolean }>;
  proposals(): unknown[];
};
export declare function wilson(count: number, total: number, z?: number): { rate: number; lower: number; upper: number; count: number; total: number };
export declare function percentile(sortedValues: number[], quantile: number): number;
export declare function runExperiment(options?: {
  traces?: unknown[];
  seed?: number;
  sampleSize?: number | null;
  baseline: (context: unknown) => Promise<unknown>;
  candidate: (context: unknown) => Promise<unknown>;
  isConsequential?: (tool: string) => boolean;
  isDestructive?: (tool: string, args: unknown) => boolean;
}): Promise<{ seed: number; sampled: number; requested: number; perTrace: unknown[] }>;
export declare function buildProveReport(options?: {
  experiment: { perTrace: unknown[]; requested: number; seed: number };
  compat?: { totals: { calls: number; compatible: number; broken: number; incompatible: number; unknown: number } } | null;
  baselineReleaseId?: string | null;
  candidateReleaseId?: string | null;
  protectedTraceIds?: string[];
  generatedAt?: number;
}): Record<string, unknown>;

export declare function isolateRegression(options?: {
  baselineLock: unknown;
  candidateLock: unknown;
  evaluate: (lock: ReleaseLock) => Promise<'pass' | 'fail' | 'uncertain'>;
  now?: () => number;
}): Promise<{ conclusion: string; section?: string; candidates?: string[]; evidence?: unknown; reason?: string; note?: string }>;

export declare function validateCanaryPlan(options?: { steps?: Array<{ percent: number; bakeMs: number }> }): Array<{ percent: number; bakeMs: number }>;
export declare function evaluateCanaryStep(options?: { metrics?: Record<string, number>; thresholds?: Record<string, number> }): { decision: 'promote' | 'hold' | 'rollback'; reasons: string[] };

export declare function createReleaseEffectIndex(options?: { store: AtomicStore; prefix?: string }): {
  indexReceipt(receipt: unknown): Promise<Record<string, unknown>>;
  listEffects(releaseId: string): Promise<Record<string, unknown>[]>;
  summarizeEffects(releaseId: string): Promise<{ releaseId: string; effects: number; adapters: Record<string, number>; minCommitVersion: number | null; maxCommitVersion: number | null }>;
};

export declare function executeReleaseRecovery(options?: {
  effects?: unknown[];
  resolvers?: Record<string, (input: { effect: unknown; idempotencyKey: string }) => Promise<{ status: string; detail?: string }>>;
  idempotencyPrefix?: string;
  now?: () => number;
}): Promise<Array<{ txId: string; adapter: string | null; status: string; detail: string | null; idempotencyKey: string; at: number }>>;
export declare function summarizeRecovery(evidence?: unknown[]): { effects: number; byStatus: Record<string, number> };

export declare function buildFleetGraph(options?: { locks?: unknown[] }): Promise<{
  agents: Record<string, { agent: string; environments: Record<string, string[]>; releases: string[] }>;
  releases: Record<string, { releaseId: string; agent: string; environment: string; capturedAt: number; dependencies: Array<{ section: string; key: string | null; hash: string }> }>;
  dependencyIndex: Record<string, Array<{ agent: string; environment: string; releaseId: string; hash: string }>>;
}>;
export declare function blastRadius(
  graph: unknown,
  options?: { section: string; key?: string | null; hash?: string | null }
): { section: string; key: string | null; hash: string | null; agents: string[]; releases: string[]; dependents: number };
export declare function releasesUsing(graph: unknown, releaseId: string): {
  releaseId: string;
  agent: string;
  environment: string;
  capturedAt: number;
  dependencies: Array<{ section: string; key: string | null; hash: string }>;
};
