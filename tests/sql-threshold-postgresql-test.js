import { check } from 'k6';
import { Rate, Trend } from 'k6/metrics';
import sql from 'k6/x/sql';
import driverPostgres from 'k6/x/sql/driver/postgres';

const sqlLatency = new Trend('sql_query_latency', true);
const sqlErrors = new Rate('sql_query_errors');

export const options = {
  vus: 5,
  duration: '30s',
  thresholds: {
    sql_query_latency: ['p(95)<200', 'avg<100'],
    sql_query_errors: ['rate<0.01'],
    checks: ['rate>0.99'],
  },
};

const DB_NAME = 'k6_perf_threshold_test';
const TABLE_NAME = 'items';

const PG_ADMIN_DSN =
  __ENV.PG_ADMIN_DSN || 'postgres://postgres:postgres@postgresql:5432/postgres?sslmode=disable';
const PG_THRESHOLD_TEST_DSN =
  __ENV.PG_THRESHOLD_TEST_DSN || `postgres://postgres:postgres@postgresql:5432/${DB_NAME}?sslmode=disable`;
let postgresVUConnection;

function openPostgresForVU() {
  if (!postgresVUConnection) {
    postgresVUConnection = sql.open(driverPostgres, PG_THRESHOLD_TEST_DSN);
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

  const db = sql.open(driverPostgres, PG_THRESHOLD_TEST_DSN);
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

function timedSelect(db) {
  const start = Date.now();
  try {
    const rows = db.query(`SELECT id, name, amount FROM ${TABLE_NAME} ORDER BY id LIMIT 2;`);
    sqlLatency.add(Date.now() - start);
    sqlErrors.add(0);
    return rows;
  } catch (err) {
    sqlLatency.add(Date.now() - start);
    sqlErrors.add(1);
    throw err;
  }
}

export default function () {
  const postgres = openPostgresForVU();
  const pgRows = timedSelect(postgres);
  check(pgRows, { 'postgresql: returned rows': (rows) => rows.length >= 2 });
}

export function teardown() {
  const db = sql.open(driverPostgres, PG_THRESHOLD_TEST_DSN);
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
