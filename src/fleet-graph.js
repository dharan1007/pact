import { validateReleaseLock } from './release-lock.js';

const clone = value => value === undefined ? undefined : structuredClone(value);
const fail = code => { throw new Error(code); };

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function dependencyKeys(lock) {
  const keys = [];
  for (const [section, entry] of Object.entries(lock.sections)) {
    keys.push({ section, key: null, hash: entry.hash });
    const content = entry.content;
    if (section === 'tools' && isPlainObject(content)) {
      for (const [name, tool] of Object.entries(content)) {
        keys.push({ section, key: name, hash: isPlainObject(tool) && typeof tool.schema_hash === 'string' ? tool.schema_hash : entry.hash });
      }
    }
    if (section === 'mcp' && isPlainObject(content)) {
      for (const [server, config] of Object.entries(content)) {
        const manifest = isPlainObject(config) ? config.tool_manifest : null;
        if (isPlainObject(manifest)) {
          for (const [tool, detail] of Object.entries(manifest)) {
            keys.push({
              section,
              key: `${server}.${tool}`,
              hash: isPlainObject(detail) && typeof detail.schema_hash === 'string' ? detail.schema_hash : entry.hash
            });
          }
        } else {
          keys.push({ section, key: server, hash: entry.hash });
        }
      }
    }
    if (section === 'model' && isPlainObject(content) && typeof content.id === 'string') {
      keys.push({ section, key: content.id, hash: entry.hash });
    }
    if (section === 'prompts' && isPlainObject(content)) {
      for (const name of Object.keys(content)) keys.push({ section, key: name, hash: entry.hash });
    }
  }
  return keys;
}

export async function buildFleetGraph({ locks = [] } = {}) {
  if (!Array.isArray(locks) || locks.length === 0) fail('PACT_FLEET_LOCKS_REQUIRED');
  const agents = {};
  const releases = {};
  const dependencyIndex = {};
  for (const raw of locks) {
    const lock = await validateReleaseLock(raw);
    agents[lock.agent] = agents[lock.agent] ?? { agent: lock.agent, environments: {}, releases: [] };
    const agentNode = agents[lock.agent];
    agentNode.environments[lock.environment] = agentNode.environments[lock.environment] ?? [];
    if (!agentNode.environments[lock.environment].includes(lock.releaseId)) {
      agentNode.environments[lock.environment].push(lock.releaseId);
    }
    if (!agentNode.releases.includes(lock.releaseId)) agentNode.releases.push(lock.releaseId);
    releases[lock.releaseId] = {
      releaseId: lock.releaseId,
      agent: lock.agent,
      environment: lock.environment,
      capturedAt: lock.capturedAt,
      dependencies: dependencyKeys(lock)
    };
    for (const dep of dependencyKeys(lock)) {
      const indexKey = dep.key == null ? `${dep.section}` : `${dep.section}:${dep.key}`;
      dependencyIndex[indexKey] = dependencyIndex[indexKey] ?? [];
      if (!dependencyIndex[indexKey].some(entry => entry.releaseId === lock.releaseId)) {
        dependencyIndex[indexKey].push({ agent: lock.agent, environment: lock.environment, releaseId: lock.releaseId, hash: dep.hash });
      }
    }
  }
  for (const agentNode of Object.values(agents)) {
    agentNode.releases.sort();
    for (const env of Object.keys(agentNode.environments)) agentNode.environments[env].sort();
  }
  return { agents: clone(agents), releases: clone(releases), dependencyIndex: clone(dependencyIndex) };
}

export function blastRadius(graph, { section, key = null, hash = null } = {}) {
  if (!graph || !isPlainObject(graph.dependencyIndex)) fail('PACT_FLEET_GRAPH_REQUIRED');
  if (typeof section !== 'string' || !section) fail('PACT_FLEET_SECTION_REQUIRED');
  const indexKey = key == null ? section : `${section}:${key}`;
  const entries = graph.dependencyIndex[indexKey] ?? [];
  const scoped = hash == null ? entries : entries.filter(entry => entry.hash === hash);
  const agents = [...new Set(scoped.map(entry => `${entry.agent}:${entry.environment}`))].sort();
  const releases = [...new Set(scoped.map(entry => entry.releaseId))].sort();
  return { section, key, hash, agents, releases, dependents: scoped.length };
}

export function releasesUsing(graph, releaseId) {
  if (!graph || !isPlainObject(graph.releases)) fail('PACT_FLEET_GRAPH_REQUIRED');
  if (typeof releaseId !== 'string' || !releaseId) fail('PACT_FLEET_RELEASE_REQUIRED');
  const record = graph.releases[releaseId];
  if (!record) fail('PACT_FLEET_RELEASE_UNKNOWN');
  return clone(record);
}
