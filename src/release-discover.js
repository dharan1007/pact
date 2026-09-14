import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { sha256Hex } from './engine.js';

const fail = code => { throw new Error(code); };
const isPlainObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const clone = value => value === undefined ? undefined : structuredClone(value);

function nonEmpty(value, code, max = 2048) {
  if (typeof value !== 'string' || value.trim() === '') fail(code);
  const normalized = value.trim();
  if (normalized.length > max) fail(code);
  return normalized;
}

function normalizeUrl(value, code) {
  let url;
  try {
    url = new URL(value);
  } catch {
    fail(code);
  }
  if (url.protocol !== 'https:' && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') {
    fail(code);
  }
  return url.toString();
}

async function postJson({ url, body, headers = {}, timeoutMs, fetchImpl }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('PACT_DISCOVER_TIMEOUT')), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    return response;
  } finally {
    clearTimeout(timer);
  }
}

function responseHeader(response, name) {
  const headers = response?.headers;
  if (!headers) return null;
  if (typeof headers.get === 'function') {
    const value = headers.get(name);
    return value == null ? null : String(value);
  }
  for (const [key, value] of Object.entries(headers)) {
    if (String(key).toLowerCase() === String(name).toLowerCase()) return String(value);
  }
  return null;
}

function rethrowPactOrUnreachable(error, code) {
  if (error?.message === 'PACT_DISCOVER_TIMEOUT' || String(error?.message).startsWith('PACT_')) throw error;
  fail(code);
}

async function readJsonResponse(response, code) {
  if (!response?.ok) fail(`${code}_HTTP_${response?.status ?? 0}`);
  let value;
  try {
    value = JSON.parse(await response.text());
  } catch {
    fail(code);
  }
  if (!isPlainObject(value)) fail(code);
  return value;
}

