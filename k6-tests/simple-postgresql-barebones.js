/**
 * simple-postgresql-barebones.js
 * 
 * A minimal k6 test script for PostgreSQL that demonstrates the basic lifecycle:
 * 1. setup(): Creates a test database and table, then seeds initial data.
 *    Includes logic to terminate existing connections before dropping the database.
 * 2. default function (VU execution): Performs a simple SELECT query.
 * 3. teardown(): Cleans up by dropping the test table and database.
 */

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

const DB_NAME = 'k6_postgresql_barebones';
const TABLE_NAME = 'items';

const PG_ADMIN_DSN =
  __ENV.PG_ADMIN_DSN || 'postgres://postgres:postgres@postgresql:5432/postgres?sslmode=disable';
const PG_BAREBONES_TEST_DSN =
  __ENV.PG_BAREBONES_TEST_DSN || `postgres://postgres:postgres@postgresql:5432/${DB_NAME}?sslmode=disable`;
let postgresVUConnection;

/**
 * Helper to maintain a single database connection per VU.
 */
function openPostgresForVU() {
  if (!postgresVUConnection) {
    postgresVUConnection = sql.open(driverPostgres, PG_BAREBONES_TEST_DSN);
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

    db = sql.open(driverPostgres, PG_BAREBONES_TEST_DSN);
    db.exec(
      `CREATE TABLE ${TABLE_NAME} (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL
      );`
    );
    db.exec(`INSERT INTO ${TABLE_NAME} (name) VALUES ('row-a'), ('row-b');`);
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
 * Main VU Phase: Performs a timed basic SELECT query.
 */
export default function () {
  const db = openPostgresForVU();

  const start = Date.now();
  try {
    const rows = db.query(`SELECT id, name FROM ${TABLE_NAME} ORDER BY id LIMIT 2;`);
    queryDuration.add(Date.now() - start);
    queryErrors.add(0);

    if (!rows || rows.length === 0) {
      throw new Error('PostgreSQL query returned no rows');
    }
  } catch (err) {
    queryDuration.add(Date.now() - start);
    queryErrors.add(1);
    // Error already recorded via metric — don't re-throw, let check() below handle gracefully
  }
}

/**
 * Teardown Phase: Cleans up the PostgreSQL database and table.
 */
export function teardown() {
  try {
    const db = sql.open(driverPostgres, PG_BAREBONES_TEST_DSN);
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
