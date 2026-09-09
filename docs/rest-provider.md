# Real REST provider integration

PACT can place its existing preview → authenticated approval → single-use authority → commit → verify → receipt protocol in front of a real JSON REST resource rather than only an internal canonical document.

## Provider contract

The provider must expose a JSON object resource over HTTPS and return an `ETag` on successful reads and writes. PACT uses that ETag as the provider revision and performs consequential writes with `If-Match`. This prevents an approved plan from silently applying after the provider changed out of band.

For writes, the bridge also sends PACT's consumed authority ID in `Idempotency-Key`. Providers should persistently honor that key. PACT can detect and recover the common lost-response case by re-reading the provider, observing the new ETag and exact intended resource, and recording the replay locally without blindly writing twice.

PACT does **not** claim universal exactly-once delivery across arbitrary third-party APIs. If a provider ignores conditional writes, reuses ETags for different representations, or ignores idempotency keys, its guarantees are weaker than PACT's local durable authority. Use a provider with strong ETag/conditional-write semantics for consequential operations.

## Server-side composition

Provider credentials stay on the server. Never place bearer tokens or API keys in browser WebMCP tools.

```js
import { createRedisAuthorityStore } from './sdk/redis-store.js';
import { createPactRestResourceBridge, createPactJsonResourceAdapter } from './sdk/rest-resource.js';
import { createPactServerRuntime } from './sdk/server-runtime.js';

const store = createRedisAuthorityStore({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN
});

const canonical = createPactRestResourceBridge({
  store,
  key: 'github:repo:owner/name',
  baseUrl: 'https://api.example.com',
  resourcePath: '/v1/resources/42',
  headers: {
    authorization: `Bearer ${process.env.PROVIDER_TOKEN}`
  }
});

const adapter = createPactJsonResourceAdapter({
  id: 'example.resource',
  version: '1.0.0'
});

const pact = createPactServerRuntime({
  store,
  approvalSecret: process.env.PACT_APPROVAL_SECRET,
  releaseSha: process.env.VERCEL_GIT_COMMIT_SHA,
  adapter,
  canonical
});

export default pact.handler;
```

The JSON-resource adapter accepts an intent such as:

```json
{
  "path": ["profile", "owner"],
  "value": "maya"
}
```

and produces a declarative PACT effect such as:

```json
{
  "path": "resource.profile.owner",
  "before": "ada",
  "after": "maya"
}
```

The exact generated plan is what the approval and capability are bound to.

## Operational behavior

1. `preview` reads the provider, stores its ETag-backed canonical version and produces the exact declarative plan.
2. `approve` authenticates the human principal and agent session and issues a short-lived capability bound to transaction ID, plan hash and canonical version.
3. `commit` consumes the capability once, re-reads provider state, rejects stale ETags, and writes with `If-Match` plus `Idempotency-Key`.
4. `verify` re-reads the real provider resource and checks the planned postconditions through the adapter.
5. `receipt` records the verified canonical version and approval identity binding.

Out-of-band provider changes are translated into a monotonic local canonical version change. A previously approved transaction then fails stale-state validation before it can mutate the provider.

## Provider requirements checklist

- HTTPS endpoint (localhost HTTP is allowed only for development).
- JSON object representation.
- Stable, representation-specific `ETag` on GET and successful write responses.
- Conditional write support with `If-Match`, returning `409` or `412` for stale revisions.
- Prefer persistent `Idempotency-Key` support for consequential writes.
- Provider credentials supplied only from the server runtime.

For providers that do not meet these semantics, implement a domain-specific PACT canonical bridge or adapter rather than weakening the transaction contract.