import { describe, expect, it, vi } from "vitest";
import { ImapProvider } from "../../src/providers/imap.js";

const cutoff = "2026-10-05T12:00:00Z";
const received = "2026-10-05T13:00:00Z";

function harness(rows: any[]) {
  const release = vi.fn();
  const fetched: number[][] = [];
  const client = {
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
  it("returns received time rather than the sender Date header", async () => {
    const { provider } = harness([row(1)]);
    expect((await provider.messagesSince(cutoff))[0].date).toBe("2026-10-05T13:00:00.000Z");
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
    expect((await provider.messagesSince("2026-10-05T14:00:00+02:00", "Sent", 2)).map(item => item.id)).toEqual(["Sent:9", "Sent:5"]);
  });

  it.each([undefined, false, new Date(NaN)])("fails closed for invalid received time %s", async internalDate => {
    const { provider, release } = harness([{ ...row(1), internalDate }]);
    await expect(provider.messagesSince(cutoff)).rejects.toThrow("Invalid IMAP internalDate");
    expect(release).toHaveBeenCalledOnce();
  });

  it("uses a prior UTC day candidate search and a read-only folder lock", async () => {
    const { provider, client } = harness([]);
    await provider.messagesSince("2026-10-05T00:30:00Z", "Archive");
    expect(client.search).toHaveBeenCalledWith({ since: new Date("2026-10-04T00:00:00Z") }, { uid: true });
    expect(client.getMailboxLock).toHaveBeenCalledWith("Archive", { readOnly: true });
  });

  it.each([0, -1, 1.5, NaN])("rejects an invalid cap %s before accessing IMAP", async cap => {
    const { provider, client } = harness([]);
    await expect(provider.messagesSince(cutoff, "INBOX", cap)).rejects.toThrow("Invalid maxResults");
    expect(client.getMailboxLock).not.toHaveBeenCalled();
  });
});
