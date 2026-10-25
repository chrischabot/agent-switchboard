import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomBytes} from 'node:crypto';
import {Store} from '../src/store.mjs';
import {WebhookReceiver} from '../src/webhook-receiver.mjs';
import {signedHeaders} from '../src/webhooks.mjs';
import {serveHub} from '../src/http.mjs';

async function fixture(t) {
  const dir=await mkdtemp(path.join(tmpdir(),'switchboard-receiver-'));
  const secret='whsec_'+randomBytes(32).toString('base64');
  const secretFile=path.join(dir,'key'); await writeFile(secretFile,secret,{mode:0o600});
  const store=new Store(path.join(dir,'db')); const calls=[]; let allowed=true;
  const broker={store,config:{clients:{}},provider(){if(!allowed)throw new Error('revoked');},
    async notify(principal,provider,input){calls.push({principal,provider,input});return {operation:store.submit(principal,input.requestId,provider,input).operation};}};
  const route={id:'fixture-route',principal:'operator',secretFile,subscriptionId:'subscription-1',event:'session.turn.ended',
    filter:{provider:'fabric',sessionId:'source-1'},notify:{provider:'codex',sessionId:'target-1'},expiresAt:Date.now()+60000,maxDeliveries:1};
  let receiver=new WebhookReceiver(broker); await receiver.configure([route]);broker.webhookReceiver=receiver;
  const http=await serveHub(broker,{port:0});
  t.after(async()=>{await http.close();await receiver.close();store.close();await rm(dir,{recursive:true,force:true});});
  const event={eventId:'event-1',name:'session.turn.ended',timestamp:new Date().toISOString(),data:{provider:'fabric',sessionId:'source-1',sourceId:'native-1',scope:'turn',turnId:'turn-1',journalCursor:9}};
  const post=async(value=event,opts={})=>{const body=JSON.stringify(value);return fetch(`http://127.0.0.1:${http.port}/webhooks/${route.id}`,{method:'POST',body,headers:{...signedHeaders({id:route.subscriptionId,secret},value.eventId??'verify-1',body,opts.now??Date.now()),...opts.headers}});};
  const settle=async()=>{while(receiver.running.size)await Promise.all(receiver.running.values());};
  return {route,event,post,settle,calls,store,broker,revoke(){allowed=false;},async restart(){await receiver.close();receiver=new WebhookReceiver(broker);await receiver.configure([route]);broker.webhookReceiver=receiver;receiver.start();await settle();}};
}

test('signed public HTTP challenge, durable delivery, duplicate and restart do not resend',async t=>{
  const f=await fixture(t);
  assert.deepEqual(await (await f.post({type:'verification',challenge:'single-use'})).json(),{challenge:'single-use'});
  assert.equal(f.calls.length,0);
  assert.equal((await f.post()).status,202);await f.settle();
  assert.equal(f.calls.length,1);assert.equal(f.calls[0].input.id,'target-1');
  assert.match(f.calls[0].input.text,/"turnId":"turn-1"/);
  assert.equal(f.store.db.prepare('SELECT state FROM webhook_inbox').get().state,'dispatched');
  await f.restart();assert.equal((await f.post()).status,202);await f.settle();assert.equal(f.calls.length,1);
  assert.equal((await f.post({...f.event,data:{...f.event.data,turnId:'changed'}})).status,409);
  assert.equal((await f.post({...f.event,eventId:'second-event'})).status,410);assert.equal(f.calls.length,1);
});

test('reject forged, stale, wrong subscription and mismatched source without native dispatch',async t=>{
  const f=await fixture(t);
  for(const opts of [{headers:{'webhook-signature':'v1,bad'}},{now:Date.now()-301000},{headers:{'x-mcp-subscription-id':'wrong'}}])assert.equal((await f.post(f.event,opts)).status,401);
  assert.equal((await f.post({...f.event,data:{...f.event.data,sessionId:'other'}})).status,400);
  assert.equal((await f.post({...f.event,name:'session.error'})).status,400);
  assert.equal((await f.post({...f.event,data:{...f.event.data,prompt:'do something'}})).status,400);
  assert.equal((await f.post(f.event,{headers:{origin:'https://attacker.invalid'}})).status,403);
  f.revoke();assert.equal((await f.post()).status,400);assert.equal(f.calls.length,0);
});

test('recovery of accepted inbox event uses original dispatch identity',async t=>{
  const f=await fixture(t);await f.post();await f.settle();
  const first=f.store.db.prepare('SELECT operation_id FROM webhook_inbox').get().operation_id;
  // Model a crash after native dispatch was journaled but before inbox association.
  f.store.db.prepare("UPDATE webhook_inbox SET state='pending',operation_id=NULL").run();
  await f.restart();
  assert.equal(f.store.db.prepare('SELECT operation_id FROM webhook_inbox').get().operation_id,first);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM operations').get().n,1);
});

test('native dispatch failure is retained and is not retried by webhook replay',async t=>{
  const f=await fixture(t);let calls=0;f.broker.notify=async()=>{calls++;throw Object.assign(new Error('unavailable'),{code:'status_unavailable'});};
  await f.post();await f.settle();await f.post();await f.settle();
  assert.equal(calls,1);assert.deepEqual({...f.store.db.prepare('SELECT state,error FROM webhook_inbox').get()},{state:'failed',error:'status_unavailable'});
});