function defaultExec(command, args, cwd) {
  return execFileSync(command, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

export function discoverGit({ exec = defaultExec, cwd = process.cwd() } = {}) {
  if (typeof exec !== 'function') fail('PACT_DISCOVER_EXEC_REQUIRED');
  let gitSha;
  try {
    gitSha = exec('git', ['rev-parse', 'HEAD'], cwd);
  } catch {
    fail('PACT_DISCOVER_GIT_UNAVAILABLE');
  }
  if (!/^[a-f0-9]{40}$/i.test(gitSha)) fail('PACT_DISCOVER_GIT_SHA_INVALID');
  let dirty = false;
  let diffHash = null;
  try {
    dirty = exec('git', ['status', '--porcelain'], cwd).length > 0;
    if (dirty) diffHash = `sha256:${sha256HexSync(exec('git', ['diff', 'HEAD'], cwd))}`;
  } catch {
    fail('PACT_DISCOVER_GIT_STATUS_FAILED');
  }
  return { provider: 'git', sections: { source: { git_sha: gitSha.toLowerCase(), dirty, diff_hash: diffHash } } };
}

function sha256HexSync(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export function discoverPackage({ root = process.cwd() } = {}) {
  root = nonEmpty(root, 'PACT_DISCOVER_ROOT_REQUIRED', 4096);
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  } catch {
    fail('PACT_DISCOVER_PACKAGE_UNREADABLE');
  }
  if (!isPlainObject(pkg)) fail('PACT_DISCOVER_PACKAGE_INVALID');
  const lockNames = ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock'];
  const lockfile = lockNames.find(name => existsSync(path.join(root, name))) ?? null;
  let lockHash = null;
  if (lockfile) {
    try {
      lockHash = `sha256:${sha256HexSync(readFileSync(path.join(root, lockfile), 'utf8'))}`;
    } catch {
      fail('PACT_DISCOVER_LOCKFILE_UNREADABLE');
    }
  }
  return {
    provider: 'package',
    sections: {
      runtime: {
        package: typeof pkg.name === 'string' ? pkg.name : null,
        version: typeof pkg.version === 'string' ? pkg.version : null,
        node: process.version,
        dependencies: isPlainObject(pkg.dependencies) ? clone(pkg.dependencies) : {},
        lockfile,
        lockfile_hash: lockHash
      }
    }
  };
}

export async function discoverMcpServer({ url, fetchImpl = globalThis.fetch, headers = {}, timeoutMs = 10_000 } = {}) {
  if (typeof fetchImpl !== 'function') fail('PACT_DISCOVER_FETCH_REQUIRED');
  url = normalizeUrl(url, 'PACT_DISCOVER_MCP_URL_INVALID');
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) fail('PACT_DISCOVER_TIMEOUT_INVALID');
  let initialize;
  let sessionId = null;
  try {
    const response = await postJson({
      url,
      fetchImpl,
      timeoutMs,
      headers,
      body: {
        jsonrpc: '2.0',
        id: 'pact-discover-init',
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'pact-discover', version: '1.0.0' }
        }
      }
    });
    sessionId = responseHeader(response, 'mcp-session-id');
    initialize = await readJsonResponse(response, 'PACT_DISCOVER_MCP_INVALID_INITIALIZE');
  } catch (error) {
    rethrowPactOrUnreachable(error, 'PACT_DISCOVER_MCP_UNREACHABLE');
  }
  if (!isPlainObject(initialize.result) || typeof initialize.result.protocolVersion !== 'string') {
    fail('PACT_DISCOVER_MCP_INVALID_INITIALIZE');
  }
  const sessionHeader = sessionId;
  let listed;
  try {
    const response = await postJson({
      url,
      fetchImpl,
      timeoutMs,
      headers: sessionHeader ? { ...headers, 'mcp-session-id': sessionHeader } : headers,
      body: { jsonrpc: '2.0', id: 'pact-discover-tools', method: 'tools/list', params: {} }
    });
    listed = await readJsonResponse(response, 'PACT_DISCOVER_MCP_INVALID_TOOLS');
  } catch (error) {
    rethrowPactOrUnreachable(error, 'PACT_DISCOVER_MCP_UNREACHABLE');
  }
  const tools = Array.isArray(listed.result?.tools) ? listed.result.tools : null;
  if (!tools) fail('PACT_DISCOVER_MCP_INVALID_TOOLS');
  const manifest = {};
  for (const tool of tools) {
    if (!isPlainObject(tool) || typeof tool.name !== 'string' || !tool.name) fail('PACT_DISCOVER_MCP_INVALID_TOOL');
    const entry = {};
    if (typeof tool.description === 'string' && tool.description) {
      entry.description_hash = `sha256:${await sha256Hex(tool.description)}`;
    }
    if (tool.inputSchema !== undefined) {
      let schema;
      try {
        schema = JSON.parse(JSON.stringify(tool.inputSchema));
      } catch {
        fail('PACT_DISCOVER_MCP_INVALID_TOOL');
      }
      if (!isPlainObject(schema) && typeof schema !== 'boolean') fail('PACT_DISCOVER_MCP_INVALID_TOOL');
      entry.schema_hash = `sha256:${await sha256Hex(schema)}`;
      entry.schema = schema;
    }
    manifest[tool.name] = entry;
  }
  const serverInfo = isPlainObject(initialize.result.serverInfo) ? initialize.result.serverInfo : {};
  return {
    provider: 'mcp',
    sections: {
      mcp: {
        [serverIdentity(url, serverInfo)]: {
          server_name: typeof serverInfo.name === 'string' ? serverInfo.name : null,
          server_version: typeof serverInfo.version === 'string' ? serverInfo.version : null,
          protocol: initialize.result.protocolVersion,
          tool_manifest: manifest
        }
      }
    }
  };
}

function serverIdentity(url, serverInfo) {
  const host = new URL(url).host.replace(/[^a-zA-Z0-9.-]/g, '-');
  if (typeof serverInfo.name === 'string' && serverInfo.name) {
    return `${serverInfo.name}@${host}`.slice(0, 128);
  }
  return host;
}

