const { test } = require('node:test');
const assert = require('node:assert/strict');
const { runtimeMetrics, unionIntervalSeconds } = require('../dist/telephony-runtime/metrics');
const { handleWebSession } = require('../dist/telephony-runtime/web-session');

test('connected intervals union overlapping tabs, clip by SQL and never add offline gaps', () => {
  assert.equal(unionIntervalSeconds([{start:100,end:150},{start:120,end:180},{start:200,end:210},{start:220,end:210}]),90);
  assert.equal(unionIntervalSeconds([]),0);
});
test('metrics use CRM civil day converted to UTC and preserve unavailable optional capabilities', async () => {
  const queries=[];
  const tx={execute:async(sql,params)=>{
    queries.push({sql,params});
    if(sql.includes('AS crmOffset'))return [{now:'2026-11-14T01:00:00Z',crmDay:'2026-11-13',crmOffset:-10800}];
    if(sql.includes('information_schema.COLUMNS'))return [];
    if(sql.includes('FROM telephony_calls'))return [{conversationSeconds:8,attempts:2,incompleteCalls:1}];
    if(sql.includes('FROM telephony_pause_segments'))return [{pauseSeconds:4,productivePauseSeconds:3}];
    throw Error('unexpected query '+sql);
  }};
  const result=await runtimeMetrics(tx,7);
  assert.equal(result.crmDay,'2026-11-13');assert.equal(result.conversationSeconds,8);
  assert.equal(result.connectedSeconds,null);assert.equal(result.contacts,null);assert.equal(result.closedOrders,null);assert.equal(result.productivityPercent,null);
  assert.equal(result.availability.connectedSeconds,false);
  assert.deepEqual(queries.find(q=>q.sql.includes('FROM telephony_calls')).params,['2026-11-13 03:00:00','2026-11-14 03:00:00','2026-11-13 03:00:00','2026-11-14 03:00:00',7,'2026-11-14 03:00:00','2026-11-13 03:00:00']);
  assert.ok(queries.every(q=>!q.sql.includes('UTC_DATE()')));
  assert.ok(queries.find(q=>q.sql.includes('FROM telephony_calls')).sql.includes('COALESCE(sent_at,ringing_at,prepared_at)<?'));
});
test('current observed web sessions and closed legacy intervals count once; disabled counters stay hidden', async () => {
  const columns={telephony_web_sessions:['operator_id','started_at','last_seen'],login_ativo_receptivo:['OPERADOR','ENTRADA','SAIDA'],parametros:['EXIBIR_PRODUTIVIDADE','EXIBIR_PEDIDOS_FECHADOS','TEMPO_MINIMO_CONVERSA','TEMPO_MAX_RECEPTIVO']};
  const tx={execute:async(sql)=>{
    if(sql.includes('AS crmOffset'))return [{now:'2026-11-13T12:00:00Z',crmDay:'2026-11-13',crmOffset:-10800}];
    if(sql.includes('information_schema.COLUMNS'))return Object.entries(columns).flatMap(([TABLE_NAME,names])=>names.map(COLUMN_NAME=>({TABLE_NAME,COLUMN_NAME})));
    if(sql.includes('FROM telephony_calls'))return [{conversationSeconds:20,attempts:1}];
    if(sql.includes('FROM telephony_pause_segments'))return [{pauseSeconds:15,productivePauseSeconds:10}];
    if(sql.includes('FROM telephony_web_sessions'))return [{start:100,end:140},{start:120,end:180}];
    if(sql.includes('FROM login_ativo_receptivo'))return [{start:50,end:130}];
    if(sql.includes('FROM parametros'))return [{EXIBIR_PRODUTIVIDADE:'S',EXIBIR_PEDIDOS_FECHADOS:'N',TEMPO_MINIMO_CONVERSA:30,TEMPO_MAX_RECEPTIVO:'00:03:00'}];
    throw Error('unexpected query '+sql);
  }};
  const result=await runtimeMetrics(tx,7);
  assert.equal(result.connectedSeconds,130);assert.equal(result.productivityPercent,23.08);assert.equal(result.minimumConversationSeconds,30);assert.equal(result.expectedSeconds,180);
  assert.equal(result.visibility.orders,false);assert.equal(result.closedOrders,null);
});
test('missing civil clock does not quietly switch metrics to a UTC day', async () => {
  await assert.rejects(()=>runtimeMetrics({execute:async()=>[{now:'2026-11-13T12:00:00Z',crmDay:null,crmOffset:null}]},7),/CLOCK_UNAVAILABLE/);
});
const sessionId='11111111-1111-4111-8111-111111111111';
test('heartbeat after an outage starts a new observation segment without counting the gap',async()=>{
  const queries=[];const tx={execute:async(sql,params)=>{queries.push({sql,params});return sql.startsWith('SELECT')?[{id:2,operator_id:7,segment:1,ended_at:null,gap_seconds:120}]:{affectedRows:1};}};
  assert.deepEqual(await handleWebSession(tx,7,{kind:'heartbeat',sessionId}),{observed:true});
  assert.ok(queries[1].sql.includes("ended_at=last_seen,end_reason='gap'"));assert.deepEqual(queries[2].params,[sessionId,2,7]);
});
test('late disconnect closes only at last observation and cannot create a new interval',async()=>{
  const queries=[];const tx={execute:async(sql,params)=>{queries.push({sql,params});return sql.startsWith('SELECT')?[{id:2,operator_id:7,segment:1,ended_at:null,gap_seconds:120}]:{affectedRows:1};}};
  await handleWebSession(tx,7,{kind:'disconnect',sessionId});assert.equal(queries.length,2);assert.ok(queries[1].sql.includes('ended_at=last_seen'));
});
test('session UUID ownership is checked even on repeated connect',async()=>{
  await assert.rejects(()=>handleWebSession({execute:async()=>[{id:2,operator_id:9,segment:1,ended_at:null,gap_seconds:0}]},7,{kind:'connect',sessionId}),/FORBIDDEN/);
});
