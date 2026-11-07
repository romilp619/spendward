import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";

/**
 * The principal's saved PayPal wallet, as a Vault payment token. The token is
 * not a credential to the wallet itself -- it lets this PayPal app charge it,
 * and the principal can revoke that from their PayPal account at any time.
 */
export interface Wallet {
  vaultId: string;
  email: string | null;
  customerId: string | null;
  connectedAt: string;
}

const path = () => process.env.SPENDWARD_WALLET ?? "wallet.json";

export function wallet(): Wallet | null {
  if (!existsSync(path())) return null;
  try {
    return JSON.parse(readFileSync(path(), "utf8")) as Wallet;
  } catch {
    return null;
  }
}

export function saveWallet(w: Wallet): void {
  writeFileSync(path(), JSON.stringify(w, null, 2) + "\n", { mode: 0o600 });
}

export function forgetWallet(): void {
  rmSync(path(), { force: true });
}
