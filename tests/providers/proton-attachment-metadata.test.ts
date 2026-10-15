import {describe,it,expect,vi} from 'vitest';
import {ImapProvider} from '../../src/providers/imap.js';
import imapTools from 'imapflow/lib/tools.js';

function fixture(){
 const release=vi.fn();
 const part={part:'2',type:'text/plain',disposition:'attachment',dispositionParameters:{filename:'note.txt'},size:42};
 const meta={uid:7,envelope:{messageId:'<fixture@example.invalid>',date:new Date('2026-10-15T12:00:00Z'),from:[{address:'sender@example.invalid'}],to:[],cc:[],subject:'Synthetic'},
  internalDate:new Date('2026-10-15T12:01:00Z'),size:1024,bodyStructure:{type:'multipart/mixed',childNodes:[{part:'1',type:'text/plain'},part]}};
 const imap={mailbox:{uidValidity:42n},getMailboxLock:vi.fn(async()=>({release})),fetchOne:vi.fn(async()=>meta),download:vi.fn()};
 const provider=new ImapProvider(imap as any,{} as any,'fixture@example.invalid');
 const inspect=(expectedUidValidity?:string,limit=20)=>(provider as any).inspectAttachmentMetadata('INBOX:7',{expectedUidValidity,limit});
 return {imap,provider,meta,part,release,inspect};
}
describe('metadata-only Proton attachment inspection',()=>{
 it('observes a new epoch identity using metadata fetch only and preserves received versus header date',async()=>{
  const f=fixture();const result=await f.inspect();
  expect(result).toMatchObject({folder:'INBOX',uid:7,uidValidity:'42',limit:20,truncated:false,
   envelope:{internetMessageId:'<fixture@example.invalid>',date:'2026-10-15T12:00:00.000Z',internalDate:'2026-10-15T12:01:00.000Z',messageSize:1024},
   attachments:[{partId:'2',filename:'note.txt',mimeType:'text/plain',encodedSizeBytes:42,disposition:'attachment'}]});
  expect(f.imap.getMailboxLock).toHaveBeenCalledWith('INBOX',{readOnly:true});
  expect(f.imap.fetchOne).toHaveBeenCalledWith(7,{uid:true,envelope:true,internalDate:true,size:true,bodyStructure:true},{uid:true});
  expect(f.imap.download).not.toHaveBeenCalled();expect(f.release).toHaveBeenCalledOnce();
  expect(JSON.stringify(result)).not.toMatch(/body|base64|raw_key|Search/);
 });
 it('rejects expected epoch drift before fetching metadata',async()=>{
  const f=fixture();await expect(f.inspect('41')).rejects.toThrow();expect(f.imap.fetchOne).not.toHaveBeenCalled();expect(f.release).toHaveBeenCalledOnce();
 });
 it.each(['uid','deleted','epoch'])('rejects %s races without downloading',async mode=>{
  const f=fixture();f.imap.fetchOne.mockImplementation(async()=>{if(mode==='epoch')f.imap.mailbox.uidValidity=43n;return mode==='deleted'?false as any:{...f.meta,uid:mode==='uid'?8:7};});
  await expect(f.inspect('42')).rejects.toThrow();expect(f.imap.download).not.toHaveBeenCalled();expect(f.release).toHaveBeenCalledOnce();
 });
 it('bounds and truncates actual attachment candidates without including body parts',async()=>{
  const f=fixture();f.meta.bodyStructure.childNodes=Array.from({length:101},(_,i)=>({...f.part,part:String(i+1)}));
  const result=await f.inspect('42',100);expect(result.attachments).toHaveLength(100);expect(result.truncated).toBe(true);expect(f.imap.download).not.toHaveBeenCalled();
 });
 it.each(['from','to','cc'] as const)('rejects malformed %s mailbox entries without formatting placeholders',async field=>{
  for(const address of [{},{name:'Name'},{address:''},{address:'   '},{address:'local@'},{address:'@example.invalid'},{name:'Name',address:undefined},{name:'Group',group:[]}]){
   const f=fixture();f.meta.envelope[field]=[address] as any;
   await expect(f.inspect()).rejects.toThrow(/metadata/);
   expect(f.imap.download).not.toHaveBeenCalled();expect(f.release).toHaveBeenCalledOnce();
  }
 });
 it('preserves complete mailbox forms without imposing a new RFC address parser',async()=>{
  const f=fixture();f.meta.envelope.from=[{name:'Sender',address:'sender@example.invalid'}];
  f.meta.envelope.to=[{address:'"quoted local"@example.invalid'},{name:'Literal',address:'user@[IPv6:2001:db8::1]'}] as any;
  const result=await f.inspect();expect(result.envelope).toMatchObject({from:'Sender <sender@example.invalid>',
   to:['"quoted local"@example.invalid','Literal <user@[IPv6:2001:db8::1]>'],cc:[]});
  expect(f.imap.download).not.toHaveBeenCalled();
 });
 it('rejects group markers produced by the pinned ImapFlow envelope parser',async()=>{
  const token=(value:string)=>({type:'STRING',value});
  const rawGroup=[[null,null,token('Friends'),null],[null,null,token('member'),token('example.invalid')],[null,null,null,null]];
  const parsed=imapTools.parseEnvelope([null,null,null,null,null,rawGroup]);
  expect(parsed.to).toEqual([{name:'',address:'Friends@'},{name:'',address:'member@example.invalid'}]);
  const f=fixture();f.meta.envelope.to=parsed.to as any;
  await expect(f.inspect()).rejects.toThrow('Proton metadata address invalid');
  expect(f.imap.download).not.toHaveBeenCalled();expect(f.release).toHaveBeenCalledOnce();
 });
 it.each(['duplicate','part','missing-part','filename','mime','size','subject','addresses','address-string','date','nodes','depth','structure','null-child'])('fails closed for malformed or excessive %s metadata',async mode=>{
  const f=fixture();
  if(mode==='duplicate')f.meta.bodyStructure.childNodes.push({...f.part});
  if(mode==='part')f.part.part='bad';if(mode==='filename')f.part.dispositionParameters.filename='../note.txt';
  if(mode==='missing-part')delete (f.part as any).part;
  if(mode==='mime')f.part.type='x'.repeat(257);if(mode==='size')f.part.size=-1;
  if(mode==='subject')f.meta.envelope.subject='x'.repeat(16385);
  if(mode==='addresses')f.meta.envelope.to=Array(65).fill({address:'x@example.invalid'}) as any;
  if(mode==='address-string')f.meta.envelope.from[0].address='x'.repeat(4097);
  if(mode==='date')f.meta.internalDate=new Date('invalid');
  if(mode==='nodes')f.meta.bodyStructure.childNodes=Array(1001).fill({type:'text/plain'}) as any;
  if(mode==='structure')f.meta.bodyStructure={} as any;
  if(mode==='null-child')f.meta.bodyStructure.childNodes.push(null as any);
  if(mode==='depth'){let tree:any={type:'text/plain'};for(let i=0;i<34;i++)tree={type:'multipart/mixed',childNodes:[tree]};f.meta.bodyStructure=tree;}
  await expect(f.inspect()).rejects.toThrow();expect(f.imap.download).not.toHaveBeenCalled();expect(f.release).toHaveBeenCalledOnce();
 });
 it.each(['7','INBOX:0','INBOX:4294967296','x'.repeat(257)+':7','INBOX\n:7'])('rejects invalid selector before locking: %s',async messageId=>{
  const f=fixture();await expect((f.provider as any).inspectAttachmentMetadata(messageId,{limit:20})).rejects.toThrow();expect(f.imap.getMailboxLock).not.toHaveBeenCalled();
 });
 it.each([{limit:0},{limit:101},{limit:null},{expectedUidValidity:'0'},{expectedUidValidity:'4294967296'},{consumer:'pcp'}])('rejects invalid options before locking %j',async options=>{
  const f=fixture();await expect((f.provider as any).inspectAttachmentMetadata('INBOX:7',options)).rejects.toThrow();expect(f.imap.getMailboxLock).not.toHaveBeenCalled();
 });
});
