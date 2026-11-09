import { openSync, closeSync, unlinkSync, statSync } from "node:fs";

/**
 * A cross-process lock on a file, so the MCP server and the dashboard -- two
 * processes writing the same ledger -- never interleave a read-modify-write.
 * O_EXCL creation is atomic on every local filesystem. A lock older than a few
 * seconds is from a process that died holding it, and is taken over.
 */
const STALE_MS = 10_000;
const sleep = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

export function withLock<T>(name: string, fn: () => T): T {
  const file = `${process.env.SPENDWARD_LOCK_DIR ?? process.env.SPENDWARD_DATA_DIR ?? "."}/.${name}.lock`;
  const deadline = Date.now() + 15_000;
  for (;;) {
    try {
      closeSync(openSync(file, "wx"));
      break;
    } catch {
      try {
        if (Date.now() - statSync(file).mtimeMs > STALE_MS) { unlinkSync(file); continue; }
      } catch { continue; }
      if (Date.now() > deadline) throw new Error(`timed out waiting for the ${name} lock`);
      sleep(15);
    }
  }
  try {
    return fn();
  } finally {
    try { unlinkSync(file); } catch { /* already released */ }
  }
}

/** The async form, for work that awaits (a PayPal call) inside the critical section. */
export async function withLockAsync<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const file = `${process.env.SPENDWARD_LOCK_DIR ?? process.env.SPENDWARD_DATA_DIR ?? "."}/.${name}.lock`;
  const deadline = Date.now() + 120_000;
  for (;;) {
    try {
      closeSync(openSync(file, "wx"));
      break;
    } catch {
      try {
        if (Date.now() - statSync(file).mtimeMs > 120_000) { unlinkSync(file); continue; }
      } catch { continue; }
      if (Date.now() > deadline) throw new Error(`timed out waiting for the ${name} lock`);
      await new Promise((r) => setTimeout(r, 25));
    }
  }
  try {
    return await fn();
  } finally {
    try { unlinkSync(file); } catch { /* already released */ }
  }
}
