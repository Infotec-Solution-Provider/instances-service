const test=require('node:test'),assert=require('node:assert/strict'),mysql=require('mysql2/promise'),fs=require('node:fs'),path=require('node:path'),{randomUUID}=require('node:crypto');
const {runtimeMetrics}=require('../dist/telephony-runtime/metrics');
const {handleWebSession}=require('../dist/telephony-runtime/web-session');
for(const port of [13555,13480])test(`metrics and observed sessions MySQL ${port}`,{skip:process.env.RUN_TELEPHONY_METRICS_MYSQL!=='1'},async t=>{
 const name=`telephony_metrics_${process.pid}_${Date.now()}_${port}`;
 const db=await mysql.createConnection({host:'127.0.0.1',port,user:'root',multipleStatements:true,timezone:'Z',dateStrings:true});
 const tx={execute:async(sql,params=[])=>{try{return (await db.execute(sql,params))[0];}catch(error){console.error('failing metric SQL',sql,params);throw error;}}};
 try{
  await db.query(`CREATE DATABASE \`${name}\` CHARACTER SET utf8mb4;USE \`${name}\``);
  for(const file of ['20261113-telephony-runtime.sql','20261113-telephony-web-sessions.sql'])await db.query(fs.readFileSync(path.join(__dirname,'../docs/sql',file),'utf8'));
  await db.query(`SET timestamp=${Math.floor(Date.parse('2026-11-14T01:00:00Z')/1000)};SET SESSION time_zone='+00:00';SET @inpulse_crm_utc_at=UTC_TIMESTAMP(),@inpulse_crm_transfer_at=DATE_SUB(UTC_TIMESTAMP(),INTERVAL 3 HOUR)`);
  await t.test('unavailable legacy schema remains nullable and core queries work',async()=>{
   const metrics=await runtimeMetrics(tx,7);assert.equal(metrics.crmDay,'2026-11-13');assert.equal(metrics.connectedSeconds,0);assert.equal(metrics.contacts,null);assert.equal(metrics.quotesToClose,null);
  });
  await db.query(`CREATE TABLE login_ativo_receptivo(CODIGO INT PRIMARY KEY,OPERADOR INT,ENTRADA DATETIME,SAIDA DATETIME)ENGINE=InnoDB;CREATE TABLE clientes(CODIGO INT PRIMARY KEY,ATIVO VARCHAR(3))ENGINE=InnoDB;CREATE TABLE campanhas_clientes(CODIGO INT PRIMARY KEY,CLIENTE INT,OPERADOR INT,OPERADOR_LIGACAO INT,CONCLUIDO VARCHAR(3),DT_AGENDAMENTO DATETIME,DT_RESULTADO DATETIME,RESULTADO INT,DATA_HORA_LIG DATETIME,CAMPANHA INT)ENGINE=InnoDB;CREATE TABLE resultados(CODIGO INT PRIMARY KEY,ECONTATO VARCHAR(3),EPEDIDO VARCHAR(3),PROPOSTA VARCHAR(3),EVENDA VARCHAR(3))ENGINE=InnoDB;CREATE TABLE propostas(CODIGO INT PRIMARY KEY,LIGACAO INT,VALOR DECIMAL(12,2))ENGINE=InnoDB;CREATE TABLE parametros(EXIBIR_PRODUTIVIDADE VARCHAR(1),EXIBIR_PEDIDOS_FECHADOS VARCHAR(1),TEMPO_MINIMO_CONVERSA INT,TEMPO_MAX_RECEPTIVO TIME)ENGINE=InnoDB;CREATE TABLE campanhas(CODIGO INT PRIMARY KEY,MAX_RESPOSTA INT)ENGINE=InnoDB;INSERT INTO parametros VALUES('S','S',30,'00:03:00');INSERT INTO clientes VALUES(1,'SIM'),(2,'SIM');INSERT INTO resultados VALUES(1,'SIM','NAO','SIM','NAO'),(2,'SIM','SIM','NAO','SIM');INSERT INTO campanhas VALUES(1,240);INSERT INTO campanhas_clientes VALUES(1,1,7,7,'SIM','2026-11-13 20:00:00','2026-11-13 20:00:00',1,'2026-11-13 20:00:00',1),(2,2,7,7,'SIM','2026-11-13 20:00:00','2026-11-13 20:00:00',2,'2026-11-13 20:00:00',1),(3,1,7,7,'NAO','2026-11-13 21:00:00',NULL,NULL,NULL,1);INSERT INTO propostas VALUES(1,2,100.50);INSERT INTO login_ativo_receptivo VALUES(1,7,'2026-11-13 20:00:00','2026-11-13 21:00:00');`);
  const sessionId=randomUUID();
  await t.test('session lifecycle is owned and preserves offline gap boundaries',async()=>{
   await handleWebSession(tx,7,{kind:'connect',sessionId});await handleWebSession(tx,7,{kind:'connect',sessionId});
   assert.equal((await db.query('SELECT COUNT(*) n FROM telephony_web_sessions'))[0][0].n,1);
   await assert.rejects(handleWebSession(tx,9,{kind:'heartbeat',sessionId}),/FORBIDDEN/);
   await db.query('UPDATE telephony_web_sessions SET started_at=DATE_SUB(UTC_TIMESTAMP(),INTERVAL 3600 SECOND),last_seen=DATE_SUB(UTC_TIMESTAMP(),INTERVAL 180 SECOND)');
   await handleWebSession(tx,7,{kind:'heartbeat',sessionId});
   const rows=(await db.query('SELECT segment,TIMESTAMPDIFF(SECOND,started_at,last_seen) duration,ended_at IS NOT NULL AS closed FROM telephony_web_sessions ORDER BY segment'))[0];
   assert.equal(rows.length,2);assert.equal(rows[0].duration,3420);
   await handleWebSession(tx,7,{kind:'disconnect',sessionId});
  });
  await t.test('civil day, quote formula, conditional counts and legacy/web union execute on real SQL',async()=>{
   const id=randomUUID();await db.query("INSERT INTO telephony_calls(id,operator_id,direction,number,schedule_id,state,prepared_at,sent_at,answered_at,ended_at,updated_at) VALUES(?,7,'outgoing','1234',1,'ended','2026-11-14 00:40:00','2026-11-14 00:40:00','2026-11-14 00:41:00','2026-11-14 00:42:00','2026-11-14 00:42:00')",[id]);
   await db.query("INSERT INTO telephony_pause_segments(operator_id,reason_id,reason_name,max_seconds,productive,started_at,ended_at,operation_id) VALUES(7,1,'Intervalo',30,1,'2026-11-14 00:45:00','2026-11-14 00:46:00','synthetic')");
   await db.query("INSERT INTO telephony_calls(id,operator_id,direction,number,state,prepared_at,sent_at,answered_at,updated_at) VALUES(?,7,'outgoing','5678','observation_lost','2026-11-14 00:30:00','2026-11-14 00:30:00','2026-11-14 00:31:00',UTC_TIMESTAMP())",[randomUUID()]);
   const metrics=await runtimeMetrics(tx,7);assert.equal(metrics.crmDay,'2026-11-13');assert.equal(metrics.attempts,2);assert.equal(metrics.incompleteCalls,1);assert.equal(metrics.conversationSeconds,60);assert.equal(metrics.pauseSeconds,60);assert.equal(metrics.productivePauseSeconds,30);assert.equal(metrics.contacts,2);assert.equal(metrics.closedOrders,1);assert.equal(metrics.closedOrderValue,'100.50');assert.equal(metrics.quotesToClose,1);assert.equal(metrics.scheduledCustomers,1);assert.equal(metrics.overdueSchedules,1);assert.equal(metrics.minimumConversationSeconds,30);assert.equal(metrics.expectedSeconds,180);
   assert.equal(metrics.connectedSeconds,7020);assert.equal(metrics.productivityPercent,1.28);
  });
  await t.test('incoming delayed receipt preserves the observed attempt day and clips cross-midnight conversation',async()=>{
   await db.query(`SET timestamp=${Math.floor(Date.parse('2026-11-14T04:00:00Z')/1000)};SET @inpulse_crm_utc_at=UTC_TIMESTAMP(),@inpulse_crm_transfer_at=DATE_SUB(UTC_TIMESTAMP(),INTERVAL 3 HOUR);DELETE FROM telephony_calls`);
   await db.query("INSERT INTO telephony_calls(id,operator_id,direction,number,state,prepared_at,ringing_at,answered_at,ended_at,updated_at) VALUES(?,7,'incoming','1234','ended','2026-11-14 03:30:00','2026-11-14 02:55:00','2026-11-14 02:56:00','2026-11-14 03:05:00','2026-11-14 03:30:00'),(?,7,'incoming','5678','ended','2026-11-14 03:40:00','2026-11-14 02:40:00','2026-11-14 02:41:00','2026-11-14 02:45:00','2026-11-14 03:40:00')",[randomUUID(),randomUUID()]);
   const metrics=await runtimeMetrics(tx,7);assert.equal(metrics.crmDay,'2026-11-14');assert.equal(metrics.attempts,0);assert.equal(metrics.conversationSeconds,300);
  });
 }finally{await db.query(`DROP DATABASE IF EXISTS \`${name}\``);await db.end();}
});
