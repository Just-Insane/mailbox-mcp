import { describe, expect, it, vi } from "vitest";
import { ImapProvider } from "../../src/providers/imap.js";

const cutoff = "2026-10-05T12:00:00Z";
const received = "2026-10-05T13:00:00Z";

function harness(rows: any[]) {
  const release = vi.fn();
  const fetched: number[][] = [];
  const client = {
    host: "imap.synthetic.test", port: 993, options: { auth: { user: "synthetic-user", authzid: "" } },
    mailboxOpen: vi.fn().mockResolvedValue({ uidNext: Math.max(2, ...rows.map(row => row.uid + 1)), uidValidity: 7n }),
    getMailboxLock: vi.fn().mockResolvedValue({ release }),
    search: vi.fn().mockResolvedValue(rows.map(row => row.uid)),
    fetchAll: vi.fn(async (uids: number[]) => {
      fetched.push(uids);
      // IMAP responses need not preserve the requested UID ordering.
      return rows.filter(row => uids.includes(row.uid));
    }),
  };
  return { provider: new ImapProvider(client as any, {} as any, "synthetic@example.test"), client, release, fetched };
}

function row(uid: number, internalDate: unknown = new Date(received)) {
  return { uid, internalDate, envelope: { date: new Date("2000-01-01T00:00:00Z"), subject: "synthetic" } };
}

describe("IMAP received-time polling", () => {
  it("preserves sender Date and supplies explicit receivedAt", async () => {
    const { provider } = harness([row(1)]);
    expect((await provider.messagesSince(cutoff))[0]).toMatchObject({ date: "2000-01-01T00:00:00.000Z", receivedAt: "2026-10-05T13:00:00.000Z" });
  });

  it("excludes equality and earlier same-day rows before applying the cap", async () => {
    const { provider, fetched } = harness([
      row(1), row(2, new Date(cutoff)), row(3, new Date("2026-10-05T11:59:59Z")),
    ]);
    expect((await provider.messagesSince(cutoff, "Archive", 1)).map(item => item.id)).toEqual(["Archive:1"]);
    expect(fetched.flat()).toContain(1);
  });

  it("continues bounded metadata batches past ineligible high UIDs", async () => {
    const { provider, fetched } = harness(Array.from({ length: 103 }, (_, i) =>
      row(i + 1, new Date(i === 0 ? received : cutoff))));
    expect((await provider.messagesSince(cutoff, "INBOX", 1)).map(item => item.id)).toEqual(["INBOX:1"]);
    expect(fetched.every(batch => batch.length <= 100)).toBe(true);
  });

  it("orders selected summaries by UID regardless of fetch response order", async () => {
    const { provider } = harness([row(2), row(5), row(9)]);
    expect((await provider.messagesSincePage("2026-10-05T14:00:00+02:00", "Sent", 2)).messages.map(item => item.id)).toEqual(["Sent:9", "Sent:5"]);
  });

  it.each([undefined, false, new Date(NaN)])("fails closed for invalid received time %s", async internalDate => {
    const { provider, release } = harness([{ ...row(1), internalDate }]);
    await expect(provider.messagesSince(cutoff)).rejects.toThrow("Invalid IMAP internalDate");
    expect(release).toHaveBeenCalledOnce();
  });

  it("uses a prior UTC day candidate search and a read-only folder lock", async () => {
    const { provider, client } = harness([]);
    await provider.messagesSince("2026-10-05T00:30:00Z", "Archive");
    expect(client.search).toHaveBeenCalledWith({ since: new Date("2026-10-04T00:00:00Z"), uid: "1:1" }, { uid: true });
    expect(client.getMailboxLock).toHaveBeenCalledWith("Archive", { readOnly: true });
  });

  it('preserves years below 100 in the candidate search', async () => {
    const { provider, client } = harness([]);
    await provider.messagesSince('0099-10-05T12:00:00Z');
    expect(client.search).toHaveBeenCalledWith({ since: new Date('0099-10-04T00:00:00Z'), uid: '1:1' }, { uid: true });
  });

  it('includes a received instant whose original timezone has a prior calendar day', async () => {
    const { provider, client } = harness([row(1, new Date('2026-10-04T23:45:00-02:00'))]);
    expect((await provider.messagesSince('2026-10-05T00:30:00Z'))[0].receivedAt).toBe('2026-10-05T01:45:00.000Z');
    expect(client.fetchAll).toHaveBeenCalledWith([1], {
      envelope: true, flags: true, bodyStructure: true, uid: true, internalDate: true,
    }, { uid: true });
  });

  it.each([0, -1, 1.5, NaN])("rejects an invalid cap %s before accessing IMAP", async cap => {
    const { provider, client } = harness([]);
    await expect(provider.messagesSince(cutoff, "INBOX", cap)).rejects.toThrow("Invalid maxResults");
    expect(client.getMailboxLock).not.toHaveBeenCalled();
  });
});

