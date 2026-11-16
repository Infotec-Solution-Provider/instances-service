import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import mysql from "mysql2/promise";
import {TenantDatabase} from "../tenant-database/tenant-database";
import {tenantDatabaseConfig} from "../tenant-database/config";

test("real MySQL5.5 delayed handshake uses only the trusted connection budget",async t=>{
 const admin=await mysql.createConnection({host:"127.0.0.1",port:13555,user:"root"}),name=`crm_connect_deadline_${process.pid}_${Date.now()}`;assert(/^crm_connect_deadline_[0-9_]+$/.test(name));await admin.query('CREATE DATABASE `'+name+'`');await admin.query('CREATE TABLE `'+name+'`.probe(id INT PRIMARY KEY) ENGINE=InnoDB');
 const sockets=new Set<net.Socket>(),timers=new Set<ReturnType<typeof setTimeout>>();
 const proxy=net.createServer(client=>{const upstream=net.connect({host:"127.0.0.1",port:13555});sockets.add(client);sockets.add(upstream);client.pause();upstream.pause();client.on('error',()=>{});upstream.on('error',()=>client.destroy());client.on('close',()=>{sockets.delete(client);upstream.destroy();});upstream.on('close',()=>{sockets.delete(upstream);client.destroy();});const timer=setTimeout(()=>{timers.delete(timer);if(!client.destroyed&&!upstream.destroyed){client.pipe(upstream);upstream.pipe(client);client.resume();upstream.resume();}},2500);timers.add(timer);});
 await new Promise<void>(resolve=>proxy.listen(0,"127.0.0.1",resolve));const port=(proxy.address()as net.AddressInfo).port;
 const run=async(connectionTimeoutMs:number|undefined,transactionMs:number,query:string)=>{const db=new TenantDatabase(async tenant=>({tenant,host:"127.0.0.1",port,user:"root",password:"",database:name,charset:"latin1_swedish_ci",...(connectionTimeoutMs===undefined?{}:{connectionTimeoutMs})}),{...tenantDatabaseConfig({}),waitMs:2000,transactionMs});try{return await db.transaction("odim","crm.registration.write",["probe"],tx=>tx.execute(query));}finally{await db.close();}};
 try{
  await t.test("unchanged two-second default rejects the slow real handshake",async()=>{await assert.rejects(run(undefined,30000,"SELECT 1 AS ready"),{code:"TENANT_CONNECTION_UNAVAILABLE"});});
  await t.test("ten-second override survives handshake and commits once",async()=>{const at=Date.now(),rows=await run(10000,30000,"SELECT 1 AS ready")as Array<{ready:string|number}>;assert.equal(Number(rows[0]?.ready),1);assert(Date.now()-at>=2500);assert(Date.now()-at<10000);});
  await t.test("connection override never extends the transaction deadline",async()=>{await assert.rejects(run(10000,200,"SELECT SLEEP(1)"),{code:"TENANT_TRANSACTION_TIMEOUT"});});
  await t.test("unbounded or invalid overrides are rejected before connection",async()=>{for(const value of [0,10001,NaN])await assert.rejects(run(value,30000,"SELECT 1"),{code:"TENANT_DESTINATION_INVALID"});});
 }finally{for(const timer of timers)clearTimeout(timer);for(const socket of sockets)socket.destroy();await new Promise<void>(resolve=>proxy.close(()=>resolve()));await admin.query('DROP DATABASE `'+name+'`');await admin.end();}
});
