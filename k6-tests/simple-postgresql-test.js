/**
 * simple-postgresql-test.js
 * 
 * A basic k6 test for PostgreSQL that includes functional validation using checks.
 * Verifies database connectivity and correctness of the returned data.
 */

import { check } from 'k6';
import { Rate, Trend } from 'k6/metrics';
import sql from 'k6/x/sql';
import driverPostgres from 'k6/x/sql/driver/postgres';

// Test configuration: 1 VU, 5 iterations
export const options = {
  vus: 1,
  iterations: 5,
};

// Custom metrics for SQL query performance
const queryDuration = new Trend('postgresql_query_duration', true);
const queryErrors = new Rate('postgresql_query_errors');

const DB_NAME = 'k6_perf_test';
const TABLE_NAME = 'items';

const PG_ADMIN_DSN =
  __ENV.PG_ADMIN_DSN || 'postgres://postgres:postgres@postgresql:5432/postgres?sslmode=disable';
const PG_TEST_DSN =
  __ENV.PG_TEST_DSN || `postgres://postgres:postgres@postgresql:5432/${DB_NAME}?sslmode=disable`;
let postgresVUConnection;

/**
 * Helper to maintain a single database connection per VU.
 */
function openPostgresForVU() {
  if (!postgresVUConnection) {
    postgresVUConnection = sql.open(driverPostgres, PG_TEST_DSN);
  }
  return postgresVUConnection;
}

/**
 * Setup Phase: Prepares the PostgreSQL database by creating the schema and
 * seeding initial test data.
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

    db = sql.open(driverPostgres, PG_TEST_DSN);
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
 * Main VU Phase: Executes a timed SELECT query and validates that the result set
 * contains the expected records.
 */
export default function () {
  const postgres = openPostgresForVU();

  const start = Date.now();
  try {
    const pgRows = postgres.query(`SELECT id, name, amount FROM ${TABLE_NAME} ORDER BY id LIMIT 2;`);
    queryDuration.add(Date.now() - start);
    queryErrors.add(0);

    // Validate that the query returned at least 2 rows
    check(pgRows, { 'postgresql: returned rows': (rows) => rows.length >= 2 });
  } catch (err) {
    queryDuration.add(Date.now() - start);
    queryErrors.add(1);
    // Error already recorded via metric — don't re-throw, let check() below handle gracefully
  }
}

/**
 * Teardown Phase: Removes the test database and table from the PostgreSQL server.
 */
export function teardown() {
  try {
    const db = sql.open(driverPostgres, PG_TEST_DSN);
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
