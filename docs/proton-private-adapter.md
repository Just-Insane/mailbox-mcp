# Private Proton HTTP adapter (source only)

`createProtonPrivateHandler` from `dist/private-proton-handler.js` returns an
executable Web `Request` → `Promise<Response>` handler. It reuses the existing
metadata and byte tool handlers and the injected existing provider factory.
The generic stdio server does not import or mount this adapter.

```typescript
const handle = createProtonPrivateHandler({
  policy,                // Qualified server configuration, never request data.
  verifyGateway,         // Mandatory existing-gateway verifier.
  context: {accountManager, getProvider},
});
```

`GatewayVerifier(request, signal)` must obtain an authenticated identity from
the existing gateway and return `{principal, audience, requestTarget}` or `null`.
`requestTarget` must be captured by the host **before** constructing a WHATWG
`Request` or `URL`, which normalize dot segments and encoded-dot aliases. The
verifier must carry that original target through its trusted closure and require
the gateway to authorize the same canonical path and `POST` method. Never derive
it from `Request.url` or caller-controlled headers. Missing original-target proof
or any target other than the exact canonical operation path denies before a
provider can be constructed, even if the normalized URL matches. It must not
consume the request body. The adapter never trusts identity headers directly,
implements no bearer checker, and provisions no caller or credential. Missing
verifier/context/policy, wrong identity/audience, expired policy, or a missing
operation selection denies before `getProvider` can construct a provider.

`ProtonPrivatePolicy` contains `status:"qualified"`, `principal`, `audience`,
`receiptReference`, ISO-8601 `expiresAt`, and independently optional
`metadataSelection` / `attachmentSelection`. The policy is snapshotted per
request, bounded to 16 KiB, and its expiry is rechecked before provider
construction and response exposure. Operator configuration is not evidence that
the existing host authentication or processing permissions have been qualified.

| Route | Exact JSON request | Success response |
| --- | --- | --- |
| `POST /v1/private/proton/metadata` | `{account,message_id,limit,expected_uid_validity?}` | Existing metadata `structuredContent`, schema `1.0` |
| `POST /v1/private/proton/attachment` | `{account,message_id,part_id,expected_uid_validity,format}` | Existing byte `structuredContent`, schema `1.0` |

Each request must exactly match its independently fixed server selection. The
adapter creates only that operation's private context; metadata never enables
bytes. Existing tool-group and provider capability restrictions still apply.
No query parameters, extra request fields, caller authority or alternate paths
are accepted. Errors are generic JSON; successes contain no MCP text wrapper.
All responses use `private, no-store` and `nosniff`.

Requests are bounded to 4,096 actual bytes (including streamed bodies). Direct
metadata responses are bounded to 262,144 bytes and byte responses to 3,500,000;
the original tool validations and stricter underlying byte cohort remain in
force. The handler has one 30-second deadline and no redirect/retry/fallback.
It passes cancellation to the gateway verifier, cancels a stalled request-body
reader and prevents provider operations from starting after a late factory
result. Existing provider methods have no abort-signal interface: an operation
already in flight retains its existing bounds and lock/stream cleanup; timeout
withholds its result, not a claim of confirmed transport cancellation.

Hosting remains unimplemented: an authorized host must identify the actual
existing gateway verifier, mount this handler through that boundary, and supply
qualified, unexpired selections and receipts under existing permissions. A
synthetic injected verifier proves adapter control flow only. This source seam
does not deploy, activate, capture real files, change an infrastructure pin, or
alter the generic server's private-context restrictions.
