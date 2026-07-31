import { describe, it, expect, beforeEach, vi } from "vitest";
import { getAllToolDefinitions, handleToolCall, type ToolContext } from "../../src/tools/registry.js";
import type { MailProvider } from "../../src/providers/interface.js";
import "../../src/tools/read.js";

function createMockProvider(): MailProvider {
  return {
    type: "gmail",
    capabilities: { threads: true, filters: true, templates: true, signatures: true, vacation: true, unsubscribe: true, attachments: true, inboxSummary: true },
    searchMessages: vi.fn().mockResolvedValue([{ id: "msg-1", from: "sender@test.com", to: ["me@test.com"], subject: "Test", snippet: "Hello", date: "2026-03-27", labels: ["INBOX"], hasAttachments: false }]),
    readMessage: vi.fn().mockResolvedValue({ id: "msg-1", from: "sender@test.com", to: ["me@test.com"], subject: "Test", snippet: "Hello", date: "2026-03-27", labels: ["INBOX"], hasAttachments: false, body: "Hello world", cc: [], bcc: [], attachments: [] }),
    readThread: vi.fn().mockResolvedValue({ id: "thread-1", subject: "Test", messages: [{ id: "msg-1", from: "sender@test.com", to: ["me@test.com"], subject: "Test", snippet: "Hello", date: "2026-03-27", labels: [], hasAttachments: false, body: "Thread body content", cc: [], bcc: [], attachments: [] }] }),
    inboxSummary: vi.fn().mockResolvedValue({ total: 42, unread: 5, recent: [] }),
  } as unknown as MailProvider;
}

describe("read tools", () => {
  let mockProvider: MailProvider;
  let ctx: ToolContext;

  beforeEach(() => {
    mockProvider = createMockProvider();
    ctx = { accountManager: { listAccounts: vi.fn(), getAccount: vi.fn() } as any, getProvider: vi.fn().mockReturnValue(mockProvider) };
  });

  it("advertises versioned output schemas for PCP mail reads", () => {
    for (const name of ["search_emails", "read_email"]) {
      const definition = getAllToolDefinitions().find(tool => tool.name === name);
      expect(definition?.outputSchema).toEqual(expect.objectContaining({
        type: "object",
        properties: expect.objectContaining({
          schemaVersion: { type: "string", const: "1.0" },
        }),
      }));
    }
  });

  it("search_emails returns results", async () => {
    const result = await handleToolCall("search_emails", { account: "personal", query: "from:sender" }, ctx);
    expect(result.content[0].text).toContain("msg-1");
    expect(result.content[0].text).toContain("sender@test.com");
    expect(result.structuredContent).toEqual({
      schemaVersion: "1.0",
      messages: [expect.objectContaining({ id: "msg-1" })],
    });
  });

  it("read_email fences body and subject at MCP exit", async () => {
    const result = await handleToolCall("read_email", { account: "personal", message_id: "msg-1" }, ctx);
    expect(result.content[0].text).toContain("Hello world");
    expect(result.content[0].text).toContain("[UNTRUSTED_EMAIL_CONTENT]");
    expect(result.content[0].text).toContain("[UNTRUSTED_SUBJECT]");
    expect(result.structuredContent).toEqual({
      schemaVersion: "1.0",
      message: expect.objectContaining({ id: "msg-1", body: "Hello world" }),
    });
  });

  it("returns schema-compatible structured content when a structured tool fails", async () => {
    vi.mocked(mockProvider.searchMessages).mockRejectedValueOnce(new Error("mail service unavailable"));

    const result = await handleToolCall("search_emails", { account: "personal", query: "from:sender" }, ctx);

    expect(result).toMatchObject({
      isError: true,
      structuredContent: {
        schemaVersion: "1.0",
        error: { code: "tool_execution_failed", message: "mail service unavailable" },
      },
    });
  });

  it("read_thread fences body and subject at MCP exit", async () => {
    const result = await handleToolCall("read_thread", { account: "personal", thread_id: "thread-1" }, ctx);
    expect(result.content[0].text).toContain("thread-1");
    expect(result.content[0].text).toContain("Thread body content");
    expect(result.content[0].text).toContain("[UNTRUSTED_EMAIL_CONTENT]");
    expect(result.content[0].text).toContain("[UNTRUSTED_SUBJECT]");
  });

  it("inbox_summary returns counts", async () => {
    const result = await handleToolCall("inbox_summary", { account: "personal" }, ctx);
    expect(result.content[0].text).toContain("42");
    expect(result.content[0].text).toContain("5");
  });
});
