import {createHash} from "node:crypto";
import {TenantDatabaseError} from "../tenant-database/error";
import type {TenantTransaction} from "../tenant-database/transaction";
import type {TenantDatabase} from "../tenant-database/tenant-database";
import {synchronizeCustomerPhones} from "../services/customer-phone-sync";
import type {CrmRegistrationConfig} from "./config";
import {contactColumns,id,invalid,object,parseCustomerBatch,values,type CrmOperation,type Row,type Value} from "./contract";

const writtenTables=["clientes","contatos","clientes_marcas","motivo_desativacao_cliente","fones_campanha_cli","alteracoes_clientes","_log","_logdetalhe","crm_registration_receipts"];
const baseTables=[...writtenTables,"campanhas","operadores","parametros","segmentos","transferencia_clientes","transferencia_clientes_itens","marcas"];
const fail=(code:string):never=>{throw new TenantDatabaseError(code);};
const quote=(name:string)=>{if(!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(name))return invalid();return`\`${name}\``;};
async function rows<T=Row>(tx:TenantTransaction,sql:string,args:readonly unknown[]=[]){return tx.execute<T[]>(sql,args);}
async function reviewedTriggers(tx:TenantTransaction,profile:CrmRegistrationConfig){
 const found=await rows(tx,`SELECT EVENT_OBJECT_TABLE AS tableName,TRIGGER_NAME AS name,ACTION_TIMING AS timing,EVENT_MANIPULATION AS event,SQL_MODE AS sqlMode,HEX(ACTION_STATEMENT) AS actionHex FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE() AND EVENT_OBJECT_TABLE IN (${writtenTables.map(()=>"?").join(',')}) ORDER BY EVENT_OBJECT_TABLE,TRIGGER_NAME`,writtenTables);
 if(found.length!==profile.reviewedTriggers.length)return fail('TENANT_TRANSACTION_UNREVIEWED_TRIGGERS');
 for(const actual of found){const expected=profile.reviewedTriggers.find(t=>t.table===actual['tableName']&&t.name===actual['name']),hex=actual['actionHex'];if(!expected||typeof hex!=='string'||!(/^(?:[a-f0-9]{2})*$/i.test(hex))||expected.timing!==actual['timing']||expected.event!==actual['event']||expected.sqlMode!==actual['sqlMode']||createHash('sha256').update(Buffer.from(hex,'hex')).digest('hex')!==expected.sha256)return fail('TENANT_TRANSACTION_UNREVIEWED_TRIGGERS');}
}
async function validateLedger(tx:TenantTransaction){
 const columns=await rows(tx,"SELECT COLUMN_NAME,COLUMN_TYPE,IS_NULLABLE,COLUMN_KEY,CHARACTER_SET_NAME,COLLATION_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='crm_registration_receipts' ORDER BY ORDINAL_POSITION");
 const names=['operation_id','actor_id','kind','request_hash','result_json','created_at'];
 if(columns.length!==names.length||columns.some((r,i)=>r['COLUMN_NAME']!==names[i]||r['IS_NULLABLE']!=='NO')||columns[0]?.['COLUMN_TYPE']!=='char(36)'||columns[0]?.['COLUMN_KEY']!=='PRI'||columns[0]?.['COLLATION_NAME']!=='ascii_bin'||!/^int(?:\(11\))?$/.test(String(columns[1]?.['COLUMN_TYPE']))||columns[2]?.['COLUMN_TYPE']!=='varchar(40)'||columns[3]?.['COLUMN_TYPE']!=='char(64)'||columns[3]?.['COLLATION_NAME']!=='ascii_bin'||columns[4]?.['COLUMN_TYPE']!=='longtext'||columns[5]?.['COLUMN_TYPE']!=='datetime')return fail('TENANT_REGISTRATION_LEDGER_UNAVAILABLE');
}
async function lockPolicy(tx:TenantTransaction){const p=await rows(tx,'SELECT CODIGO FROM parametros ORDER BY CODIGO LIMIT 2 FOR UPDATE');if(p.length!==1)return fail('TENANT_CUSTOMER_POLICY_UNAVAILABLE');}
async function existing(tx:TenantTransaction,op:CrmOperation){const record=(await rows(tx,'SELECT actor_id,kind,request_hash,result_json FROM crm_registration_receipts WHERE operation_id=? FOR UPDATE',[op.operationId]))[0];if(!record)return null;if(Number(record['actor_id'])!==op.actorId||(op.requestHash!==undefined&&record['request_hash']!==op.requestHash))return fail('TENANT_REGISTRATION_OPERATION_REUSED');try{return object(JSON.parse(String(record['result_json'])));}catch{return fail('TENANT_REGISTRATION_LEDGER_UNAVAILABLE');}}
const acknowledgement=(r:Row)=>({affectedRows:Number(r['affectedRows']),...(Number.isSafeInteger(r['insertId'])&&Number(r['insertId'])>0?{insertId:Number(r['insertId'])}:{})});
function receipt(op:CrmOperation,entity:string,customerId:number,targetId:number){return{operationId:op.operationId,outcome:'COMMITTED',status:'committed',retryAllowed:false,result:{entity,customerId,id:targetId}};}
async function save(tx:TenantTransaction,op:CrmOperation,result:Row){await tx.execute('INSERT INTO crm_registration_receipts(operation_id,actor_id,kind,request_hash,result_json,created_at) VALUES(?,?,?,?,?,UTC_TIMESTAMP())',[op.operationId,op.actorId,op.kind,op.requestHash!,JSON.stringify(result)]);}

