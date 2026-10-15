import {handleToolCall, hasPrivateAttachmentRoute, hasPrivateAttachmentMetadataRoute, type ToolContext} from "./tools/registry.js";
import "./tools/proton-attachment.js";
import "./tools/proton-attachment-metadata.js";

export interface GatewayIdentity {
  principal: string; audience: string;
  /** Original host request-target captured before WHATWG Request/URL normalization. */
  requestTarget: string;
}
/** Supplied by the existing authenticated gateway; caller headers are not identity. */
export type GatewayVerifier = (request: Request, signal: AbortSignal) => Promise<GatewayIdentity | null>;
export interface ProtonPrivatePolicy {
  status: "qualified"; principal: string; audience: string; receiptReference: string; expiresAt: string;
  metadataSelection?: NonNullable<ToolContext["protonAttachmentMetadata"]>["selection"];
  attachmentSelection?: NonNullable<ToolContext["protonAttachment"]>["selection"];
}
export interface ProtonPrivateHandlerOptions {
  policy?: unknown;
  verifyGateway?: GatewayVerifier;
  context?: Pick<ToolContext, "accountManager" | "getProvider">;
  now?: () => number;
}
const REQUEST_BYTES = 4096;
const DEADLINE_MS = 30000;
class Failure extends Error {
  constructor(readonly status: number, readonly code: string) {super(code);}
}
const denied = () => new Failure(403, "PROTON_PRIVATE_ACCESS_DENIED");
const unavailable = () => new Failure(503, "PROTON_PRIVATE_UNAVAILABLE");
function response(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {status, headers: {"content-type": "application/json",
    "cache-control": "private, no-store", "x-content-type-options": "nosniff"}});
}
function text(value: unknown, max: number) {
  return typeof value === "string" && value.trim().length > 0 && value.length <= max && !/[\x00-\x1f\x7f]/.test(value);
}
function policySnapshot(input: unknown): ProtonPrivatePolicy {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw denied();
  const encoded = JSON.stringify(input);
  if (Buffer.byteLength(encoded, "utf8") > 16384) throw denied();
  const policy = JSON.parse(encoded);
  if (Object.keys(policy).some(key => !["status", "principal", "audience", "receiptReference", "expiresAt", "metadataSelection", "attachmentSelection"].includes(key)) ||
      policy.status !== "qualified" || !text(policy.principal, 256) || !text(policy.audience, 256) || !text(policy.receiptReference, 512) ||
      !text(policy.expiresAt, 64) || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(policy.expiresAt) ||
      !Number.isFinite(Date.parse(policy.expiresAt))) throw denied();
  return policy;
}
async function readJson(request: Request, signal: AbortSignal): Promise<Record<string, unknown>> {
  if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json")
    throw new Failure(400, "INVALID_REQUEST");
  const length = request.headers.get("content-length");
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > REQUEST_BYTES))
    throw new Failure(413, "REQUEST_TOO_LARGE");
  const reader = request.body?.getReader();
  if (!reader) throw new Failure(400, "INVALID_REQUEST");
  const cancel = () => {void reader.cancel().catch(() => undefined);};
  signal.addEventListener("abort", cancel, {once: true});
  try {
    const chunks: Uint8Array[] = []; let size = 0;
    while (true) {
      if (signal.aborted) throw unavailable();
      const part = await reader.read();
      if (signal.aborted) throw unavailable();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > REQUEST_BYTES) {cancel(); throw new Failure(413, "REQUEST_TOO_LARGE");}
      chunks.push(part.value);
    }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) {bytes.set(chunk, offset); offset += chunk.length;}
    let parsed: unknown;
    try {parsed = JSON.parse(new TextDecoder("utf-8", {fatal: true}).decode(bytes));}
    catch {throw new Failure(400, "INVALID_REQUEST");}
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Failure(400, "INVALID_REQUEST");
    return parsed as Record<string, unknown>;
  } finally {signal.removeEventListener("abort", cancel); reader.releaseLock();}
}

