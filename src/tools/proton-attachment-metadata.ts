import {registerTool, hasPrivateAttachmentMetadataRoute, toolErrorSchema} from "./registry.js";
import {metadataIdentity, validateAttachmentMetadata} from "../providers/proton-attachment-metadata.js";

const text = (maxLength: number) => ({type: "string" as const, maxLength});
const nullableText = (maxLength: number) => ({type: ["string", "null"] as const, maxLength});
const addressList = {type: "array" as const, maxItems: 64, items: text(4096)};
registerTool({
  name: "inspect_proton_attachment_metadata",
  description: "Private metadata-only inspection of one selected IMAP message. Initial UIDVALIDITY establishes a new identity; it does not map a legacy Search parent. Encoded part sizes are not decoded byte sizes.",
  inputSchema: {type: "object", additionalProperties: false, properties: {
    account: text(64), message_id: text(267), expected_uid_validity: text(10),
    limit: {type: "integer", minimum: 1, maximum: 100}}, required: ["account", "message_id", "limit"]},
  outputSchema: {type: "object", additionalProperties: false, properties: {
    schemaVersion: {type: "string", const: "1.0"}, error: toolErrorSchema, account: text(64), message_id: text(267),
    metadata: {type: "object", additionalProperties: false, properties: {
      folder: text(256), uid: {type: "integer", minimum: 1, maximum: 4294967295}, uidValidity: text(10),
      envelope: {type: "object", additionalProperties: false, properties: {
        internetMessageId: nullableText(4096), date: nullableText(64), internalDate: text(64),
        from: text(4096), to: addressList, cc: addressList, subject: text(16384),
        messageSize: {type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER}},
        required: ["internetMessageId", "date", "internalDate", "from", "to", "cc", "subject", "messageSize"]},
      attachments: {type: "array", maxItems: 100, items: {type: "object", additionalProperties: false,
        properties: {partId: text(64), filename: nullableText(256), mimeType: text(256),
          encodedSizeBytes: {type: ["integer", "null"], minimum: 0, maximum: Number.MAX_SAFE_INTEGER}, disposition: nullableText(32)},
        required: ["partId", "filename", "mimeType", "encodedSizeBytes", "disposition"]}},
      limit: {type: "integer", minimum: 1, maximum: 100}, truncated: {type: "boolean"}},
      required: ["folder", "uid", "uidValidity", "envelope", "attachments", "limit", "truncated"]}},
    required: ["schemaVersion"], oneOf: [{required: ["account", "message_id", "metadata"]}, {required: ["error"]}]},
}, async (args, ctx) => {
  const selection = ctx.protonAttachmentMetadata?.selection;
  const selectionFields = (["account", "message_id", "limit", "expected_uid_validity"] as const)
    .filter(key => key !== "expected_uid_validity" || selection?.expected_uid_validity !== undefined);
  if (!hasPrivateAttachmentMetadataRoute(ctx) || !selection ||
      Object.keys(args).length !== selectionFields.length ||
      selectionFields.some(key => args[key] !== selection[key]))
    throw new Error("Metadata request does not match trusted exact-parent selection");
  try {
    const provider = await ctx.getProvider(selection.account);
    if (provider.type !== "imap" || !provider.capabilities.attachments || !provider.inspectAttachmentMetadata)
      throw new Error("Metadata capability unavailable");
    const metadata = validateAttachmentMetadata(await provider.inspectAttachmentMetadata(selection.message_id, {
      limit: selection.limit, ...(selection.expected_uid_validity !== undefined ? {expectedUidValidity: selection.expected_uid_validity} : {}),
    }));
    const identity = metadataIdentity(selection.message_id);
    if (metadata.folder !== identity.folder || metadata.uid !== identity.uid || metadata.limit !== selection.limit ||
        (selection.expected_uid_validity !== undefined && metadata.uidValidity !== selection.expected_uid_validity))
      throw new Error("Metadata identity changed");
    const response = {content: [{type: "text" as const, text: "Exact-parent attachment metadata for private programmatic ingestion"}],
      structuredContent: {schemaVersion: "1.0", account: selection.account, message_id: selection.message_id, metadata}};
    if (Buffer.byteLength(JSON.stringify(response), "utf8") > 262144) throw new Error("Metadata envelope exceeds bound");
    return response;
  } catch { throw new Error("Proton attachment metadata unavailable"); }
});