async function discoverModel({ provider, apiKey, model, baseUrl, fetchImpl, headers, path }) {
  if (typeof fetchImpl !== 'function') fail('PACT_DISCOVER_FETCH_REQUIRED');
  apiKey = nonEmpty(apiKey, 'PACT_DISCOVER_AUTH_REQUIRED', 4096);
  model = nonEmpty(model, 'PACT_DISCOVER_MODEL_REQUIRED', 256);
  baseUrl = normalizeUrl(baseUrl, 'PACT_DISCOVER_BASE_URL_INVALID');
  const url = `${baseUrl.replace(/\/$/, '')}${path}${encodeURIComponent(model)}`;
  let response;
  try {
    response = await fetchImpl(url, { method: 'GET', headers: { accept: 'application/json', ...headers } });
  } catch {
    fail(`PACT_DISCOVER_${provider.toUpperCase()}_UNREACHABLE`);
  }
  const body = await readJsonResponse(response, `PACT_DISCOVER_${provider.toUpperCase()}_INVALID_RESPONSE`);
  return body;
}

export async function discoverOpenaiModel({ apiKey, model, baseUrl = 'https://api.openai.com/v1/', fetchImpl = globalThis.fetch } = {}) {
  const body = await discoverModel({
    provider: 'openai',
    apiKey,
    model,
    baseUrl,
    fetchImpl,
    headers: { authorization: `Bearer ${apiKey}` },
    path: '/models/'
  });
  if (typeof body.id !== 'string') fail('PACT_DISCOVER_OPENAI_INVALID_RESPONSE');
  return {
    provider: 'openai',
    sections: {
      model: {
        provider: 'openai',
        id: body.id,
        created: Number.isSafeInteger(body.created) ? body.created : null,
        owned_by: typeof body.owned_by === 'string' ? body.owned_by : null
      }
    }
  };
}

export async function discoverAnthropicModel({ apiKey, model, baseUrl = 'https://api.anthropic.com/v1/', fetchImpl = globalThis.fetch } = {}) {
  const body = await discoverModel({
    provider: 'anthropic',
    apiKey,
    model,
    baseUrl,
    fetchImpl,
    headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    path: '/models/'
  });
  if (typeof body.id !== 'string') fail('PACT_DISCOVER_ANTHROPIC_INVALID_RESPONSE');
  return {
    provider: 'anthropic',
    sections: {
      model: {
        provider: 'anthropic',
        id: body.id,
        display_name: typeof body.display_name === 'string' ? body.display_name : null,
        created_at: typeof body.created_at === 'string' ? body.created_at : null
      }
    }
  };
}

export function composeDescriptor({ agent, environment, discoveries = [] } = {}) {
  if (typeof agent !== 'string' || !agent.trim()) fail('PACT_DISCOVER_AGENT_REQUIRED');
  if (typeof environment !== 'string' || !environment.trim()) fail('PACT_DISCOVER_ENVIRONMENT_REQUIRED');
  if (!Array.isArray(discoveries) || discoveries.length === 0) fail('PACT_DISCOVER_DISCOVERIES_REQUIRED');
  const descriptor = { agent: agent.trim(), environment: environment.trim() };
  const provenance = {};
  for (const discovery of discoveries) {
    if (!isPlainObject(discovery) || typeof discovery.provider !== 'string' || !isPlainObject(discovery.sections)) {
      fail('PACT_DISCOVER_RESULT_INVALID');
    }
    for (const [section, content] of Object.entries(discovery.sections)) {
      if (!isPlainObject(content)) fail(`PACT_DISCOVER_SECTION_INVALID:${section}`);
      descriptor[section] = { ...(descriptor[section] ?? {}), ...clone(content) };
      provenance[section] = [...(provenance[section] ?? []), discovery.provider];
    }
  }
  return { descriptor, provenance };
}