/** Executable private adapter. The generic stdio server deliberately never imports/mounts it. */
export function createProtonPrivateHandler(options: ProtonPrivateHandlerOptions = {}): (request: Request) => Promise<Response> {
  return async request => {
    const url = new URL(request.url);
    const operation = url.pathname === "/v1/private/proton/metadata" ? "metadata" :
      url.pathname === "/v1/private/proton/attachment" ? "attachment" : null;
    if (!operation) return response({error: "NOT_FOUND"}, 404);
    const canonicalTarget = operation === "metadata" ? "/v1/private/proton/metadata" : "/v1/private/proton/attachment";
    if (url.search || url.hash) return response({error: "INVALID_REQUEST"}, 400);
    if (request.method !== "POST") return response({error: "METHOD_NOT_ALLOWED"}, 405);
    const abort = new AbortController(); let timedOut = false;
    const timer = setTimeout(() => {timedOut = true; abort.abort();}, DEADLINE_MS);
    const onRequestAbort = () => abort.abort();
    request.signal.addEventListener("abort", onRequestAbort, {once: true});
    if (request.signal.aborted) abort.abort();
    let onAbort: () => void = () => undefined;
    try {
      const policy = policySnapshot(options.policy);
      if (typeof options.verifyGateway !== "function" || typeof options.context?.getProvider !== "function" || !options.context.accountManager) throw denied();
      const verify = options.verifyGateway, baseContext = options.context;
      const selection = operation === "metadata" ? policy.metadataSelection : policy.attachmentSelection;
      if (!selection) throw denied();
      const assertActive = () => {
        if (abort.signal.aborted) throw unavailable();
        const now = options.now?.() ?? Date.now();
        if (!Number.isFinite(now) || now >= Date.parse(policy.expiresAt)) throw denied();
      };
      const context: ToolContext = {accountManager: baseContext.accountManager, getProvider: async alias => {
        assertActive(); if (alias !== selection.account) throw denied();
        const provider = await baseContext.getProvider(alias); assertActive(); return provider;
      }, ...(operation === "metadata" ? {protonAttachmentMetadata: {programmaticRoute: "pcp-authenticated" as const, selection: policy.metadataSelection!}} :
        {protonAttachment: {programmaticRoute: "pcp-authenticated" as const, selection: policy.attachmentSelection!}})};
      if (operation === "metadata" ? !hasPrivateAttachmentMetadataRoute(context) : !hasPrivateAttachmentRoute(context)) throw denied();
      if (operation === "attachment" && Object.keys(selection).some(key => !["account", "message_id", "part_id", "expected_uid_validity", "format"].includes(key))) throw denied();
      assertActive();
      const deadline = new Promise<never>((_, reject) => {
        onAbort = () => reject(unavailable());
        abort.signal.addEventListener("abort", onAbort, {once: true});
        if (abort.signal.aborted) onAbort();
      });
      const run = async () => {
        const identity = await verify(request, abort.signal); assertActive();
        if (!identity || identity.principal !== policy.principal || identity.audience !== policy.audience ||
            identity.requestTarget !== canonicalTarget) throw denied();
        const input = await readJson(request, abort.signal); assertActive();
        // Only this operation's independently fixed policy can create its private tool context.
        const result = await handleToolCall(operation === "metadata" ? "inspect_proton_attachment_metadata" : "read_proton_attachment", input, context);
        assertActive();
        if (result.isError || !result.structuredContent) throw unavailable();
        const encoded = JSON.stringify(result.structuredContent);
        if (Buffer.byteLength(encoded, "utf8") > (operation === "metadata" ? 262144 : 3500000)) throw unavailable();
        return response(result.structuredContent, 200);
      };
      return await Promise.race([run(), deadline]);
    } catch (error) {
      if (timedOut) return response({error: "PROTON_PRIVATE_UNAVAILABLE"}, 504);
      return error instanceof Failure ? response({error: error.code}, error.status) : response({error: "PROTON_PRIVATE_UNAVAILABLE"}, 503);
    } finally {
      clearTimeout(timer); request.signal.removeEventListener("abort", onRequestAbort);
      abort.signal.removeEventListener("abort", onAbort);
    }
  };
}
