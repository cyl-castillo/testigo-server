import "dotenv/config";
export function config() {
  const port = Number(process.env.PORT ?? 4310);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("Invalid PORT");
  const databaseUrl = process.env.DATABASE_URL;
  const sessionSecret = process.env.SESSION_SECRET;
  if (!databaseUrl || !sessionSecret || sessionSecret.length < 32)
    throw new Error("Run npm run setup or configure .env first");
  const origin = process.env.APP_ORIGIN ?? `http://127.0.0.1:${port}`;
  const secure = process.env.COOKIE_SECURE === "true";
  const url = new URL(origin);
  if (
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) &&
    (url.protocol !== "https:" || !secure)
  )
    throw new Error("Remote origins require HTTPS and secure cookies");
  return {
    port,
    databaseUrl,
    sessionSecret,
    origin,
    secure,
    trustProxy: process.env.TRUST_PROXY === "true",
    host: process.env.HOST ?? "127.0.0.1",
  };
}
