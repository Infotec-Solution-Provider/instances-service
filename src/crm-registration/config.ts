import fs from "node:fs";
import path from "node:path";
export interface ReviewedCrmTrigger {table:string;name:string;timing:"BEFORE"|"AFTER";event:"INSERT"|"UPDATE"|"DELETE";sqlMode:string;sha256:string}
export interface CrmRegistrationConfig {version:1;instance:"odim";actorId:534;signingKeyFile:string;reviewedTriggers:ReviewedCrmTrigger[]}
export const crmRegistrationConfigPath=path.resolve(__dirname,"../../crm-registration.config.json");
export function readCrmRegistrationConfig(file=crmRegistrationConfigPath):CrmRegistrationConfig {
 const fail=():never=>{throw Error("TENANT_REGISTRATION_NOT_CONFIGURED");};
 try{const stat=fs.lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>32768||(process.platform!=="win32"&&(stat.mode&0o022)!==0))return fail();const p=JSON.parse(fs.readFileSync(file,"utf8")) as CrmRegistrationConfig;
  if(!p||typeof p!=="object"||Array.isArray(p)||Object.keys(p).sort().join(",")!=="actorId,instance,reviewedTriggers,signingKeyFile,version"||p.version!==1||p.instance!=="odim"||p.actorId!==534||typeof p.signingKeyFile!=="string"||!path.isAbsolute(p.signingKeyFile)||!Array.isArray(p.reviewedTriggers)||p.reviewedTriggers.length>32)return fail();
  const identities=new Set<string>();for(const t of p.reviewedTriggers){if(!t||typeof t!=="object"||Object.keys(t).sort().join(",")!=="event,name,sha256,sqlMode,table,timing"||![t.table,t.name].every(s=>typeof s==="string"&&/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(s))||!["BEFORE","AFTER"].includes(t.timing)||!["INSERT","UPDATE","DELETE"].includes(t.event)||typeof t.sqlMode!=="string"||t.sqlMode.length>1024||!/^[a-f0-9]{64}$/.test(t.sha256)||identities.has(t.table+":"+t.name))return fail();identities.add(t.table+":"+t.name);}
  return p;
 }catch{return fail();}
}
export function readCrmRegistrationKey(profile:CrmRegistrationConfig):Buffer{const s=fs.lstatSync(profile.signingKeyFile);if(!s.isFile()||s.isSymbolicLink()||s.size<32||s.size>4096||(process.platform!=="win32"&&(s.mode&0o077)!==0))throw Error("TENANT_REGISTRATION_NOT_CONFIGURED");return fs.readFileSync(profile.signingKeyFile);}
