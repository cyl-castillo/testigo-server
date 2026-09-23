import { config } from "../src/config.js";
import { createPool, migrate } from "../src/db.js";
const pool = createPool(config().databaseUrl);
try {
  await migrate(pool);
  console.log("Migrations applied.");
} finally {
  await pool.end();
}
