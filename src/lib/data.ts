import { join } from "node:path";

/**
 * Where Spendward keeps its state. One setting moves all of it, which is what
 * a host with a separate persistent disk (Render, for one) needs. Each file's
 * own SPENDWARD_* variable still overrides this, as the tests rely on.
 */
export const dataPath = (name: string): string => join(process.env.SPENDWARD_DATA_DIR ?? ".", name);
