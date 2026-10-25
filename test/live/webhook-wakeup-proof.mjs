#!/usr/bin/env node
// Read native completion and replay the identical signed event. Never create
// another model prompt while evaluating the result of the original webhook.
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {DatabaseSync} from 'node:sqlite';
import {connectOperator} from '../../bin/call.mjs';
import {toolValue} from '../../src/providers.mjs';
import {postWebhook} from '../../src/webhooks.mjs';
const run=process.argv[2];if(!/^[a-zA-Z0-9_-]{8,100}$/.test(run??''))throw new Error('Supply the recorded run ID.');
const root=new URL('../../evidence/live/',import.meta.url);
const manifest=JSON.parse(await readFile(new URL(run+'.json',root),'utf8'));
const fixtures=JSON.parse(await readFile(new URL('fixtures.json',root),'utf8'));
assert.equal(manifest.route.notify.sessionId,fixtures.codex.id);assert.equal(manifest.route.filter.sessionId,fixtures.fabric.id);
for(const provider of ['codex','fabric'])assert.equal(fixtures[provider].purpose,'Switchboard dedicated live E2E');
const rpc=await connectOperator();
const unwrap=r=>{let v=toolValue(r);return v.kind==='result'?toolValue(v.value):v;};
const config=JSON.parse(await readFile(process.env.HOME+'/.local/state/agent-switchboard/config.json','utf8'));
const db=new DatabaseSync(config.stateDir+'/broker.sqlite',{readOnly:true});
try{
 const inbox=db.prepare('SELECT * FROM webhook_inbox WHERE route=?').all(run);assert.equal(inbox.length,1);
 const row=inbox[0];assert.equal(row.state,'dispatched');const event=JSON.parse(row.body);
 assert.equal(event.eventId,row.event_id);assert.equal(event.name,'session.turn.ended');assert.equal(event.data.sessionId,fixtures.fabric.id);
 const subscription=JSON.parse(db.prepare('SELECT body FROM subscriptions WHERE id=?').get(manifest.subscription.id).body);
 assert.ok(subscription.verifiedAt);assert.ok(subscription.cursor>=event.data.journalCursor);
 const receipt=unwrap(await rpc('tools/call',{name:'operations_get',arguments:{operationId:row.operation_id}}));assert.equal(receipt.status,'succeeded');
 const read=provider=>rpc('tools/call',{name:'sessions_query',arguments:{provider,action:provider==='codex'?'read':'status',input:{id:fixtures[provider].id,...(provider==='codex'?{maxChars:20000}:{})}}});
 const codexRaw=await read('codex'),fabricRaw=await read('fabric');
 const codex=unwrap(codexRaw),fabric=unwrap(fabricRaw);
 await writeFile(new URL(run+'-codex.json',root),JSON.stringify(codexRaw,null,2)+'\n',{mode:0o600});
 await writeFile(new URL(run+'-fabric.json',root),JSON.stringify(fabricRaw,null,2)+'\n',{mode:0o600});
 assert.equal(fabric.turn.turnId,event.data.turnId);assert.equal(fabric.turn.status,'completed');
 assert.equal(codex.latestTurn.status,'completed');
 assert.ok(codex.latestTurn.turn_id);
 // Persisted assistant output, not the injected user message, is required.
 const expected='SW-WEBHOOK-WAKE-20261025-01 '+event.eventId;
 const items=JSON.parse(codex.transcript);
 const finals=items.filter(m=>m.type==='agentMessage' && m.phase==='final_answer');
 assert.equal(finals.at(-1)?.text,expected,'Expected native assistant acknowledgment');
 const secret=(await readFile(manifest.route.secretFile,'utf8')).trim();
 const replay=await postWebhook({id:manifest.subscription.id,url:manifest.url,secret},event.eventId,row.body);
 assert.equal(replay.status,202);assert.equal(JSON.parse(replay.body).operationId,row.operation_id);
 assert.equal(db.prepare('SELECT COUNT(*) AS n FROM webhook_inbox WHERE route=?').get(run).n,1);
 const report={at:new Date().toISOString(),status:'live_pass',scope:'signed public HTTPS webhook -> durable receiver -> native Codex turn -> assistant acknowledgment',
   sourceTurnId:event.data.turnId,targetTurnId:codex.latestTurn.turn_id,eventId:event.eventId,operationId:row.operation_id,
   callbackVerified:true,replayStatus:replay.status,replayOperationId:JSON.parse(replay.body).operationId,assistantAcknowledgment:expected};
 await writeFile(new URL(run+'-proof.json',root),JSON.stringify(report,null,2)+'\n',{flag:'wx',mode:0o600});console.log(JSON.stringify(report,null,2));
}finally{db.close();}
