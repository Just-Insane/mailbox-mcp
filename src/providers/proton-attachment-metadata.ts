/** A metadata observation establishes a new epoch identity, never equivalence to Search. */
export interface AttachmentMetadataOptions { expectedUidValidity?: string; limit?: number }
export interface AttachmentMetadata {
  folder: string; uid: number; uidValidity: string;
  envelope: { internetMessageId: string | null; date: string | null; internalDate: string;
    from: string; to: string[]; cc: string[]; subject: string; messageSize: number };
  attachments: Array<{ partId: string; filename: string | null; mimeType: string;
    encodedSizeBytes: number | null; disposition: string | null }>;
  limit: number; truncated: boolean;
}
const invalid = (): never => { throw new Error("Proton attachment metadata invalid or outside bounds"); };
export function metadataText(value: unknown, max: number, empty = true): string {
  if (typeof value !== "string" || value.length > max || (!empty && !value) || /[\x00-\x1f\x7f]/.test(value)) invalid();
  return value as string;
}
export function metadataEpoch(value: unknown): string {
  if (typeof value !== "string" || !/^[1-9][0-9]{0,9}$/.test(value) || Number(value) > 4294967295) invalid();
  return value as string;
}
export function metadataIdentity(messageId: unknown) {
  const match = /^([^\x00-\x1f\x7f]{1,256}):([1-9][0-9]{0,9})$/.exec(typeof messageId === "string" ? messageId : "");
  if (!match || Number(match[2]) > 4294967295) invalid();
  return { folder: match![1], uid: Number(match![2]) };
}
export function metadataLimit(value: unknown): number {
  if (!Number.isInteger(value) || Number(value) < 1 || Number(value) > 100) invalid();
  return value as number;
}
export function metadataDate(value: unknown, required = false): string | null {
  if (value == null && !required) return null;
  const date = value instanceof Date ? value : typeof value === "string" && value.length <= 64 ? new Date(value) : null;
  if (!date || !Number.isFinite(date.getTime())) invalid();
  return date!.toISOString();
}
function integer(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) invalid();
  return value as number;
}
function keys(value: unknown, expected: string[]): asserts value is Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== expected.length ||
      expected.some(key => !Object.prototype.hasOwnProperty.call(value, key))) invalid();
}
function addresses(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 64) invalid();
  return (value as unknown[]).map(address => metadataText(address, 4096));
}
export function validateAttachmentMetadataPart(part: unknown): AttachmentMetadata["attachments"][number] {
  keys(part, ["partId", "filename", "mimeType", "encodedSizeBytes", "disposition"]);
  if (typeof part.partId !== "string" || part.partId.length > 64 || !/^[1-9][0-9]*(?:\.[1-9][0-9]*)*$/.test(part.partId)) invalid();
  if (part.filename !== null && /[/\\]/.test(metadataText(part.filename, 256, false))) invalid();
  if (!/^[a-z0-9!#$&^_.+%-]+\/[a-z0-9!#$&^_.+%-]+$/i.test(metadataText(part.mimeType, 256, false))) invalid();
  if (part.encodedSizeBytes !== null) integer(part.encodedSizeBytes);
  if (part.disposition !== null && !/^[a-z-]+$/i.test(metadataText(part.disposition, 32, false))) invalid();
  return part as AttachmentMetadata["attachments"][number];
}
/** Strict provider/tool output boundary, including aggregate serialized bounds. */
export function validateAttachmentMetadata(value: unknown): AttachmentMetadata {
  keys(value, ["folder", "uid", "uidValidity", "envelope", "attachments", "limit", "truncated"]);
  const identity = metadataIdentity(`${metadataText(value.folder, 256, false)}:${value.uid}`);
  if (identity.uid !== value.uid) invalid();
  metadataEpoch(value.uidValidity); const limit = metadataLimit(value.limit);
  keys(value.envelope, ["internetMessageId", "date", "internalDate", "from", "to", "cc", "subject", "messageSize"]);
  const e = value.envelope;
  if (e.internetMessageId !== null) metadataText(e.internetMessageId, 4096);
  if (e.date !== null && metadataDate(e.date) !== e.date) invalid();
  if (metadataDate(e.internalDate, true) !== e.internalDate) invalid();
  metadataText(e.from, 4096); addresses(e.to); addresses(e.cc); metadataText(e.subject, 16384); integer(e.messageSize);
  if (!Array.isArray(value.attachments) || value.attachments.length > limit || typeof value.truncated !== "boolean" ||
      (value.truncated && value.attachments.length !== limit)) invalid();
  const seen = new Set<string>();
  for (const part of value.attachments) {
    validateAttachmentMetadataPart(part);
    if (seen.has(part.partId)) invalid();
    seen.add(part.partId);
  }
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > 262144) invalid();
  return value as unknown as AttachmentMetadata;
}
