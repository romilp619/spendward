import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dataPath } from "./data.js";
import { withLock } from "./lock.js";

/**
 * Mandates the principal has cancelled before they expired. A revocation is
 * final: to give the agent spending power again, mint a new mandate. Kept as
 * a list of ids so a revoked mandate is refused even if its file is reused.
 */
const path = () => process.env.SPENDWARD_REVOCATIONS ?? dataPath("revoked.json");

function readAll(): Record<string, string> {
  return existsSync(path()) ? (JSON.parse(readFileSync(path(), "utf8")) as Record<string, string>) : {};
}

export function revoke(mandateId: string): string {
  return withLock("revocations", () => {
    const all = readAll();
    all[mandateId] ??= new Date().toISOString();
    writeFileSync(path(), JSON.stringify(all, null, 2) + "\n");
    return all[mandateId]!;
  });
}

export function revokedAt(mandateId: string): string | null {
  return readAll()[mandateId] ?? null;
}
