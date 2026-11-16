import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import {createTenantMysqlPool,tenantConnectionErrorCode} from "../tenant-database/mysql-pool";

test("only explicitly allowed driver codes can appear in connection diagnostics",()=>{
 assert.equal(tenantConnectionErrorCode({code:"ETIMEDOUT",message:"sensitive",password:"hidden"}),"ETIMEDOUT");
 for(const error of [null,"ECONNRESET",{code:"sensitive-server-secret"},{message:"ER_ACCESS_DENIED_ERROR"},{get code(){throw Error("sensitive");}}])assert.equal(tenantConnectionErrorCode(error),"UNCLASSIFIED");
});

test("a real local connection refusal records only safe phase/code and preserves rejection",async()=>{
 const server=net.createServer();await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));const port=(server.address()as net.AddressInfo).port;await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
 const pool=createTenantMysqlPool({tenant:"odim",host:"127.0.0.1",port,user:"SENSITIVE_USER",password:"SENSITIVE_PASSWORD",database:"SENSITIVE_DATABASE",charset:"latin1_swedish_ci"},1,2000);
 const logs:string[]=[],warn=console.warn;console.warn=(line:unknown)=>{logs.push(String(line));};
 try{await assert.rejects(pool.acquire(),error=>Boolean(error&&typeof error==="object"&&"code"in error&&error.code==="ECONNREFUSED"));assert.equal(logs.length,1);const value=JSON.parse(logs[0]!);assert.deepEqual(Object.keys(value).sort(),["component","elapsedMs","errorCode","phase","tenant"]);assert.equal(value.component,"tenant-connection");assert.equal(value.phase,"acquire");assert.equal(value.tenant,"odim");assert.equal(value.errorCode,"ECONNREFUSED");assert(Number.isFinite(value.elapsedMs));assert(!logs[0]!.includes("SENSITIVE"));}
 finally{console.warn=warn;await pool.end();}
});
