import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { getAllToolDefinitions, handleToolCall, type ToolContext } from "../../src/tools/registry.js";
const modulePath = "../../src/tools/proton-attachment.js";
await import(modulePath).catch(() => undefined); // Red checkpoint: the new registered tool is absent.
const request = { account: "proton", message_id: "INBOX:7", part_id: "2",
  expected_uid_validity: "42", format: "txt" };
function context() {
  const data = Buffer.from("check-in 17:40; bring printed confirmation");
  const provider = { type: "imap", capabilities: { attachments: true },
    readAttachmentBounded: vi.fn().mockResolvedValue({ folder: "INBOX", uid: 7,
      uidValidity: "42", partId: "2", filename: "workshop.txt", mimeType: "text/plain", data }) };
  const ctx = { accountManager: {} as any, getProvider: vi.fn().mockReturnValue(provider),
    protonAttachment: { programmaticRoute: "pcp-authenticated", selection: request } } as ToolContext;
  return { ctx, provider, data };
}
afterEach(() => { delete process.env.MAILBOX_MCP_TOOLS; });
describe("private attachment tool", () => {
  it("returns base64 once with digest/length and no path or duplicated binary text", async () => {
    const f = context(); const result = await handleToolCall("read_proton_attachment", request, f.ctx);
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({ schemaVersion: "1.0", account: "proton",
      message_id: "INBOX:7", part_id: "2", uid_validity: "42", size: f.data.length,
      sha256: createHash("sha256").update(f.data).digest("hex"), base64: f.data.toString("base64") });
    expect(result.content[0].text).not.toContain(f.data.toString("base64"));
    expect(JSON.stringify(result)).not.toContain("/tmp/");
  });
  it("stays absent in generic discovery despite broad attachments", () => {
    process.env.MAILBOX_MCP_TOOLS = "attachments";
    expect(getAllToolDefinitions().map(x => x.name)).not.toContain("read_proton_attachment");
    expect(getAllToolDefinitions(context().ctx).map(x => x.name)).toContain("read_proton_attachment");
  });
  it("stays absent and uncallable in core-only discovery", async () => {
    process.env.MAILBOX_MCP_TOOLS = "core"; const f = context();
    expect(getAllToolDefinitions(f.ctx).map(x => x.name)).not.toContain("read_proton_attachment");
    expect((await handleToolCall("read_proton_attachment", request, f.ctx)).isError).toBe(true);
    expect(f.ctx.getProvider).not.toHaveBeenCalled();
  });
  it.each([{ consumer: "pcp" }, { destination: "private-r2" }, { part_id: "1" },
    { expected_uid_validity: "43" }, {expected_uid_validity:undefined}, { account: "other" }, { message_id: "INBOX:8" }])("denies caller spoof/selection mismatch before provider access %j", async change => {
    const f = context(); const result = await handleToolCall("read_proton_attachment", { ...request, ...change }, f.ctx);
    expect(result.isError).toBe(true); expect(f.ctx.getProvider).not.toHaveBeenCalled();
  });
  it("denies a generic direct call with no trusted route/selection", async () => {
    const f = context(); delete (f.ctx as any).protonAttachment;
    expect((await handleToolCall("read_proton_attachment", request, f.ctx)).isError).toBe(true);
    expect(f.ctx.getProvider).not.toHaveBeenCalled();
  });
  it("denies unsupported provider capability", async () => {
    const f = context(); f.provider.capabilities.attachments = false;
    expect((await handleToolCall("read_proton_attachment", request, f.ctx)).isError).toBe(true);
    expect(f.provider.readAttachmentBounded).not.toHaveBeenCalled();
  });
  it("fits the actual structured PDF envelope below the existing cap", async () => {
    const f = context(); const selection = { ...request, format: "pdf" };
    (f.ctx as any).protonAttachment.selection = selection;
    f.provider.readAttachmentBounded.mockResolvedValue({ folder: "INBOX", uid: 7, uidValidity: "42",
      partId: "2", filename: "workshop.pdf", mimeType: "application/pdf", data: Buffer.alloc(2 * 1024 * 1024, 65) });
    const result = await handleToolCall("read_proton_attachment", selection, f.ctx);
    expect(result.isError).not.toBe(true); expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(3500000);
  });
});