async function customer(tx:TenantTransaction,op:CrmOperation,profile:CrmRegistrationConfig){
 if(op.entity!=='customer'||!['customer.create','customer.patch'].includes(op.kind))return invalid();const batch=parseCustomerBatch(op.input);if(op.customerId!==batch.customerId||op.id!==batch.customerId||(batch.customerId===0)!==(op.kind==='customer.create'))return invalid();
 if(batch.customerId){const found=await rows(tx,'SELECT CODIGO FROM clientes WHERE CODIGO=? FOR UPDATE',[batch.customerId]);if(found.length!==1)return fail('TENANT_TRANSACTION_AFFECTED_ROWS');}
 const results:Row[]=[];let customerId=batch.customerId;
 for(const[index,s]of batch.statements.entries()){
  if(index===0&&customerId===0){const columns=/^INSERT INTO `?clientes`?\s*\(([^)]+)\)/i.exec(s.sql)?.[1]?.split(',').map(k=>k.trim().replace(/`/g,''));if(!columns||columns.some(c=>Object.hasOwn(batch.deferredPhones!,c)))return invalid();}
  const result=await tx.execute<Row>(s.sql,s.params);if(Number(result['affectedRows'])!==s.expectAffectedRows)return fail('TENANT_TRANSACTION_AFFECTED_ROWS');results.push(acknowledgement(result));
  if(index===0&&!customerId){customerId=id(Number(result['insertId']));const patch=batch.deferredPhones!,keys=Object.keys(patch);const updated=await tx.execute<Row>(`UPDATE clientes SET ${keys.map(k=>quote(k)+'=?').join(',')} WHERE CODIGO=?`,[...keys.map(k=>patch[k]),customerId]);if(Number(updated['affectedRows'])!==1)return fail('TENANT_TRANSACTION_AFFECTED_ROWS');}
 }
 if(batch.syncPhones)await synchronizeCustomerPhones(tx,customerId,profile.reviewedTriggers.some(t=>t.table==='clientes'&&t.name==='tg_clientes_alt'));
 return{acks:results,receipt:receipt(op,'customer',customerId,customerId)};
}
function primitiveRecord(v:unknown,columns:string[]){return values(v,columns);}
async function compare(tx:TenantTransaction,table:string,customerId:number,targetId:number,expected:Record<string,Value>){
 const found=(await rows(tx,`SELECT ${Object.keys(expected).map(quote).join(',')} FROM ${quote(table)} WHERE CODIGO=? AND CLIENTE=? FOR UPDATE`,[targetId,customerId]))[0];if(!found)return fail('TENANT_TRANSACTION_AFFECTED_ROWS');for(const[k,v]of Object.entries(expected)){const actual=found[k];if((actual??null)!==v)return fail('TENANT_TRANSACTION_AFFECTED_ROWS');}
}
async function structuralSingle(tx:TenantTransaction,op:CrmOperation){
 if(!['contact','brand'].includes(op.entity)||!op.customerId)return invalid();const input=object(op.input,['fields','expected']),creating=op.kind.endsWith('.create'),patching=op.kind.endsWith('.patch'),removing=op.kind.endsWith('.remove');
 if(![op.entity+'.create',op.entity+'.patch',op.entity+'.remove'].includes(op.kind)||(creating?op.id!==0:op.id<1)||(op.entity==='brand'&&patching))return invalid();
 const parent=await rows(tx,'SELECT CODIGO FROM clientes WHERE CODIGO=? FOR UPDATE',[op.customerId]);if(parent.length!==1)return fail('TENANT_TRANSACTION_AFFECTED_ROWS');
 let targetId=op.id,result:Row;
 if(op.entity==='contact'){
  const fields=primitiveRecord(input['fields']??{},contactColumns),keys=Object.keys(fields);if((creating||patching)&&(!keys.length||fields['NOME']===''))return invalid();
  if(creating){if(input['expected']!==undefined)return invalid();const max=(await rows(tx,'SELECT CODIGO FROM contatos ORDER BY CODIGO DESC LIMIT 1 FOR UPDATE'))[0];targetId=id(Number(max?.['CODIGO']??0)+1);result=await tx.execute<Row>(`INSERT INTO contatos (CODIGO,CLIENTE,${keys.map(quote).join(',')}) VALUES(?,?,${keys.map(()=>'?').join(',')})`,[targetId,op.customerId,...keys.map(k=>fields[k])]);}
  else{
   const expected=primitiveRecord(input['expected'],['CODIGO','CLIENTE',...contactColumns]);if(expected['CODIGO']!==op.id||expected['CLIENTE']!==op.customerId||Object.keys(expected).length<3)return invalid();await compare(tx,'contatos',op.customerId,op.id,expected);
   if(patching)result=await tx.execute<Row>(`UPDATE contatos SET ${keys.map(k=>quote(k)+'=?').join(',')} WHERE CODIGO=? AND CLIENTE=?`,[...keys.map(k=>fields[k]),op.id,op.customerId]);
   else{
    if(!removing||keys.length)return invalid();const refs=await rows(tx,"SELECT TABLE_NAME,COLUMN_NAME FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA=DATABASE() AND REFERENCED_TABLE_SCHEMA=DATABASE() AND REFERENCED_TABLE_NAME='contatos' AND REFERENCED_COLUMN_NAME='CODIGO'");for(const ref of refs){const found=await rows(tx,`SELECT 1 FROM ${quote(String(ref['TABLE_NAME']))} WHERE ${quote(String(ref['COLUMN_NAME']))}=? LIMIT 1`,[op.id]);if(found.length)return fail('TENANT_CONTACT_IN_USE');}result=await tx.execute<Row>('DELETE FROM contatos WHERE CODIGO=? AND CLIENTE=?',[op.id,op.customerId]);
   }
  }
 }else if(creating){const fields=primitiveRecord(input['fields'],['MARCA']);const brandId=id(fields['MARCA']);if(input['expected']!==undefined)return invalid();const brand=await rows(tx,'SELECT CODIGO FROM marcas WHERE CODIGO=? FOR UPDATE',[brandId]);if(brand.length!==1)return fail('TENANT_TRANSACTION_AFFECTED_ROWS');const old=(await rows(tx,'SELECT CODIGO FROM clientes_marcas WHERE CLIENTE=? AND MARCA=? AND DATA_ULTIMA_COMPRA IS NULL ORDER BY CODIGO LIMIT 1 FOR UPDATE',[op.customerId,brandId]))[0];if(old){targetId=id(Number(old['CODIGO']));result={affectedRows:1,insertId:targetId};}else{result=await tx.execute<Row>('INSERT INTO clientes_marcas(CLIENTE,MARCA,DATA_ULTIMA_COMPRA,OPERADOR) VALUES(?,?,NULL,?)',[op.customerId,brandId,534]);targetId=id(Number(result['insertId']));}}
 else{if(!removing||Object.keys(object(input['fields']??{})).length)return invalid();const expected=primitiveRecord(input['expected'],['CODIGO','CLIENTE','MARCA','DATA_ULTIMA_COMPRA','OPERADOR']);if(expected['CODIGO']!==op.id||expected['CLIENTE']!==op.customerId||expected['DATA_ULTIMA_COMPRA']!==null||!Number.isSafeInteger(expected['MARCA']))return invalid();await compare(tx,'clientes_marcas',op.customerId,op.id,expected);result=await tx.execute<Row>('DELETE FROM clientes_marcas WHERE CODIGO=? AND CLIENTE=? AND DATA_ULTIMA_COMPRA IS NULL',[op.id,op.customerId]);}
 if(Number(result['affectedRows'])!==1)return fail('TENANT_TRANSACTION_AFFECTED_ROWS');const ack=acknowledgement(result);if(creating)ack.insertId=targetId;return{acks:[ack],receipt:receipt(op,op.entity,op.customerId,targetId)};
}
export async function executeCrmRegistration(tx:TenantTransaction,op:CrmOperation,profile:CrmRegistrationConfig){
 if(op.instance!=='odim'||op.actorId!==534||profile.instance!=='odim'||profile.actorId!==534)return invalid();
 await lockPolicy(tx);await validateLedger(tx);const old=await existing(tx,op);if(old)return op.action==='receipt'?old['receipt']:old['acks'];
 if(op.action==='receipt')return{operationId:op.operationId,outcome:'NOT_COMMITTED',status:'not_found',retryAllowed:false};
 const actor=await rows(tx,'SELECT CODIGO,ATIVO FROM operadores WHERE CODIGO=? FOR UPDATE',[534]);if(actor.length!==1||actor[0]!['ATIVO']!=='SIM')return fail('TENANT_REGISTRATION_ACTOR_UNAVAILABLE');await reviewedTriggers(tx,profile);
 if(op.action==='preflight')return{ready:true,instance:'odim',actorId:534,ledger:true,reviewedTriggerCount:profile.reviewedTriggers.length,crmWrites:0};
 const result=op.action==='batch'?await customer(tx,op,profile):await structuralSingle(tx,op);await save(tx,op,result);return result.acks;
}
export async function runCrmRegistration(database:TenantDatabase,op:CrmOperation,profile:CrmRegistrationConfig){const extra=op.action==='batch'?parseCustomerBatch(op.input).tables:[];return database.transaction('odim','crm.registration.write',[...new Set([...baseTables,...extra])],tx=>executeCrmRegistration(tx,op,profile));}
