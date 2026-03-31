import { check } from 'k6';
import sql from 'k6/x/sql';
import driverPostgres from 'k6/x/sql/driver/postgres';

export const options = {
  vus: 1,
  iterations: 5,
};

const DB_NAME = 'k6_perf_test';
const TABLE_NAME = 'items';

const PG_ADMIN_DSN =
  __ENV.PG_ADMIN_DSN || 'postgres://postgres:postgres@postgresql:5432/postgres?sslmode=disable';
const PG_TEST_DSN =
  __ENV.PG_TEST_DSN || `postgres://postgres:postgres@postgresql:5432/${DB_NAME}?sslmode=disable`;
let postgresVUConnection;

function openPostgresForVU() {
  if (!postgresVUConnection) {
    postgresVUConnection = sql.open(driverPostgres, PG_TEST_DSN);
  }
  return postgresVUConnection;
}

export function setup() {
  const admin = sql.open(driverPostgres, PG_ADMIN_DSN);
  admin.exec(
    `SELECT pg_terminate_backend(pid)
      FROM pg_stat_activity
      WHERE datname = '${DB_NAME}' AND pid <> pg_backend_pid();`
  );
  admin.exec(`DROP DATABASE IF EXISTS ${DB_NAME};`);
  admin.exec(`CREATE DATABASE ${DB_NAME};`);
  admin.close();

  const db = sql.open(driverPostgres, PG_TEST_DSN);
  db.exec(
    `CREATE TABLE ${TABLE_NAME} (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      amount INT NOT NULL
    );`
  );
  db.exec(`INSERT INTO ${TABLE_NAME} (name, amount) VALUES ('row-a', 10), ('row-b', 20);`);
  db.close();
}

export default function () {
  const postgres = openPostgresForVU();
  const pgRows = postgres.query(`SELECT id, name, amount FROM ${TABLE_NAME} ORDER BY id LIMIT 2;`);
  check(pgRows, { 'postgresql: returned rows': (rows) => rows.length >= 2 });
}

export function teardown() {
  const db = sql.open(driverPostgres, PG_TEST_DSN);
  db.exec(`DELETE FROM ${TABLE_NAME};`);
  db.exec(`DROP TABLE ${TABLE_NAME};`);
  db.close();

  const admin = sql.open(driverPostgres, PG_ADMIN_DSN);
  admin.exec(
    `SELECT pg_terminate_backend(pid)
      FROM pg_stat_activity
      WHERE datname = '${DB_NAME}' AND pid <> pg_backend_pid();`
  );
  admin.exec(`DROP DATABASE IF EXISTS ${DB_NAME};`);
  admin.close();
}
