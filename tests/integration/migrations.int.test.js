// Every migration has a tested rollback: apply all, roll each back in
// reverse (checking the schema returns exactly to the previous state),
// then apply them all again.
const fs = require("fs");
const path = require("path");
const mysql = require("mysql2/promise");
const { migrationFiles } = require("../../scripts/db-setup");

const ROOT = path.join(__dirname, "..", "..");
const DB = `${process.env.DB_NAME}_migrations`;
let conn;

async function schema() {
  const [cols] = await conn.query(
    `SELECT table_name AS t, column_name AS c, column_type AS type, is_nullable AS n, column_default AS d
       FROM information_schema.columns WHERE table_schema = ? ORDER BY t, c`,
    [DB],
  );
  const [keys] = await conn.query(
    `SELECT DISTINCT table_name AS t, index_name AS i, non_unique AS u
       FROM information_schema.statistics WHERE table_schema = ? ORDER BY t, i`,
    [DB],
  );
  return JSON.stringify({ cols, keys });
}

const run = (file) => conn.query(fs.readFileSync(file, "utf8"));
const downFor = (file) => path.join(ROOT, "migrations", "rollback", path.basename(file).replace(/\.sql$/, ".down.sql"));

beforeAll(async () => {
  conn = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    multipleStatements: true,
  });
  await conn.query(`DROP DATABASE IF EXISTS \`${DB}\``);
  await conn.query(`CREATE DATABASE \`${DB}\``);
  await conn.query(`USE \`${DB}\``);
  await run(path.join(ROOT, "db", "schema.sql"));
});

afterAll(async () => {
  await conn.query(`DROP DATABASE IF EXISTS \`${DB}\``);
  await conn.end();
});

it("every migration has a rollback file", () => {
  for (const file of migrationFiles()) expect(fs.existsSync(downFor(file))).toBe(true);
});

it("up → down → up restores the exact schema at every step", async () => {
  const files = migrationFiles();
  const before = [await schema()];
  for (const file of files) {
    await run(file);
    before.push(await schema());
  }
  const fullyMigrated = before[before.length - 1];

  for (let i = files.length - 1; i >= 0; i -= 1) {
    await run(downFor(files[i]));
    expect(await schema()).toBe(before[i]);
  }

  for (const file of files) await run(file);
  expect(await schema()).toBe(fullyMigrated);
});

it("rolling back the repair lifecycle refuses while repair payments exist", async () => {
  await conn.query(
    "INSERT INTO payment_transactions (reference, user_id, email, purpose, amount_kobo) VALUES ('FXR_KEEP', 1, 'a@b.c', 'repair', 100)",
  );
  const files = migrationFiles();
  // Undo d and c first, then b must fail.
  await run(downFor(files[3]));
  await run(downFor(files[2]));
  await expect(run(downFor(files[1]))).rejects.toThrow();
  // Nothing else was touched.
  const [[t]] = await conn.query(
    "SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = ? AND table_name = 'shipment_events'",
    [DB],
  );
  expect(t.n).toBe(1);
});
