import test from "node:test";
import assert from "node:assert/strict";
import mysql from "mysql2/promise";
import {createTenantMysqlPool} from "../tenant-database/mysql-pool";
import {TenantPoolRegistry} from "../tenant-database/pool-registry";
import {tenantDatabaseConfig} from "../tenant-database/config";
import type {TenantDestination} from "../tenant-database/contracts";

for(const port of [13555,13480])test(`trusted legacy charset and default remain isolated on MySQL ${port}`,async()=>{
 const base:TenantDestination={tenant:"odim",host:"127.0.0.1",port,user:"root",password:"",database:"information_schema"};
 for(const charset of ["latin1_swedish_ci",undefined] as const){
  const pool=createTenantMysqlPool({...base,...(charset?{charset}:{})},1,2000);let connection;
  try{connection=await pool.acquire();const rows=await connection.execute("SELECT @@collation_connection AS collationName,? AS label",["Razão João"] ) as Array<{collationName:string;label:string}>;assert.equal(rows[0]?.collationName,charset??"utf8mb4_unicode_ci");assert.equal(rows[0]?.label,"Razão João");}
  finally{connection?.release();await pool.end();}
 }
 const direct=await mysql.createConnection({host:"127.0.0.1",port,user:"root",charset:"latin1_swedish_ci"});try{const [rows]=await direct.query<any[]>("SELECT @@collation_connection AS collationName");assert.equal(rows[0].collationName,"latin1_swedish_ci","separate legacy pool session must remain unchanged");}finally{await direct.end();}
});

test("charset is included in the pool fingerprint and retires the previous pool",async()=>{
 const created:Array<string|undefined>=[],closed:Array<string|undefined>=[];
 const registry=new TenantPoolRegistry(tenantDatabaseConfig({}),(destination)=>{created.push(destination.charset);return{acquire:async()=>{throw Error("NOT_USED");},end:async()=>{closed.push(destination.charset);}};});
 const destination:TenantDestination={tenant:"odim",host:"127.0.0.1",port:3306,user:"unused",password:"",database:"unused"};
 try{const before=await registry.lease(destination);before.release();const after=await registry.lease({...destination,charset:"latin1_swedish_ci"});after.release();assert.deepEqual(created,[undefined,"latin1_swedish_ci"]);assert.deepEqual(closed,[undefined]);}finally{await registry.close();}
});
