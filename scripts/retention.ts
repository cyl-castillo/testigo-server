import { config } from "../src/config.js";
import { createPool } from "../src/db.js";
import { retention } from "../src/retention.js";
const pool = createPool(config().databaseUrl);
try {
  console.log(
    JSON.stringify(
      await retention(
        pool,
        Number(process.env.RETENTION_DAYS ?? 30),
        process.argv.includes("--apply"),
      ),
      null,
      2,
    ),
  );
} finally {
  await pool.end();
}
