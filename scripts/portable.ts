import EmbeddedPostgres from "embedded-postgres";
import { mkdir, readFile, writeFile, access } from "node:fs/promises";
import { resolve } from "node:path";
import { secret } from "../src/crypto.js";
export async function portable(directory = ".local/postgres", port = 55432) {
  const root = resolve(directory);
  await mkdir(root, { recursive: true });
  const credentials = resolve(root, "connection.json");
  let password: string;
  try {
    password = JSON.parse(await readFile(credentials, "utf8")).password;
  } catch {
    password = secret();
    await writeFile(credentials, JSON.stringify({ password }), {
      mode: 0o600,
      flag: "wx",
    });
  }
  const db = new EmbeddedPostgres({
    databaseDir: resolve(root, "data"),
    port,
    user: "testigo",
    password,
    authMethod: "scram-sha-256",
    persistent: true,
    createPostgresUser: false,
    postgresFlags: ["-h", "127.0.0.1"],
    initdbFlags: ["--encoding=UTF8"],
    onLog: () => {},
    onError: () => {},
  });
  try {
    await access(resolve(root, "data/PG_VERSION"));
  } catch {
    await db.initialise();
  }
  return {
    db,
    url: `postgresql://testigo:${password}@127.0.0.1:${port}/postgres`,
  };
}
