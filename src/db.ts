import pg from "pg";
import { readFile, readdir } from "node:fs/promises";
import { hash } from "./crypto.js";
import { demoRules } from "./policy.js";
export type Tx = pg.PoolClient;
export const createPool = (url: string) =>
  new pg.Pool({ connectionString: url, max: 12 });
export async function transaction<T>(
  pool: pg.Pool,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  const tx = await pool.connect();
  try {
    await tx.query("BEGIN");
    const result = await fn(tx);
    await tx.query("COMMIT");
    return result;
  } catch (e) {
    await tx.query("ROLLBACK");
    throw e;
  } finally {
    tx.release();
  }
}
export async function audit(
  tx: Tx,
  actor: string,
  action: string,
  target: string,
  detail: unknown = {},
) {
  await tx.query(
    "INSERT INTO audit_entries(actor,action,target,detail) VALUES($1,$2,$3,$4)",
    [actor, action, target, JSON.stringify(detail)],
  );
}
export async function migrate(pool: pg.Pool) {
  await transaction(pool, async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock(731094)");
    await tx.query(
      "CREATE TABLE IF NOT EXISTS schema_migrations(name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())",
    );
    const directory = new URL("../migrations/", import.meta.url);
    for (const name of (await readdir(directory))
      .filter((n) => n.endsWith(".sql"))
      .sort()) {
      const sql = await readFile(new URL(name, directory), "utf8");
      const existing = (
        await tx.query("SELECT checksum FROM schema_migrations WHERE name=$1", [
          name,
        ])
      ).rows[0];
      if (existing && existing.checksum !== hash(sql))
        throw new Error("Migration checksum mismatch: " + name);
      if (!existing) {
        await tx.query(sql);
        await tx.query(
          "INSERT INTO schema_migrations(name,checksum) VALUES($1,$2)",
          [name, hash(sql)],
        );
      }
    }
    if (!(await tx.query("SELECT 1 FROM policy_head")).rowCount) {
      const p = (
        await tx.query(
          "INSERT INTO policy_versions(rules) VALUES($1) RETURNING id",
          [JSON.stringify(demoRules)],
        )
      ).rows[0];
      await tx.query("INSERT INTO policy_head(version_id) VALUES($1)", [p.id]);
      await audit(tx, "system", "policy.seeded", String(p.id));
    }
  });
}
