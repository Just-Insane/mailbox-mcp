# Private exact-message attachment metadata

`ImapProvider.inspectAttachmentMetadata(messageId, options)` inspects one exact
`folder:UID` under a read-only mailbox lock. Options are `limit` (1–100, default
20) and optional `expectedUidValidity`. A supplied epoch must match before the
metadata fetch. Both the fetched UID and final mailbox epoch must remain valid.
The method fetches UID, envelope, internal date, message size and BODYSTRUCTURE;
it never requests message source/body or downloads an attachment.

An initial observed epoch establishes a **new** `[folder, UIDVALIDITY, UID]`
observation. It does not prove equivalence to, revise or supersede an older
Search record identified by ID/date/sender. Canonical capture and source leases
remain the consuming system's responsibility. Header date and received
`internalDate` are separate fields; metadata does not claim message text.

The result contains `folder`, `uid`, decimal-string `uidValidity`, `envelope`,
`attachments`, `limit` and `truncated`. The envelope contains
`internetMessageId`, nullable header `date`, required received `internalDate`,
`from`, `to`, `cc`, `subject` and `messageSize`. Each attachment contains an actual
candidate `partId`, nullable `filename`, `mimeType`, nullable `encodedSizeBytes`
and nullable `disposition`. Encoded BODYSTRUCTURE octets are **not** decoded
original size or verified content. Part enumeration reuses the existing candidate
rules; it does not certify the stricter TXT/PDF byte cohort.

Traversal permits at most 1,000 nodes and depth 32, then reports at most the
selected limit. Truncation is explicit. Duplicate/malformed IDs, unsafe names,
invalid envelope fields and excessive structures fail closed. Folder is bounded
to 256 characters, part IDs to 64, filenames/MIME to 256, disposition to 32,
Internet Message-ID/address strings to 4,096, subject to 16,384, and each address
array to 64 entries. UID and epoch are positive uint32 values. Metadata and the
complete tool response are bounded to 262,144 serialized UTF-8 bytes.

`inspect_proton_attachment_metadata` wraps this result as
`{schemaVersion:"1.0",account,message_id,metadata}`. Input pins `account`,
`message_id`, `limit` and, if selected, `expected_uid_validity`. The tool requires
the enabled `attachments` group and an independently trusted internal context:

```typescript
protonAttachmentMetadata: {
  programmaticRoute: "pcp-authenticated",
  selection: {account, message_id, limit, expected_uid_validity?}
}
```

All request fields must exactly match that selection. This sibling context never
enables `read_proton_attachment`, whose separate part/epoch/format selection is
unchanged. Metadata is evidence, not permission to install a byte selection.
The byte producer rejects empty PDFs to match the existing PCP consumer while
preserving valid empty TXT files.

The generic server supplies neither private context. Both tools remain hidden
and uncallable there, including when `MAILBOX_MCP_TOOLS=attachments`; request
arguments or environment settings cannot create private selection authority.
No authenticated transport wiring, new caller, credential, deployment, pin
change, canonical capture or live acceptance is provided by this source seam.
