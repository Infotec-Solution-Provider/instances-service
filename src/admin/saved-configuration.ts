import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";
import { AdminProtocolError } from "./admin-protocol";

function encryptionKey(identity: string): Buffer {
  const secret = process.env["ADMIN_SECRETS_KEY"] || process.env["ADMIN_REVISION_KEY"];
  if (!secret || secret.length < 32) throw new AdminProtocolError(503, "Chave da configuração protegida não configurada.");
  return createHmac("sha256", secret).update(`infotec-admin-saved-configuration-v1\0${identity}`).digest();
}
export function sealConfiguration(identity: string, value: unknown): string {
  const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", encryptionKey(identity), iv);
  cipher.setAAD(Buffer.from(identity));
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return `${iv.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}.${encrypted.toString("base64url")}`;
}
export function openConfiguration(identity: string, value: string): Record<string, unknown> {
  try {
    const [iv, tag, encrypted] = value.split(".");
    if (!iv || !tag || !encrypted) throw new Error();
    const decipher = createDecipheriv("aes-256-gcm", encryptionKey(identity), Buffer.from(iv, "base64url"));
    decipher.setAAD(Buffer.from(identity)); decipher.setAuthTag(Buffer.from(tag, "base64url"));
    const parsed: unknown = JSON.parse(Buffer.concat([decipher.update(Buffer.from(encrypted, "base64url")), decipher.final()]).toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    return parsed as Record<string, unknown>;
  } catch { throw new AdminProtocolError(503, "Não foi possível abrir a configuração protegida. Verifique a chave de criptografia."); }
}
