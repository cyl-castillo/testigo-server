import { portable } from "./portable.js";
const { db } = await portable();
await db.start();
console.log(
  "Portable PostgreSQL listening on 127.0.0.1:55432. Ctrl+C stops it; data stays in .local/postgres.",
);
const keepAlive = setInterval(() => {}, 60000);
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => {
    clearInterval(keepAlive);
    void db.stop().then(() => process.exit(0));
  });
