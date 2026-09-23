import { buildApp } from "./app.js";
import { createPool, migrate } from "./db.js";
import { config } from "./config.js";
const c = config();
const pool = createPool(c.databaseUrl);
await migrate(pool);
const app = await buildApp(pool, c);
const server = app.listen(c.port, c.host, () =>
  console.log(`Testigo simulation POC: ${c.origin}`),
);
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () =>
    server.close(() => {
      void pool.end().then(() => process.exit(0));
    }),
  );
