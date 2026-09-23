import type pg from "pg";
import { transaction, audit } from "./db.js";
export async function retention(pool: pg.Pool, days: number, apply = false) {
  if (!Number.isInteger(days) || days < 1)
    throw new Error("RETENTION_DAYS must be a positive integer");
  return transaction(pool, async (tx) => {
    await tx.query("SELECT id FROM clients ORDER BY id FOR UPDATE");
    const candidates = (
      await tx.query(
        `SELECT s.id,(SELECT count(*) FROM events e WHERE e.session_id=s.id) events
   FROM sessions s WHERE s.status='completed' AND s.completed_at<now()-$1*interval '1 day'
   AND NOT EXISTS (SELECT 1 FROM execution_requests r WHERE r.session_id=s.id AND
    (r.state='pending' OR (r.state='approved' AND (r.claimed_at IS NULL OR NOT EXISTS (SELECT 1 FROM execution_reports e WHERE e.request_id=r.id)))))`,
        [days],
      )
    ).rows;
    if (apply)
      for (const s of candidates) {
        await audit(tx, "local-retention", "session.purged", s.id, {
          eventsRemoved: s.events,
          retentionDays: days,
          sourceDataDeleted: true,
          verification: "not verified",
        });
        await tx.query("DELETE FROM sessions WHERE id=$1", [s.id]);
      }
    return {
      mode: apply ? "apply" : "dry-run",
      retentionDays: days,
      sessions: candidates,
    };
  });
}
