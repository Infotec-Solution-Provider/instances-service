import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {createHash,randomUUID} from "node:crypto";
import mysql from "mysql2/promise";
import {TenantDatabase} from "../tenant-database/tenant-database";
import {tenantDatabaseConfig} from "../tenant-database/config";
import {runCrmRegistration} from "./engine";
import type {CrmRegistrationConfig} from "./config";
import type {CrmOperation} from "./contract";
const evidence=process.env['CRM_PILOT_REVIEW_DIR']||'C:/Workspace/infotec/planejamento/cross-service/INF-20261113-002-telefonia-finalizacao-financeiro/artifacts/production-20261116/pilot-534';
const json=(name:string)=>JSON.parse(fs.readFileSync(path.join(evidence,name),'utf8').replace(/^\uFEFF/,''));
for(const port of [13555,13480])test(`real reviewed ODIM trigger retention on isolated MySQL ${port}`,async()=>{
 const name=`crm_odim_trigger_${process.pid}_${Date.now()}_${port}`,admin=await mysql.createConnection({host:'127.0.0.1',port,user:'root'});assert(/^crm_odim_trigger_[0-9_]+$/.test(name));await admin.query('CREATE DATABASE `'+name+'` CHARACTER SET latin1');const sql=await mysql.createConnection({host:'127.0.0.1',port,user:'root',database:name,charset:'utf8mb4',dateStrings:true});let db:TenantDatabase|undefined;
 try{
  await sql.query("SET SESSION sql_mode='NO_AUTO_VALUE_ON_ZERO'");
  for(const table of ['clientes','fones_campanha_cli','alteracoes_clientes'])await sql.query(json('schema-'+table+'.json').rows[0]['Create Table'].replace(/ AUTO_INCREMENT=\d+/g,''));
  for(const table of ['_log','_logdetalhe','campanhas','segmentos','transferencia_clientes','transferencia_clientes_itens','marcas'])await sql.query('CREATE TABLE `'+table+'`(CODIGO INT PRIMARY KEY) ENGINE=InnoDB');
  // Production Windows resolves this upper-case legacy reference to campanhas.
  // Linux fixtures retain case-sensitive names, so a read-only view mirrors it.
  await sql.query("CREATE VIEW CAMPANHAS AS SELECT CODIGO,'ATIVOS' AS TIPO FROM campanhas");
  await sql.query('CREATE TABLE parametros(CODIGO INT PRIMARY KEY) ENGINE=InnoDB');await sql.query('INSERT INTO parametros VALUES(1)');await sql.query("CREATE TABLE operadores(CODIGO INT PRIMARY KEY,ATIVO VARCHAR(3)) ENGINE=InnoDB");await sql.query("INSERT INTO operadores VALUES(534,'SIM')");await sql.query('CREATE TABLE contatos(CODIGO INT PRIMARY KEY) ENGINE=InnoDB');await sql.query('CREATE TABLE motivo_desativacao_cliente(CLIENTE INT) ENGINE=InnoDB');await sql.query('CREATE TABLE clientes_marcas(CODIGO INT PRIMARY KEY,CLIENTE INT,MARCA INT,DATA_ULTIMA_COMPRA DATE,OPERADOR INT) ENGINE=InnoDB');await sql.query(fs.readFileSync(path.resolve(__dirname,'schema.sql'),'utf8'));
  const review=json('odim-triggers-reviewed.json').rows as Array<Record<string,string>>;
  const selected=review.filter(r=>['tg_clientes_add','tg_clientes_alt'].includes(r['TRIGGER_NAME']!));
  for(const row of selected){const body=Buffer.from(row['action_hex']!,'hex');assert.equal(Buffer.from(body.toString('utf8'),'utf8').equals(body),true,'reviewed trigger bytes must roundtrip UTF8 without mojibake');await sql.query(`CREATE TRIGGER \`${row['TRIGGER_NAME']}\` ${row['ACTION_TIMING']} ${row['EVENT_MANIPULATION']} ON \`${row['EVENT_OBJECT_TABLE']}\` FOR EACH ROW ${body.toString('utf8')}`);}
  const actual=(await sql.query<any[]>("SELECT TRIGGER_NAME AS name,EVENT_OBJECT_TABLE AS tableName,ACTION_TIMING AS timing,EVENT_MANIPULATION AS event,SQL_MODE AS sqlMode,HEX(ACTION_STATEMENT) AS hex FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE()"))[0];
  const expected=json('crm-reviewed-triggers.json').filter((r:any)=>r.table==='clientes'&&r.event!=='DELETE');
  for(const row of actual){const hash=createHash('sha256').update(Buffer.from(row.hex,'hex')).digest('hex');assert.equal(hash,expected.find((r:any)=>r.name===row.name).sha256,'actual trigger source must preserve reviewed HEX bytes');}
  const profile:CrmRegistrationConfig={version:1,instance:'odim',actorId:534,signingKeyFile:'/unused',reviewedTriggers:expected};
  db=new TenantDatabase(async tenant=>({tenant,host:'127.0.0.1',port,user:'root',password:'',database:name}),{...tenantDatabaseConfig({}),transactionMs:30000});
  const operation:CrmOperation={operation:'crm.registration',instance:'odim',actorId:534,action:'batch',operationId:randomUUID(),requestHash:'a'.repeat(64),kind:'customer.create',entity:'customer',customerId:0,id:0,input:{operation:'crm.customer.write',customerId:0,syncPhones:true,deferredPhones:{AREA1:51,FONE1:'999999991',AREA2:51,FONE2:'999999992',AREA3:51,FONE3:'999999993',AREAFAX:51,FAX:'999999994'},tables:['clientes','parametros','fones_campanha_cli'],statements:[{sql:'INSERT INTO clientes(RAZAO,ATIVO,COD_ERP) SELECT ?,?,NULL FROM DUAL',params:['Isolated fixture','SIM'],expectAffectedRows:1}]}};
  const result=await runCrmRegistration(db,operation,profile) as Array<{insertId:number}>;const customerId=result[0]!.insertId;
  const civil=(await sql.query<any[]>('SELECT TIMESTAMPDIFF(SECOND,DATACAD,NOW()) AS seconds FROM clientes WHERE CODIGO=?',[customerId]))[0][0];assert(Math.abs(Number(civil.seconds))<5,'DATACAD must preserve the tenant civil clock used by the legacy trigger');
  const ledger=(await sql.query<any[]>('SELECT TIMESTAMPDIFF(SECOND,created_at,UTC_TIMESTAMP()) AS seconds FROM crm_registration_receipts WHERE operation_id=?',[operation.operationId]))[0][0];assert(Math.abs(Number(ledger.seconds))<5,'receipt clock must remain UTC');
  const phones=(await sql.query<any[]>('SELECT FONE FROM fones_campanha_cli WHERE CLIENTE=? ORDER BY CODIGO',[customerId]))[0].map(r=>r.FONE);assert.equal(phones.length,3);assert(!phones.includes('51999999994'));assert.equal((await sql.query<any[]>('SELECT COUNT(*) AS n FROM fones_campanha_cli WHERE CLIENTE=0'))[0][0].n,0);assert.equal((await sql.query<any[]>('SELECT FAX FROM clientes WHERE CODIGO=?',[customerId]))[0][0].FAX,'999999994');
  await sql.query("INSERT INTO fones_campanha_cli(CLIENTE,FONE) VALUES(?,?)",[customerId,'51988888888']);
  const update:CrmOperation={...operation,operationId:randomUUID(),requestHash:'b'.repeat(64),kind:'customer.patch',customerId,id:customerId,input:{operation:'crm.customer.write',customerId,syncPhones:true,tables:['clientes','parametros','fones_campanha_cli'],statements:[{sql:'UPDATE clientes SET FONE1=? WHERE CODIGO=?',params:['977777777',customerId],expectAffectedRows:1}]}};
  await runCrmRegistration(db,update,profile);const retained=(await sql.query<any[]>('SELECT FONE FROM fones_campanha_cli WHERE CLIENTE=? ORDER BY CODIGO',[customerId]))[0].map(r=>r.FONE);assert.equal(retained.length,3);assert(retained.includes('51988888888'),'helper must not delete the legacy-retained previous destination');assert(!retained.includes('51999999994'));
 }finally{await db?.close();await sql.end();await admin.query('DROP DATABASE `'+name+'`');await admin.end();}
});
