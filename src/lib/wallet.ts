import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

/**
 * The principal's saved PayPal wallet, as a Vault payment token. The token is
 * not a credential to the wallet itself -- it lets this PayPal app charge it,
 * and the principal can revoke that from their PayPal account at any time.
 *
 * Stored encrypted (AES-256-GCM) under a key derived from AUDIT_KEY, so a
 * copy of the file on its own charges nothing.
 */
export interface Wallet {
  vaultId: string;
  email: string | null;
  customerId: string | null;
  connectedAt: string;
}

const path = () => process.env.SPENDWARD_WALLET ?? "wallet.json";

function key(): Buffer {
  const secret = process.env.AUDIT_KEY;
  if (!secret) throw new Error("AUDIT_KEY is not set. Run `npm run setup`.");
  return Buffer.from(hkdfSync("sha256", secret, "spendward", "wallet-at-rest", 32));
}

interface Sealed { v: 1; iv: string; tag: string; data: string }

function seal(w: Wallet): Sealed {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key(), iv);
  const data = Buffer.concat([c.update(JSON.stringify(w), "utf8"), c.final()]);
  return { v: 1, iv: iv.toString("base64"), tag: c.getAuthTag().toString("base64"), data: data.toString("base64") };
}

function open(s: Sealed): Wallet {
  const d = createDecipheriv("aes-256-gcm", key(), Buffer.from(s.iv, "base64"));
  d.setAuthTag(Buffer.from(s.tag, "base64"));
  return JSON.parse(Buffer.concat([d.update(Buffer.from(s.data, "base64")), d.final()]).toString("utf8")) as Wallet;
}

export function wallet(): Wallet | null {
  if (!existsSync(path())) return null;
  try {
    const raw = JSON.parse(readFileSync(path(), "utf8")) as Sealed | Wallet;
    if ("vaultId" in raw) {
      // Saved before encryption existed: seal it now, in place.
      saveWallet(raw);
      return raw;
    }
    return open(raw);
  } catch {
    return null;
  }
}

export function saveWallet(w: Wallet): void {
  writeFileSync(path(), JSON.stringify(seal(w)) + "\n", { mode: 0o600 });
}

export function forgetWallet(): void {
  rmSync(path(), { force: true });
}
