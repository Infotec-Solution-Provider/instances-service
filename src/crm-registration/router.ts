import {createHmac,timingSafeEqual} from "node:crypto";
import {Router,json,type NextFunction,type Request,type Response} from "express";
import {getTenantDatabase} from "../services/tenant-database.service";
import type {TenantDatabase} from "../tenant-database/tenant-database";
import {TenantDatabaseError} from "../tenant-database/error";
import {readCrmRegistrationConfig,readCrmRegistrationKey,type CrmRegistrationConfig} from "./config";
import {parseOperation} from "./contract";
import {runCrmRegistration} from "./engine";
import type {RequestHandler} from "express";
export function createCrmRegistrationRouter(database:()=>TenantDatabase=getTenantDatabase,readConfig:()=>CrmRegistrationConfig=readCrmRegistrationConfig,readKey:typeof readCrmRegistrationKey=readCrmRegistrationKey,guard?:RequestHandler){
 const requireInternalTransport=guard??(require('../utils/internal-transport') as {requireInternalTransport:RequestHandler}).requireInternalTransport;
 const router=Router(),nonces=new Map<string,number>();let active=0;
 router.post('/api/instances/:instance/transactions',requireInternalTransport,json({limit:'2mb'}),async(req,res)=>{
  let authenticated=false;
  try{
   const profile=readConfig(),timestamp=req.get('x-tenant-timestamp')||'',nonce=req.get('x-tenant-nonce')||'',signature=req.get('x-tenant-signature')||'',now=Date.now();
   if(req.params['instance']!=='odim'||profile.instance!=='odim'||profile.actorId!==534)return res.status(403).json({code:'TENANT_REGISTRATION_FORBIDDEN',outcome:'NOT_COMMITTED'});
   if(Object.keys(req.query).length||!/^\d{13}$/.test(timestamp)||Math.abs(now-Number(timestamp))>60000||!/^[a-f0-9-]{36}$/.test(nonce)||!/^[a-f0-9]{64}$/.test(signature))return res.status(401).json({code:'TENANT_REGISTRATION_UNAUTHORIZED',outcome:'NOT_COMMITTED'});
   const expected=createHmac('sha256',readKey(profile)).update(`${timestamp}\n${nonce}\n${req.originalUrl}\n${JSON.stringify(req.body)}`).digest();if(!timingSafeEqual(expected,Buffer.from(signature,'hex')))return res.status(401).json({code:'TENANT_REGISTRATION_UNAUTHORIZED',outcome:'NOT_COMMITTED'});authenticated=true;
   for(const[id,until]of nonces)if(until<now)nonces.delete(id);if(nonces.has(nonce)||nonces.size>=10000||active>=8)return res.status(409).json({code:'TENANT_REGISTRATION_TRANSPORT_REPLAY',outcome:'UNKNOWN'});nonces.set(nonce,now+60000);
   const command=parseOperation(req.body);active++;try{return res.json({data:await runCrmRegistration(database(),command,profile)});}finally{active--;}
  }catch(error){if(error instanceof TenantDatabaseError)return res.status(error.code==='TENANT_REGISTRATION_OPERATION_REUSED'||error.code==='TENANT_TRANSACTION_AFFECTED_ROWS'||error.code==='TENANT_CONTACT_IN_USE'?409:503).json({code:error.code,outcome:error.outcome});return res.status(503).json({code:authenticated?'TENANT_TRANSACTION_RESPONSE_LOST':'TENANT_REGISTRATION_NOT_CONFIGURED',outcome:authenticated?'UNKNOWN':'NOT_COMMITTED'});}
 });
 router.use((error:Error&{type?:string},_req:Request,res:Response,next:NextFunction)=>{if(["entity.parse.failed","entity.too.large"].includes(error.type??"")){res.status(error.type==="entity.too.large"?413:400).json({code:'TENANT_TRANSACTION_INVALID_REQUEST',outcome:'NOT_COMMITTED'});return;}next(error);});
 return router;
}