function createMockImapClient() {
  return {
    host: "imap.synthetic.test",
    port: 993,
    options: { auth: { user: "synthetic-user", authzid: "" } },
    connect: vi.fn(),
    logout: vi.fn(),
    search: vi.fn(),
    fetch: vi.fn(),
    fetchOne: vi.fn(),
    fetchAll: vi.fn(),
    download: vi.fn(),
    messageDelete: vi.fn(),
    messageFlagsAdd: vi.fn(),
    messageFlagsRemove: vi.fn(),
    messageMove: vi.fn(),
    mailboxCreate: vi.fn(),
    mailboxDelete: vi.fn(),
    list: vi.fn(),
    mailboxOpen: vi.fn().mockResolvedValue({ uidNext: 100, uidValidity: 7n }),
    append: vi.fn(),
    getMailboxLock: vi.fn().mockResolvedValue({ release: vi.fn() }),
    on: vi.fn(),
    mailbox: { exists: 0, unseen: 0, uidValidity: 7n, uidNext: 100 },
  };
}


// C4/#1191: synthetic receipt metadata only; no mailbox access.
describe("IMAP precise receipt windows", () => {
  const cutoff = "2026-10-05T12:00:00Z";
  const received = "2026-10-05T13:00:00Z";
  function row(uid: number, internalDate: unknown = new Date(received)) {
    return { uid, internalDate, envelope: { date: new Date("2000-01-01T00:00:00Z"), subject: "synthetic" } };
  }
  function harness(rows: any[], uidNext = 100) {
    const client = createMockImapClient();
    Object.assign(client.mailbox, { uidValidity: 7n, uidNext });
    client.mailboxOpen.mockImplementation(async () => ({ uidNext: client.mailbox.uidNext, uidValidity: client.mailbox.uidValidity }));
    client.search.mockImplementation(async (query: any) => {
      const [lo, hi] = query.uid ? query.uid.split(":").map(Number) : [1, Infinity];
      return rows.filter(r => r.uid >= lo && r.uid <= hi).map(r => r.uid);
    });
    client.fetchAll.mockImplementation(async (uids: number[]) => rows.filter(r => uids.includes(r.uid)));
    const provider = new ImapProvider(client as any, {} as any, "synthetic@example.test");
    return { provider, client };
  }
  it("excludes same-day receipt instants before and equal to cutoff", async () => {
    const { provider } = harness([row(1), row(2, new Date(cutoff)), row(3, new Date("2026-10-05T11:59:59Z"))]);
    expect((await provider.messagesSince(cutoff)).map(m => m.id)).toEqual(["INBOX:1"]);
  });
  it("finds a qualifying low UID hidden by pre-filter limiting", async () => {
    const { provider } = harness([row(1), row(2, new Date(cutoff)), row(3, new Date(cutoff))]);
    expect((await provider.messagesSince(cutoff, "Archive", 1)).map(m => m.id)).toEqual(["Archive:1"]);
  });
  it("preserves sender date and exposes receipt time separately", async () => {
    const { provider } = harness([row(1)]);
    expect((await provider.messagesSince(cutoff))[0]).toMatchObject({ date: "2000-01-01T00:00:00.000Z", receivedAt: "2026-10-05T13:00:00.000Z" });
  });
  it.each([undefined, false, new Date(NaN)])("fails closed for invalid INTERNALDATE %s", async internalDate => {
    const { provider, client } = harness([{ ...row(1), internalDate }]);
    await expect(provider.messagesSince(cutoff)).rejects.toThrow("Invalid IMAP internalDate");
    expect((await client.getMailboxLock.mock.results[0].value).release).toHaveBeenCalledOnce();
  });
  it.each([0, -1, 1.5, NaN, 501])("rejects an invalid result limit %s before IMAP", async limit => {
    const { provider, client } = harness([]);
    await expect(provider.messagesSince(cutoff, "INBOX", limit)).rejects.toThrow("Invalid maxResults");
    expect(client.getMailboxLock).not.toHaveBeenCalled();
  });
  it("bounds metadata work and resumes past an empty partial page", async () => {
    const rows = Array.from({ length: 601 }, (_, i) => row(i + 1, new Date(i === 0 ? received : cutoff)));
    const { provider, client } = harness(rows, 602);
    const first = await provider.messagesSincePage(cutoff, "INBOX", 1);
    expect(first.messages).toEqual([]);
    expect(first.complete).toBe(false);
    expect(first.nextCursor).toEqual(expect.any(String));
    expect(client.fetchAll.mock.calls.flatMap(c => c[0])).toHaveLength(500);
    expect(client.fetchAll.mock.calls.every(c => c[0].length <= 100)).toBe(true);
    const second = await provider.messagesSincePage(cutoff, "INBOX", 1, first.nextCursor);
    expect(second.messages.map(m => m.id)).toEqual(["INBOX:1"]);
    expect(second.complete).toBe(true);
    expect(second.nextCursor).toBeUndefined();
  });
  it("continues at the last inspected UID without skipping fetched matches", async () => {
    const { provider } = harness([row(7), row(2), row(5)], 8);
    const first = await provider.messagesSincePage(cutoff, "INBOX", 1);
    expect(first.messages.map(m => m.id)).toEqual(["INBOX:7"]);
    const second = await provider.messagesSincePage(cutoff, "INBOX", 2, first.nextCursor);
    expect(second.messages.map(m => m.id)).toEqual(["INBOX:5", "INBOX:2"]);
    expect(second.complete).toBe(true);
  });
  it("does not silently truncate the legacy array contract", async () => {
    const { provider } = harness([row(1), row(2)]);
    await expect(provider.messagesSince(cutoff, "INBOX", 1)).rejects.toThrow("messagesSincePage");
  });
  it("binds continuation to folder, cutoff and mailbox epoch", async () => {
    const { provider, client } = harness([row(1), row(2)]);
    const first = await provider.messagesSincePage(cutoff, "INBOX", 1);
    await expect(provider.messagesSincePage(cutoff, "Archive", 1, first.nextCursor)).rejects.toThrow("Invalid receipt cursor");
    await expect(provider.messagesSincePage(received, "INBOX", 1, first.nextCursor)).rejects.toThrow("Invalid receipt cursor");
    Object.assign(client.mailbox, { uidValidity: 8n });
    await expect(provider.messagesSincePage(cutoff, "INBOX", 1, first.nextCursor)).rejects.toThrow("Mailbox epoch changed");
  });
  it.each([
    ["2026-10-05T00:30:00Z", "2026-10-04T23:45:00-02:00", "2026-10-04T00:00:00Z"],
    ["2026-11-01T01:30:00-04:00", "2026-11-01T01:15:00-05:00", "2026-10-31T00:00:00Z"],
    ["0099-10-05T12:00:00Z", "0099-10-05T13:00:00Z", "0099-10-04T00:00:00Z"],
  ])("uses precise instants and conservative calendar search for %s", async (since, receipt, day) => {
    const { provider, client } = harness([row(1, new Date(receipt))]);
    expect((await provider.messagesSince(since))[0].id).toBe("INBOX:1");
    expect(client.search).toHaveBeenCalledWith(expect.objectContaining({ since: new Date(day) }), { uid: true });
    expect(client.getMailboxLock).toHaveBeenCalledWith("INBOX", { readOnly: true });
  });

  it("continues an empty sparse UID range without claiming completeness", async () => {
    const { provider, client } = harness([row(1)], 2002);
    const first = await provider.messagesSincePage(cutoff);
    expect(first).toMatchObject({ messages: [], complete: false, nextCursor: expect.any(String) });
    const second = await provider.messagesSincePage(cutoff, "INBOX", 50, first.nextCursor);
    expect(second.messages).toEqual([]);
    expect(second.complete).toBe(false);
    const third = await provider.messagesSincePage(cutoff, "INBOX", 50, second.nextCursor);
    expect(third.messages.map(m => m.id)).toEqual(["INBOX:1"]);
    expect(third.complete).toBe(true);
    expect(client.search.mock.calls.map(c => c[0].uid)).toEqual(["1002:2001", "2:1001", "1:1"]);
  });
  it("rejects continuation from a different account identity", async () => {
    const { provider, client } = harness([row(1), row(2)]);
    const first = await provider.messagesSincePage(cutoff, "INBOX", 1);
    const other = new ImapProvider(client as any, {} as any, "other@example.test");
    await expect(other.messagesSincePage(cutoff, "INBOX", 1, first.nextCursor)).rejects.toThrow("Invalid receipt cursor");
  });

  it.each(["host", "port", "user", "authzid"])("rejects same-email continuation for a different IMAP %s", async field => {
    const { provider } = harness([row(1), row(2)]);
    const first = await provider.messagesSincePage(cutoff, "INBOX", 1);
    const other = harness([row(1), row(2)]);
    if (field === "host") other.client.host = "other.synthetic.test";
    if (field === "port") other.client.port = 1993;
    if (field === "user") other.client.options.auth.user = "other-user";
    if (field === "authzid") other.client.options.auth.authzid = "other-mailbox";
    await expect(other.provider.messagesSincePage(cutoff, "INBOX", 1, first.nextCursor)).rejects.toThrow("Invalid receipt cursor");
    expect(other.client.getMailboxLock).not.toHaveBeenCalled();
  });

  it("fails closed when the IMAP account identity is unavailable", async () => {
    const { provider, client } = harness([row(1)]);
    Object.assign(client, { host: undefined });
    await expect(provider.messagesSincePage(cutoff)).rejects.toThrow("IMAP account identity unavailable");
    expect(client.getMailboxLock).not.toHaveBeenCalled();
  });

  it("uses fresh UIDNEXT so a retained mailbox selection does not hide arrivals", async () => {
    const { provider, client } = harness([row(1), row(4)], 2);
    client.mailboxOpen.mockResolvedValue({ uidNext: 5, uidValidity: 7n });
    const page = await provider.messagesSincePage(cutoff);
    expect(page.messages.map(m => m.id)).toEqual(["INBOX:4", "INBOX:1"]);
    expect(page.complete).toBe(true);
    expect(client.mailboxOpen).toHaveBeenCalledWith("INBOX", { readOnly: true });
  });
  it("keeps the initial UID frontier on continuation despite later arrivals", async () => {
    const { provider, client } = harness([row(1), row(2), row(4)], 3);
    const first = await provider.messagesSincePage(cutoff, "INBOX", 1);
    client.mailboxOpen.mockResolvedValue({ uidNext: 5, uidValidity: 7n });
    const next = await provider.messagesSincePage(cutoff, "INBOX", 1, first.nextCursor);
    expect(next.messages.map(m => m.id)).toEqual(["INBOX:1"]);
    expect(next.complete).toBe(true);
  });
  it.each([false, { uidValidity: 7n }, { uidNext: 0, uidValidity: 7n }])("fails closed when fresh mailbox examination is unavailable: %s", async status => {
    const { provider, client } = harness([row(1)]);
    client.mailboxOpen.mockResolvedValue(status as any);
    await expect(provider.messagesSincePage(cutoff)).rejects.toThrow("IMAP mailbox epoch/UID boundary unavailable");
    expect(client.search).not.toHaveBeenCalled();
  });

});
