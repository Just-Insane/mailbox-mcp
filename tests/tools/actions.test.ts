import { describe, it, expect, vi, beforeEach } from "vitest";
import { handleToolCall, type ToolContext } from "../../src/tools/registry.js";
import type { MailProvider } from "../../src/providers/interface.js";
import "../../src/tools/actions.js";

function createMockProvider(overrides: Partial<MailProvider> = {}): MailProvider {
  return {
    type: "gmail",
    capabilities: {
      threads: true, filters: true, templates: true, signatures: true,
      vacation: true, unsubscribe: true, attachments: true, inboxSummary: true,
    },
    markRead: vi.fn().mockResolvedValue(undefined),
    starMessage: vi.fn().mockResolvedValue(undefined),
    archiveMessage: vi.fn().mockResolvedValue(undefined),
    listDrafts: vi.fn().mockResolvedValue([]),
    sendDraft: vi.fn().mockResolvedValue("sent-id-1"),
    countUnreadByLabel: vi.fn().mockResolvedValue([]),
    messagesSince: vi.fn().mockResolvedValue([]),
    searchMessages: vi.fn().mockResolvedValue([]),
    ...overrides,
  } as unknown as MailProvider;
}

describe("action tools", () => {
  let provider: MailProvider;
  let ctx: ToolContext;

  beforeEach(() => {
    provider = createMockProvider();
    ctx = {
      accountManager: { listAccounts: vi.fn().mockReturnValue({ personal: {}, work: {} }) } as any,
      getProvider: vi.fn().mockResolvedValue(provider),
    };
  });

  it("mark_read defaults to true", async () => {
    await handleToolCall("mark_read", { account: "personal", message_id: "m1" }, ctx);
    expect(provider.markRead).toHaveBeenCalledWith("m1", true);
  });

  it("mark_read respects explicit false", async () => {
    await handleToolCall("mark_read", { account: "personal", message_id: "m1", read: false }, ctx);
    expect(provider.markRead).toHaveBeenCalledWith("m1", false);
  });

  it("star_email stars by default", async () => {
    await handleToolCall("star_email", { account: "personal", message_id: "m1" }, ctx);
    expect(provider.starMessage).toHaveBeenCalledWith("m1", true);
  });

  it("star_email with starred=false unstars", async () => {
    await handleToolCall("star_email", { account: "personal", message_id: "m1", starred: false }, ctx);
    expect(provider.starMessage).toHaveBeenCalledWith("m1", false);
  });

  it("archive_email calls provider", async () => {
    const r = await handleToolCall("archive_email", { account: "personal", message_id: "m1" }, ctx);
    expect(provider.archiveMessage).toHaveBeenCalledWith("m1");
    expect(r.content[0].text).toContain("archived");
  });

  it("list_drafts formats the response", async () => {
    (provider.listDrafts as any).mockResolvedValue([
      { id: "d1", subject: "Hello", to: ["a@b.com"], snippet: "", updatedAt: "2026-04-20T10:00:00Z" },
    ]);
    const r = await handleToolCall("list_drafts", { account: "personal" }, ctx);
    expect(r.content[0].text).toContain("d1");
    expect(r.content[0].text).toContain("Hello");
  });

  it("send_draft returns the sent message id", async () => {
    const r = await handleToolCall("send_draft", { account: "personal", draft_id: "d1" }, ctx);
    expect(provider.sendDraft).toHaveBeenCalledWith("d1");
    expect(r.content[0].text).toContain("sent-id-1");
  });

  it("count_unread_by_label shows non-zero counts only via provider output", async () => {
    (provider.countUnreadByLabel as any).mockResolvedValue([
      { labelId: "INBOX", name: "INBOX", unread: 5 },
      { labelId: "Work", name: "Work", unread: 2 },
    ]);
    const r = await handleToolCall("count_unread_by_label", { account: "personal" }, ctx);
    expect(r.content[0].text).toContain("INBOX");
    expect(r.content[0].text).toContain("5 unread");
  });

  it("emails_since passes timestamp and folder", async () => {
    await handleToolCall(
      "emails_since",
      { account: "personal", since: "2026-04-20T00:00:00Z", folder: "INBOX" },
      ctx,
    );
    expect(provider.messagesSince).toHaveBeenCalledWith("2026-04-20T00:00:00Z", "INBOX", 50);
  });

  it("multi_account_search runs across all accounts", async () => {
    (provider.searchMessages as any).mockResolvedValue([
      { id: "m1", from: "a@b.com", to: [], subject: "hit", snippet: "", date: "", labels: [], hasAttachments: false },
    ]);
    const r = await handleToolCall("multi_account_search", { query: "invoice" }, ctx);
    expect(ctx.getProvider).toHaveBeenCalledTimes(2); // personal + work
    expect(r.content[0].text).toContain("personal");
    expect(r.content[0].text).toContain("work");
    expect(r.content[0].text).toContain("hit");
  });

  it("multi_account_search handles per-account errors gracefully", async () => {
    (ctx.getProvider as any).mockImplementation((alias: string) => {
      if (alias === "work") throw new Error("auth failed");
      return provider;
    });
    const r = await handleToolCall("multi_account_search", { query: "test" }, ctx);
    expect(r.content[0].text).toContain("work");
    expect(r.content[0].text).toContain("Error");
  });
  it("emails_since displays both sender and receipt times from a paged provider", async () => {
    const paged = vi.fn().mockResolvedValue({ messages: [{ id: "INBOX:1", from: "synthetic@example.test", subject: "synthetic", date: "2000-01-01T00:00:00Z", receivedAt: "2026-10-05T13:00:00Z" }], complete: false, nextCursor: "opaque" });
    Object.assign(provider, { messagesSincePage: paged });
    const r = await handleToolCall("emails_since", { account: "personal", since: "2026-10-05T12:00:00Z", cursor: "prior" }, ctx);
    expect(paged).toHaveBeenCalledWith("2026-10-05T12:00:00Z", undefined, 50, "prior");
    expect(provider.messagesSince).not.toHaveBeenCalled();
    expect(r.content[0].text).toContain("Received: 2026-10-05T13:00:00Z");
    expect(r.content[0].text).toContain("Sender date: 2000-01-01T00:00:00Z");
    expect(r.content[0].text).toContain("Partial");
    expect(r.content[0].text).toContain("opaque");
  });
  it("emails_since does not describe an empty partial page as absence", async () => {
    Object.assign(provider, { messagesSincePage: vi.fn().mockResolvedValue({ messages: [], complete: false, nextCursor: "next" }) });
    const r = await handleToolCall("emails_since", { account: "personal", since: "2026-10-05T12:00:00Z" }, ctx);
    expect(r.content[0].text).toContain("Partial");
    expect(r.content[0].text).not.toContain("No messages since");
  });
  it("emails_since rejects continuation for legacy providers", async () => {
    const r = await handleToolCall("emails_since", { account: "personal", since: "2026-10-05T12:00:00Z", cursor: "next" }, ctx);
    expect(r.isError).toBe(true);
    expect(provider.messagesSince).not.toHaveBeenCalled();
  });

  it("emails_since labels an empty final continuation as no further messages", async () => {
    Object.assign(provider, { messagesSincePage: vi.fn().mockResolvedValue({ messages: [], complete: true }) });
    const r = await handleToolCall("emails_since", { account: "personal", since: "2026-10-05T12:00:00Z", cursor: "prior" }, ctx);
    expect(r.content[0].text).toContain("No further messages");
    expect(r.content[0].text).not.toContain("No messages since");
  });

  it("emails_since qualifies legacy-provider completeness", async () => {
    const r = await handleToolCall("emails_since", { account: "personal", since: "2026-10-05T12:00:00Z" }, ctx);
    expect(r.content[0].text).toContain("completeness is unverified");
  });

});
