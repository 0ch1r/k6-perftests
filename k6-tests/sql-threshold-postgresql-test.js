/**
 * sql-threshold-postgresql-test.js
 * 
 * An advanced k6 test for PostgreSQL that demonstrates performance benchmarking with thresholds.
 * It tracks custom metrics like query latency and error rates, and defines SLAs
 * (Service Level Agreements) that must be met for the test to pass.
 */

import { check } from 'k6';
import { Rate, Trend } from 'k6/metrics';
import sql from 'k6/x/sql';
import driverPostgres from 'k6/x/sql/driver/postgres';

// Custom metrics to track specific SQL performance aspects
const sqlLatency = new Trend('sql_query_latency', true); // Tracks latency distribution (p95, avg, etc.)
const sqlErrors = new Rate('sql_query_errors');           // Tracks the percentage of failed queries

// Test configuration: 5 VUs for 30 seconds
export const options = {
  vus: 5,
  duration: '30s',
  // Performance thresholds: Test will fail if these criteria are not met
  thresholds: {
    sql_query_latency: ['p(95)<200', 'avg<100'], // 95% of queries must be under 200ms
    sql_query_errors: ['rate<0.01'],             // Error rate must be less than 1%
    checks: ['rate>0.99'],                       // Functional checks must pass 99% of the time
  },
};

const DB_NAME = 'k6_perf_threshold_test';
const TABLE_NAME = 'items';

const PG_ADMIN_DSN =
  __ENV.PG_ADMIN_DSN || 'postgres://postgres:postgres@postgresql:5432/postgres?sslmode=disable';
const PG_THRESHOLD_TEST_DSN =
  __ENV.PG_THRESHOLD_TEST_DSN || `postgres://postgres:postgres@postgresql:5432/${DB_NAME}?sslmode=disable`;
let postgresVUConnection;

/**
 * Helper to maintain a single database connection per VU.
 */
function openPostgresForVU() {
  if (!postgresVUConnection) {
    postgresVUConnection = sql.open(driverPostgres, PG_THRESHOLD_TEST_DSN);
  }
  return postgresVUConnection;
}

/**
 * Setup Phase: Prepares the PostgreSQL environment.
 * Note: PostgreSQL requires terminating active connections to a database before it can be dropped.
 */
export function setup() {
  let admin = null;
  let db = null;
  
  try {
    admin = sql.open(driverPostgres, PG_ADMIN_DSN);
    admin.exec(
      `SELECT pg_terminate_backend(pid)
        FROM pg_stat_activity
        WHERE datname = '${DB_NAME}' AND pid <> pg_backend_pid();`
    );
    admin.exec(`DROP DATABASE IF EXISTS ${DB_NAME};`);
    admin.exec(`CREATE DATABASE ${DB_NAME};`);
    admin.close();
    admin = null;

    db = sql.open(driverPostgres, PG_THRESHOLD_TEST_DSN);
    db.exec(
      `CREATE TABLE ${TABLE_NAME} (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        amount INT NOT NULL
      );`
    );
    db.exec(`INSERT INTO ${TABLE_NAME} (name, amount) VALUES ('row-a', 10), ('row-b', 20);`);
    db.close();
    db = null;
  } catch (err) {
    if (db) try { db.close(); } catch (_) {}
    if (admin) try { admin.close(); } catch (_) {}
    console.error(`Setup failed: ${err.message}`);
    throw err;
  }
}

/**
 * Wrapper function to execute a SQL query and record performance metrics.
 */
function timedSelect(db) {
  const start = Date.now();
  try {
    const rows = db.query(`SELECT id, name, amount FROM ${TABLE_NAME} ORDER BY id LIMIT 2;`);
    sqlLatency.add(Date.now() - start); // Record success latency
    sqlErrors.add(0);                   // Record success
    return rows;
  } catch (err) {
    sqlLatency.add(Date.now() - start); // Record failure latency
    sqlErrors.add(1);                   // Record failure
    return null; // Don't re-throw, let caller handle null gracefully
  }
}

/**
 * Main VU Phase: Executes the timed query and performs validation.
 */
export default function () {
  const postgres = openPostgresForVU();
  const pgRows = timedSelect(postgres);
  check(pgRows, { 'postgresql: returned rows': (rows) => rows && rows.length >= 2 });
}

/**
 * Teardown Phase: Cleans up the test database.
 */
export function teardown() {
  try {
    const db = sql.open(driverPostgres, PG_THRESHOLD_TEST_DSN);
    db.exec(`DELETE FROM ${TABLE_NAME};`);
    db.exec(`DROP TABLE ${TABLE_NAME};`);
    db.close();
  } catch (err) {
    console.warn(`Teardown table cleanup failed: ${err.message}`);
  }

  try {
    const admin = sql.open(driverPostgres, PG_ADMIN_DSN);
    admin.exec(
      `SELECT pg_terminate_backend(pid)
        FROM pg_stat_activity
        WHERE datname = '${DB_NAME}' AND pid <> pg_backend_pid();`
    );
    admin.exec(`DROP DATABASE IF EXISTS ${DB_NAME};`);
    admin.close();
  } catch (err) {
    console.warn(`Teardown database cleanup failed: ${err.message}`);
  }
}
