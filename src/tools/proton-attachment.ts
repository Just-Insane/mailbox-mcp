import { createHash } from "node:crypto";
import { registerTool, hasPrivateAttachmentRoute, toolErrorSchema } from "./registry.js";

const fields = ["account", "message_id", "part_id", "expected_uid_validity", "format"] as const;
registerTool({
  name: "read_proton_attachment",
  description: "Private PCP programmatic handoff of one approved epoch-bound TXT/PDF attachment",
  inputSchema: { type: "object", additionalProperties: false,
    properties: { account: { type: "string", maxLength: 64 }, message_id: { type: "string", maxLength: 267 },
      part_id: { type: "string", maxLength: 64 }, expected_uid_validity: { type: "string", maxLength: 10 },
      format: { type: "string", enum: ["txt", "pdf"] } }, required: [...fields] },
  outputSchema: { type: "object", additionalProperties: false,
    properties: { schemaVersion: { type: "string", const: "1.0" }, error: toolErrorSchema,
      account: { type: "string" }, message_id: { type: "string" }, part_id: { type: "string" },
      uid_validity: { type: "string" }, filename: { type: "string", maxLength: 256 },
      mime_type: { type: "string", enum: ["text/plain", "application/pdf"] },
      size: { type: "integer", maximum: 2097152 }, sha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
      base64: { type: "string", maxLength: 2796204 } }, required: ["schemaVersion"] },
}, async (args, ctx) => {
  if (!hasPrivateAttachmentRoute(ctx) || Object.keys(args).length !== fields.length ||
      fields.some(field => typeof args[field] !== "string" || args[field] !== ctx.protonAttachment!.selection[field]))
    throw new Error("Attachment request does not match trusted approved selection");
  const provider = await ctx.getProvider(args.account as string);
  if (provider.type !== "imap" || !provider.capabilities.attachments || !provider.readAttachmentBounded)
    throw new Error("Bounded IMAP attachment capability unavailable");
  const limit = args.format === "txt" ? 65536 : 2097152;
  const result = await provider.readAttachmentBounded(args.message_id as string,
    args.part_id as string, args.expected_uid_validity as string, limit);
  if (`${result.folder}:${result.uid}` !== args.message_id || result.partId !== args.part_id ||
      result.uidValidity !== args.expected_uid_validity || !Buffer.isBuffer(result.data) ||
      result.data.length < 1 || result.data.length > limit ||
      result.mimeType !== (args.format === "txt" ? "text/plain" : "application/pdf") ||
      typeof result.filename !== "string" || result.filename.length < 1 || result.filename.length > 256 ||
      /[\x00-\x1f\x7f/\\]/.test(result.filename)) throw new Error("Attachment response outside trusted cohort");
  const structuredContent = { schemaVersion: "1.0", account: args.account,
    message_id: args.message_id, part_id: result.partId, uid_validity: result.uidValidity,
    filename: result.filename, mime_type: result.mimeType, size: result.data.length,
    sha256: createHash("sha256").update(result.data).digest("hex"), base64: result.data.toString("base64") };
  const response = { content: [{ type: "text" as const, text: "Verified attachment bytes for private programmatic ingestion" }], structuredContent };
  if (Buffer.byteLength(JSON.stringify(response)) > 3500000) throw new Error("Attachment response exceeds envelope limit");
  return response;
});
