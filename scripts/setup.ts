import { mkdir, readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { portable } from "./portable.js";
import { createPool, migrate, transaction, audit } from "../src/db.js";
import { secret, hash, passwordHash } from "../src/crypto.js";
await mkdir(".local", { recursive: true });
try {
  await readFile(".env");
  console.log(
    "A .env already exists. Setup leaves existing credentials intact. Use npm run db / npm start.",
  );
  process.exit(0);
} catch {
  /* first run */
}
const { db, url } = await portable();
await db.start();
const pool = createPool(url);
try {
  await migrate(pool);
  const email = "admin@demo.local",
    password = secret(),
    token = secret(),
    clientId = randomUUID();
  await transaction(pool, async (tx) => {
    await tx.query(
      "INSERT INTO users(id,email,password_hash,role) VALUES($1,$2,$3,'admin')",
      [randomUUID(), email, await passwordHash(password)],
    );
    await tx.query("INSERT INTO clients(id,name,token_hash) VALUES($1,$2,$3)", [
      clientId,
      "Synthetic workstation",
      hash(token),
    ]);
    await audit(tx, "local-bootstrap", "demo.provisioned", clientId, { email });
  });
  await writeFile(".local/client-token", token, { mode: 0o600, flag: "wx" });
  await writeFile(
    ".local/access.txt",
    `Local synthetic demo credentials — generated on this machine\nURL: http://127.0.0.1:4310\nEmail: ${email}\nPassword: ${password}\n\nDelete this file after saving the password in your password manager.\n`,
    { mode: 0o600, flag: "wx" },
  );
  await writeFile(
    ".env",
    `DATABASE_URL=${url}\nSESSION_SECRET=${secret()}\nPORT=4310\nHOST=127.0.0.1\nAPP_ORIGIN=http://127.0.0.1:4310\nCOOKIE_SECURE=false\nRETENTION_DAYS=30\n`,
    { mode: 0o600, flag: "wx" },
  );
  console.log(
    "Demo provisioned. Generated sign-in credentials: .local/access.txt (local ignored file).\nStart PostgreSQL with npm run db, then npm start in another terminal.\nRun npm run simulate to submit synthetic sessions.",
  );
} finally {
  await pool.end();
  await db.stop();
}
