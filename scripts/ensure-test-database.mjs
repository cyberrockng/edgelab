import pg from "pg";

const defaultAdminUrl = "postgres://edgelab:edgelab@localhost:55432/postgres";
const defaultTestUrl = "postgres://edgelab:edgelab@localhost:55432/edgelab_test";
const testUrl = new URL(process.env.TEST_DATABASE_URL ?? defaultTestUrl);
const databaseName = decodeURIComponent(testUrl.pathname.slice(1));

if (!/^[a-zA-Z0-9_]+$/.test(databaseName) || databaseName === "edgelab") {
  throw new Error("TEST_DATABASE_URL must name a dedicated non-application database");
}

const client = new pg.Client({ connectionString: process.env.TEST_DATABASE_ADMIN_URL ?? defaultAdminUrl });
await client.connect();
try {
  const existing = await client.query("SELECT 1 FROM pg_database WHERE datname = $1", [databaseName]);
  if (existing.rowCount === 0) {
    await client.query(`CREATE DATABASE "${databaseName}"`);
    console.log(`Created isolated test database ${databaseName}`);
  }
} finally {
  await client.end();
}
