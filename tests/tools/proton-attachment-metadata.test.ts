import {afterEach,describe,it,expect,vi} from 'vitest';
import {getAllToolDefinitions,handleToolCall,type ToolContext} from '../../src/tools/registry.js';
import {ImapProvider} from '../../src/providers/imap.js';
import {Readable} from 'node:stream';
import {createHash} from 'node:crypto';
import '../../src/tools/proton-attachment.js';
const modulePath='../../src/tools/proton-attachment-metadata.js';
await import(modulePath).catch(()=>undefined);
const name='inspect_proton_attachment_metadata';
const request={account:'proton',message_id:'INBOX:7',limit:20};
function fixture(){
 const metadata={folder:'INBOX',uid:7,uidValidity:'42',envelope:{internetMessageId:null,date:null,internalDate:'2026-10-15T12:00:00.000Z',from:'sender@example.invalid',to:[],cc:[],subject:'Synthetic',messageSize:20},
  attachments:[{partId:'2',filename:'note.txt',mimeType:'text/plain',encodedSizeBytes:42,disposition:'attachment'}],limit:20,truncated:false};
 const provider={type:'imap',capabilities:{attachments:true},inspectAttachmentMetadata:vi.fn(async()=>metadata),readAttachmentBounded:vi.fn()};
 const ctx={accountManager:{} as any,getProvider:vi.fn(async()=>provider),protonAttachmentMetadata:{programmaticRoute:'pcp-authenticated',selection:{...request}}} as unknown as ToolContext;
 return {metadata,provider,ctx};
}
afterEach(()=>{delete process.env.MAILBOX_MCP_TOOLS;});
describe('private exact-parent metadata tool',()=>{
 it('exposes schema1.0 metadata only through a matching internal fixed selection',async()=>{
  const f=fixture();const result=await handleToolCall(name,request,f.ctx);
  expect(result.isError).not.toBe(true);expect(result.structuredContent).toEqual({schemaVersion:'1.0',account:'proton',message_id:'INBOX:7',metadata:f.metadata});
  expect(f.provider.inspectAttachmentMetadata).toHaveBeenCalledWith('INBOX:7',{limit:20});
  expect(result.content[0].text).not.toContain('Synthetic');expect(JSON.stringify(result)).not.toMatch(/base64|body|raw_key/);
  const tool=getAllToolDefinitions(f.ctx).find(tool=>tool.name===name)!;expect(tool).toBeDefined();expect(tool.inputSchema.additionalProperties).toBe(false);
 });
 it('forwards a pinned epoch and rejects changed response identity',async()=>{
  const f=fixture();(f.ctx as any).protonAttachmentMetadata.selection.expected_uid_validity='42';
  expect((await handleToolCall(name,{...request,expected_uid_validity:'42'},f.ctx)).isError).not.toBe(true);
  expect(f.provider.inspectAttachmentMetadata).toHaveBeenCalledWith('INBOX:7',{limit:20,expectedUidValidity:'42'});
  f.metadata.uidValidity='43';expect((await handleToolCall(name,{...request,expected_uid_validity:'42'},f.ctx)).isError).toBe(true);
 });
 it.each([{account:'other'},{message_id:'INBOX:8'},{limit:21},{expected_uid_validity:'42'},{part_id:'2'},{consumer:'pcp'},{destination:'private'},{path:'/tmp/x'},{body:true}])('denies mismatched/extra arguments before provider %j',async change=>{
  const f=fixture();expect((await handleToolCall(name,{...request,...change},f.ctx)).isError).toBe(true);expect(f.ctx.getProvider).not.toHaveBeenCalled();
 });
 it.each(['generic','env','byte-context','core-only'])('denies %s access before provider',async mode=>{
  const f=fixture();
  if(mode!=='core-only')delete (f.ctx as any).protonAttachmentMetadata;
  if(mode==='env')process.env.MAILBOX_MCP_TOOLS='attachments';
  if(mode==='byte-context')(f.ctx as any).protonAttachment={programmaticRoute:'pcp-authenticated',selection:{...request,part_id:'2',expected_uid_validity:'42',format:'txt'}};
  if(mode==='core-only')process.env.MAILBOX_MCP_TOOLS='core';
  expect(getAllToolDefinitions(f.ctx).map(tool=>tool.name)).not.toContain(name);
  expect((await handleToolCall(name,request,f.ctx)).isError).toBe(true);expect(f.ctx.getProvider).not.toHaveBeenCalled();
 });
 it('metadata context never enables the byte tool',async()=>{
  const f=fixture();expect(getAllToolDefinitions(f.ctx).map(tool=>tool.name)).not.toContain('read_proton_attachment');
  expect((await handleToolCall('read_proton_attachment',{account:'proton',message_id:'INBOX:7',part_id:'2',expected_uid_validity:'42',format:'txt'},f.ctx)).isError).toBe(true);
  expect(f.ctx.getProvider).not.toHaveBeenCalled();
 });
 it('composes metadata observation with a separately installed exact byte selection',async()=>{
  const data=Buffer.from('Synthetic handoff');const release=vi.fn();
  const imap={mailbox:{uidValidity:42n},getMailboxLock:vi.fn(async()=>({release})),download:vi.fn(async()=>({content:Readable.from([data])})),
   fetchOne:vi.fn(async()=>({uid:7,envelope:{subject:'Synthetic',from:[],to:[],cc:[]},internalDate:new Date('2026-10-15T12:00:00Z'),size:100,
    bodyStructure:{type:'multipart/mixed',childNodes:[{part:'1',type:'text/plain'},{part:'2',type:'text/plain',disposition:'attachment',dispositionParameters:{filename:'note.txt'},size:42}]}}))};
  const provider=new ImapProvider(imap as any,{} as any,'fixture@example.invalid');const f=fixture();f.ctx.getProvider=vi.fn(async()=>provider);
  const result=await handleToolCall(name,request,f.ctx);expect(result.isError).not.toBe(true);
  const metadata=(result.structuredContent as any).metadata;expect(imap.download).not.toHaveBeenCalled();
  const selection={account:'proton',message_id:`${metadata.folder}:${metadata.uid}`,expected_uid_validity:metadata.uidValidity,part_id:metadata.attachments[0].partId,format:'txt' as const};
  expect((await handleToolCall('read_proton_attachment',selection,f.ctx)).isError).toBe(true);expect(imap.download).not.toHaveBeenCalled();
  // Simulate an independently trusted owner selection; source data does not install this context.
  const byteContext:ToolContext={accountManager:{} as any,getProvider:f.ctx.getProvider,protonAttachment:{programmaticRoute:'pcp-authenticated',selection}};
  const bytes=await handleToolCall('read_proton_attachment',selection,byteContext);
  expect(bytes.isError).not.toBe(true);expect(bytes.structuredContent).toMatchObject({schemaVersion:'1.0',account:'proton',message_id:'INBOX:7',part_id:'2',uid_validity:'42',size:data.length,sha256:createHash('sha256').update(data).digest('hex'),base64:data.toString('base64')});
  expect(imap.download).toHaveBeenCalledExactlyOnceWith(7,'2',{uid:true});
  expect(imap.getMailboxLock.mock.calls.every(([,options])=>options.readOnly===true)).toBe(true);
 });
 it.each([{message_id:'INBOX:4294967296'},{expected_uid_validity:'4294967296'},{limit:101},{account:'x'.repeat(65)}])('invalid internal selection stays denied %j',async change=>{
  const f=fixture();Object.assign((f.ctx as any).protonAttachmentMetadata.selection,change);
  expect(getAllToolDefinitions(f.ctx).map(tool=>tool.name)).not.toContain(name);expect((await handleToolCall(name,request,f.ctx)).isError).toBe(true);expect(f.ctx.getProvider).not.toHaveBeenCalled();
 });
 it.each(['folder','uid','limit','extra','envelope','size'])('rejects malformed provider result: %s',async field=>{
  const f=fixture();if(field==='folder')f.metadata.folder='other';if(field==='uid')f.metadata.uid=8;if(field==='limit')f.metadata.limit=21;
  if(field==='extra')(f.metadata as any).body='private';if(field==='envelope')f.metadata.envelope.subject='x'.repeat(16385);
  if(field==='size'){f.metadata.envelope.to=Array(64).fill('x'.repeat(4096)) as never[];f.metadata.envelope.cc=Array(64).fill('x'.repeat(4096)) as never[];}
  const result=await handleToolCall(name,request,f.ctx);expect(result.isError).toBe(true);expect(JSON.stringify(result)).not.toContain('private');
 });
 it('redacts provider errors and rejects unsupported capability',async()=>{
  const f=fixture();f.provider.inspectAttachmentMetadata.mockRejectedValueOnce(new Error('secret provider payload'));
  expect(JSON.stringify(await handleToolCall(name,request,f.ctx))).not.toContain('secret provider payload');
  f.provider.capabilities.attachments=false;expect((await handleToolCall(name,request,f.ctx)).isError).toBe(true);
 });
});
