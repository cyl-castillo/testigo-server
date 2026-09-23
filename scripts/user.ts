import { parseArgs } from "node:util";
import { randomUUID } from "node:crypto";
import { config } from "../src/config.js";
import { createPool, migrate, transaction, audit } from "../src/db.js";
import { passwordHash, secret } from "../src/crypto.js";
import { z } from "zod";
const { values } = parseArgs({
  options: { email: { type: "string" }, role: { type: "string" } },
});
const data = z
  .object({
    email: z.string().email().max(200),
    role: z.enum(["admin", "reviewer"]),
  })
  .parse(values);
const password = process.env.BOOTSTRAP_PASSWORD ?? secret();
if (password.length < 14 || password.length > 256)
  throw new Error("Password must have 14–256 characters");
const pool = createPool(config().databaseUrl);
try {
  await migrate(pool);
  await transaction(pool, async (tx) => {
    const userId = randomUUID();
    await tx.query(
      "INSERT INTO users(id,email,password_hash,role) VALUES($1,$2,$3,$4)",
      [
        userId,
        data.email.toLowerCase(),
        await passwordHash(password),
        data.role,
      ],
    );
    await audit(tx, "local-bootstrap", "user.created", userId, {
      email: data.email,
      role: data.role,
    });
  });
  console.log(`Created ${data.role}: ${data.email}`);
  if (!process.env.BOOTSTRAP_PASSWORD)
    console.log(`Generated password (shown once): ${password}`);
} finally {
  await pool.end();
}
