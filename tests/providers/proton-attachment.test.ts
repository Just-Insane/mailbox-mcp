import { describe, expect, it, vi } from "vitest";
import { Readable } from "node:stream";
import { ImapProvider } from "../../src/providers/imap.js";

function fixture(data = Buffer.from("check-in 17:40")) {
  const stream = Readable.from([data]);
  const release = vi.fn();
  const imap = { mailbox: { uidValidity: 42n },
    getMailboxLock: vi.fn().mockResolvedValue({ release }),
    fetchOne: vi.fn().mockResolvedValue({ uid: 7, bodyStructure: {
      type: "multipart/mixed", childNodes: [
        { part: "1", type: "text/plain" },
        { part: "2", type: "text/plain", disposition: "attachment",
          dispositionParameters: { filename: "workshop.txt" } },
      ],
    } }),
    download: vi.fn().mockResolvedValue({ content: stream }),
  };
  const provider = new ImapProvider(imap as any, {} as any, "fixture@example.test");
  const read = (...args: unknown[]) => {
    expect((provider as any).readAttachmentBounded).toBeTypeOf("function");
    return (provider as any).readAttachmentBounded(...args);
  };
  return { imap, stream, release, read };
}

describe("bounded Proton IMAP attachment", () => {
  it("returns only the selected decoded candidate under a read-only mailbox lock", async () => {
    const f = fixture();
    const result = await f.read("INBOX:7", "2", "42", 65536);
    expect(result).toMatchObject({ folder: "INBOX", uid: 7, uidValidity: "42",
      partId: "2", filename: "workshop.txt", mimeType: "text/plain" });
    expect(result.data.equals(Buffer.from("check-in 17:40"))).toBe(true);
    expect(f.imap.getMailboxLock).toHaveBeenCalledWith("INBOX", { readOnly: true });
    expect(f.release).toHaveBeenCalledOnce();
  });
  it.each(["1", "workshop.txt", "3"])("rejects body/filename/nonexistent part %s before download", async part => {
    const f = fixture(); await expect(f.read("INBOX:7", part, "42", 65536)).rejects.toThrow();
    expect(f.imap.download).not.toHaveBeenCalled();
  });
  it.each([undefined, "", "41"])("rejects an absent or reset parent epoch %s without reading bytes", async epoch => {
    const f = fixture(); await expect(f.read("INBOX:7", "2", epoch, 65536)).rejects.toThrow();
    expect(f.imap.download).not.toHaveBeenCalled();
  });
  it("rejects ambiguous candidate parts", async () => {
    const f = fixture(); const structure = (await f.imap.fetchOne()).bodyStructure;
    structure.childNodes.push({ ...structure.childNodes[1] });
    await expect(f.read("INBOX:7", "2", "42", 65536)).rejects.toThrow();
    expect(f.imap.download).not.toHaveBeenCalled();
  });
  it("cancels an oversized decoded stream before returning accumulated bytes", async () => {
    const f = fixture(Buffer.alloc(65537));
    await expect(f.read("INBOX:7", "2", "42", 65536)).rejects.toThrow(/limit|large/i);
    expect(f.stream.destroyed).toBe(true); expect(f.release).toHaveBeenCalledOnce();
  });
  it.each(["7", "INBOX:0", "INBOX:7junk"])("rejects ambiguous native identity %s", async id => {
    const f = fixture(); await expect(f.read(id, "2", "42", 65536)).rejects.toThrow();
    expect(f.imap.download).not.toHaveBeenCalled();
  });
});
