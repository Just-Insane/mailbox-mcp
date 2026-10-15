import {afterEach,describe,it,expect,vi} from 'vitest';
import {createHash} from 'node:crypto';
import {createProtonPrivateHandler,type ProtonPrivatePolicy} from '../src/private-proton-handler.js';
const now=Date.parse('2026-10-15T12:00:00Z');
const metadataSelection={account:'proton',message_id:'INBOX:7',limit:20};
const attachmentSelection={account:'proton',message_id:'INBOX:7',part_id:'2',expected_uid_validity:'42',format:'txt' as const};
// Synthetic host evidence captured from the original target, never Request.url or headers.
const originalTargets=new WeakMap<Request,string>();
function rawRequest(target:string,body:unknown=metadataSelection){
 const req=new Request(`https://private.example${target}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
 originalTargets.set(req,target);return req;
}
function fixture(){
 const metadata={folder:'INBOX',uid:7,uidValidity:'42',envelope:{internetMessageId:null,date:null,internalDate:'2026-10-15T12:00:00.000Z',from:'sender@example.invalid',to:[],cc:[],subject:'Synthetic',messageSize:100},
  attachments:[{partId:'2',filename:'note.txt',mimeType:'text/plain',encodedSizeBytes:42,disposition:'attachment'}],limit:20,truncated:false};
 const bytes=Buffer.from('Synthetic private handoff');
 const provider={type:'imap',capabilities:{attachments:true},inspectAttachmentMetadata:vi.fn(async()=>metadata),
  readAttachmentBounded:vi.fn(async()=>({folder:'INBOX',uid:7,uidValidity:'42',partId:'2',filename:'note.txt',mimeType:'text/plain',data:bytes}))};
 const getProvider=vi.fn(async()=>provider);
 const policy:ProtonPrivatePolicy={status:'qualified',principal:'existing-principal',audience:'existing-audience',receiptReference:'synthetic-receipt',
  expiresAt:'2026-10-15T13:00:00.000Z',metadataSelection:{...metadataSelection},attachmentSelection:{...attachmentSelection}};
 const verifyGateway=vi.fn(async(req:Request)=>({principal:'existing-principal',audience:'existing-audience',requestTarget:originalTargets.get(req)!}));
 const options={policy,verifyGateway,context:{accountManager:{} as any,getProvider:getProvider as any},now:()=>now};
 return {provider,getProvider,policy,verifyGateway,options,bytes};
}
const request=(operation='metadata',body:unknown=metadataSelection)=>rawRequest(`/v1/private/proton/${operation}`,body);
afterEach(()=>{vi.useRealTimers();delete process.env.MAILBOX_MCP_TOOLS;});
describe('private Proton HTTP adapter',()=>{
 it('verifies gateway identity and returns existing metadata structured content only',async()=>{
  const f=fixture();const req=request();const response=await createProtonPrivateHandler(f.options)(req);
  expect(response.status).toBe(200);expect(await response.json()).toMatchObject({schemaVersion:'1.0',account:'proton',message_id:'INBOX:7',metadata:{uidValidity:'42'}});
  expect(response.headers.get('cache-control')).toBe('private, no-store');expect(f.verifyGateway).toHaveBeenCalledWith(req,expect.any(AbortSignal));
  expect(f.provider.inspectAttachmentMetadata).toHaveBeenCalledExactlyOnceWith('INBOX:7',{limit:20});expect(f.provider.readAttachmentBounded).not.toHaveBeenCalled();
 });
 it('returns the existing byte contract with identity/size/digest and no MCP wrapper',async()=>{
  const f=fixture();const response=await createProtonPrivateHandler(f.options)(request('attachment',attachmentSelection));
  expect(response.status).toBe(200);expect(await response.json()).toEqual({schemaVersion:'1.0',account:'proton',message_id:'INBOX:7',part_id:'2',uid_validity:'42',filename:'note.txt',mime_type:'text/plain',size:f.bytes.length,
   sha256:createHash('sha256').update(f.bytes).digest('hex'),base64:f.bytes.toString('base64')});
  expect(f.provider.inspectAttachmentMetadata).not.toHaveBeenCalled();
 });
 it.each(['verifier','policy','qualification','expired','selection','context','principal','audience','receipt'])('denies invalid/missing %s before provider construction',async mode=>{
  const f=fixture();const options:any={...f.options};
  if(mode==='verifier')delete options.verifyGateway;if(mode==='policy')delete options.policy;if(mode==='context')delete options.context;
  if(mode==='qualification')(f.policy as any).status='proposed';if(mode==='expired')f.policy.expiresAt='2026-10-15T12:00:00.000Z';
  if(mode==='selection')delete f.policy.metadataSelection;if(mode==='receipt')f.policy.receiptReference='';
  if(mode==='principal')f.verifyGateway.mockResolvedValue({principal:'wrong',audience:'existing-audience',requestTarget:'/v1/private/proton/metadata'});
  if(mode==='audience')f.verifyGateway.mockResolvedValue({principal:'existing-principal',audience:'wrong',requestTarget:'/v1/private/proton/metadata'});
  expect((await createProtonPrivateHandler(options)(request())).status).not.toBe(200);expect(f.getProvider).not.toHaveBeenCalled();
 });
 it('never accepts identity headers or a caller-declared authority',async()=>{
  const f=fixture();f.verifyGateway.mockResolvedValue(null as any);const req=request();req.headers.set('x-principal','existing-principal');req.headers.set('x-audience','existing-audience');
  expect((await createProtonPrivateHandler(f.options)(req)).status).toBe(403);expect(f.getProvider).not.toHaveBeenCalled();
 });
 it.each(['/v1/private/proton/x/../metadata','/v1/private/proton/%2e/metadata','/v1/private/proton/x/%2E%2E/metadata'])('denies normalized route alias %s before provider construction',async target=>{
  const f=fixture();const req=rawRequest(target);expect(new URL(req.url).pathname).toBe('/v1/private/proton/metadata');
  expect((await createProtonPrivateHandler(f.options)(req)).status).toBe(403);expect(f.getProvider).not.toHaveBeenCalled();
 });
 it('denies encoded-dot attachment aliases despite matching byte selections',async()=>{
  const f=fixture();const req=rawRequest('/v1/private/proton/x/%2e%2e/attachment',attachmentSelection);
  expect(new URL(req.url).pathname).toBe('/v1/private/proton/attachment');
  expect((await createProtonPrivateHandler(f.options)(req)).status).toBe(403);expect(f.getProvider).not.toHaveBeenCalled();
 });
 it.each([undefined,'/v1/private/proton/attachment','/v1/private/proton/metadata?x=1'])('denies absent or mismatched verified original target: %s',async target=>{
  const f=fixture();f.verifyGateway.mockResolvedValue({principal:'existing-principal',audience:'existing-audience',requestTarget:target} as any);
  const req=request();req.headers.set('x-original-url','/v1/private/proton/metadata');
  expect((await createProtonPrivateHandler(f.options)(req)).status).toBe(403);expect(f.getProvider).not.toHaveBeenCalled();
 });
 it.each(['metadata','attachment'])('does not authorize %s through the other operation selection',async operation=>{
  const f=fixture();if(operation==='metadata')delete f.policy.metadataSelection;else delete f.policy.attachmentSelection;
  expect((await createProtonPrivateHandler(f.options)(request(operation,operation==='metadata'?metadataSelection:attachmentSelection))).status).toBe(403);
  expect(f.getProvider).not.toHaveBeenCalled();
 });
 it.each([{account:'other'},{message_id:'INBOX:8'},{limit:21},{principal:'existing-principal'},{audience:'existing-audience'},{destination:'private'},{expected_uid_validity:'42'}])('rejects extra/mismatched metadata arguments before provider %j',async patch=>{
  const f=fixture();expect((await createProtonPrivateHandler(f.options)(request('metadata',{...metadataSelection,...patch}))).status).not.toBe(200);expect(f.getProvider).not.toHaveBeenCalled();
 });
 it('honors independently pinned metadata epochs and strict byte selections',async()=>{
  const f=fixture();f.policy.metadataSelection={...metadataSelection,expected_uid_validity:'42'};
  const handler=createProtonPrivateHandler(f.options);
  expect((await handler(request('metadata',{...metadataSelection,expected_uid_validity:'42'}))).status).toBe(200);
  f.getProvider.mockClear();expect((await handler(request('attachment',{...attachmentSelection,part_id:'3'}))).status).not.toBe(200);expect(f.getProvider).not.toHaveBeenCalled();
 });
 it('rejects query strings, unknown routes, wrong methods and oversized/invalid JSON without provider',async()=>{
  const f=fixture();const handler=createProtonPrivateHandler(f.options);
  for(const req of [new Request('https://private.example/v1/private/proton/metadata?x=1',{method:'POST'}),new Request('https://private.example/other'),new Request('https://private.example/v1/private/proton/metadata'),request('metadata',{data:'x'.repeat(5000)}),new Request('https://private.example/v1/private/proton/metadata',{method:'POST',headers:{'content-type':'application/json'},body:'{'})]){
   expect((await handler(req)).status).not.toBe(200);
  }expect(f.getProvider).not.toHaveBeenCalled();
 });
 it('redacts verifier/provider errors and tool failures',async()=>{
  const f=fixture();f.verifyGateway.mockRejectedValueOnce(new Error('secret verifier detail'));
  expect(await (await createProtonPrivateHandler(f.options)(request())).text()).not.toContain('secret');
  f.provider.inspectAttachmentMetadata.mockRejectedValueOnce(new Error('secret mailbox payload'));
  const response=await createProtonPrivateHandler(f.options)(request());expect(response.status).not.toBe(200);expect(await response.text()).not.toContain('secret');
 });
 it('preserves the existing maximum PDF envelope and rejects excessive metadata output',async()=>{
  const f=fixture();const pdf=Buffer.alloc(2097152,65);f.policy.attachmentSelection={...attachmentSelection,format:'pdf'};
  f.provider.readAttachmentBounded.mockResolvedValueOnce({folder:'INBOX',uid:7,uidValidity:'42',partId:'2',filename:'note.pdf',mimeType:'application/pdf',data:pdf});
  const result=await createProtonPrivateHandler(f.options)(request('attachment',{...attachmentSelection,format:'pdf'}));
  expect(result.status).toBe(200);const encoded=await result.text();expect(Buffer.byteLength(encoded)).toBeLessThanOrEqual(3500000);
  expect(JSON.parse(encoded).size).toBe(2097152);
  f.provider.inspectAttachmentMetadata.mockResolvedValueOnce({folder:'INBOX',uid:7,uidValidity:'42',envelope:{internetMessageId:null,date:null,internalDate:'2026-10-15T12:00:00.000Z',from:'sender@example.invalid',
   to:Array(64).fill('x'.repeat(4096)),cc:Array(64).fill('x'.repeat(4096)),subject:'Synthetic',messageSize:100},attachments:[],limit:20,truncated:false});
  const denied=await createProtonPrivateHandler(f.options)(request());expect(denied.status).toBe(503);expect((await denied.text()).length).toBeLessThan(100);
 });
 it('rejects an expired result after an already-started metadata inspection',async()=>{
  const f=fixture();let clock=now;f.options.now=()=>clock;
  const metadata=await f.provider.inspectAttachmentMetadata();f.provider.inspectAttachmentMetadata.mockImplementation(async()=>{clock=now+3600001;return metadata;});
  expect((await createProtonPrivateHandler(f.options)(request())).status).toBe(403);
 });
 it('fails before provider when gateway verification exceeds the thirty-second deadline',async()=>{
  vi.useFakeTimers();const f=fixture();f.verifyGateway.mockImplementation(()=>new Promise(()=>{}));
  const response=createProtonPrivateHandler(f.options)(request());await vi.advanceTimersByTimeAsync(30000);
  expect((await response).status).toBe(504);expect(f.getProvider).not.toHaveBeenCalled();
 });
 it('rechecks expiry after gateway verification before constructing the provider',async()=>{
  const f=fixture();let clock=now;f.options.now=()=>clock;
  f.verifyGateway.mockImplementation(async()=>{clock=now+3600001;return {principal:'existing-principal',audience:'existing-audience',requestTarget:'/v1/private/proton/metadata'};});
  expect((await createProtonPrivateHandler(f.options)(request())).status).not.toBe(200);expect(f.getProvider).not.toHaveBeenCalled();
 });
 it('withholds a late provider result and starts no operation after timeout',async()=>{
  vi.useFakeTimers();const f=fixture();let resolveProvider!:(provider:any)=>void;
  f.getProvider.mockImplementation(()=>new Promise(resolve=>{resolveProvider=resolve;}));
  const pending=createProtonPrivateHandler(f.options)(request());await vi.advanceTimersByTimeAsync(30000);
  expect((await pending).status).toBe(504);resolveProvider(f.provider);await vi.advanceTimersByTimeAsync(1);
  expect(f.provider.inspectAttachmentMetadata).not.toHaveBeenCalled();
 });
 it('cancels an unfinished request body at the deadline without constructing a provider',async()=>{
  vi.useFakeTimers();const f=fixture();const cancel=vi.fn();
  const stream=new ReadableStream<Uint8Array>({start(controller){controller.enqueue(new TextEncoder().encode('{'));},cancel});
  const req=new Request('https://private.example/v1/private/proton/metadata',{method:'POST',headers:{'content-type':'application/json'},body:stream,duplex:'half'} as RequestInit);
  originalTargets.set(req,'/v1/private/proton/metadata');
  const pending=createProtonPrivateHandler(f.options)(req);await vi.advanceTimersByTimeAsync(30000);
  expect((await pending).status).toBe(504);expect(cancel).toHaveBeenCalledOnce();expect(f.getProvider).not.toHaveBeenCalled();
 });
 it('honors already-aborted requests and disabled tool groups before provider construction',async()=>{
  const f=fixture();const abort=new AbortController();abort.abort();
  const req=new Request(request(),{signal:abort.signal});expect((await createProtonPrivateHandler(f.options)(req)).status).not.toBe(200);
  process.env.MAILBOX_MCP_TOOLS='core';expect((await createProtonPrivateHandler(f.options)(request())).status).not.toBe(200);expect(f.getProvider).not.toHaveBeenCalled();
 });
});
