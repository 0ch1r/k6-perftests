/**
 * oltp-read-write-like.js
 * 
 * A highly configurable performance test that simulates a standard OLTP (Online 
 * Transaction Processing) workload, similar to Sysbench.
 * 
 * Key Features:
 * - Dual Engine Support: Can target either MySQL or PostgreSQL via DB_ENGINE env var.
 * - Transactional Logic: Groups multiple SQL operations (SELECT, UPDATE, DELETE/INSERT) 
 *   into single ACID transactions.
 * - Dynamic Workload: Point selects, range selects, and updates are performed on 
 *   randomly chosen IDs to simulate varied access patterns.
 * - Periodic Reporting: VU 1 can optionally log progress to the console.
 */

import { check, sleep } from 'k6';
import exec from 'k6/execution';
import { Rate, Trend } from 'k6/metrics';
import sql from 'k6/x/sql';
import driverMySQL from 'k6/x/sql/driver/mysql';
import driverPostgres from 'k6/x/sql/driver/postgres';

// Custom metrics for OLTP transaction performance
const txLatency = new Trend('oltp_tx_latency', true);
const txErrors = new Rate('oltp_tx_errors');

// Test configuration: Defaults to 10 VUs for 1 minute
export const options = {
  vus: Number(__ENV.VUS || 10),
  duration: __ENV.DURATION || '1m',
  thresholds: {
    oltp_tx_latency: ['p(95)<300', 'avg<150'],
    oltp_tx_errors: ['rate<0.01'],
    checks: ['rate>0.99'],
  },
};

const DB_ENGINE = __ENV.DB_ENGINE || 'mysql'; // 'mysql' or 'postgres'
const DB_NAME = __ENV.DB_NAME || 'k6_perf_test';
const TABLE_NAME = 'sbtest1';
const ROWS = Number(__ENV.ROWS || 1000);
const REPORT_INTERVAL_SEC = Number(__ENV.REPORT_INTERVAL_SEC || 0);

// Transaction composition parameters
const RANGE_WIDTH = Number(__ENV.RANGE_WIDTH || 10);
const POINT_SELECTS_PER_TX = Number(__ENV.POINT_SELECTS_PER_TX || 1);
const RANGE_SELECTS_PER_TX = Number(__ENV.RANGE_SELECTS_PER_TX || 1);
const SUM_SELECTS_PER_TX = Number(__ENV.SUM_SELECTS_PER_TX || 1);
const UPDATE_K_PER_TX = Number(__ENV.UPDATE_K_PER_TX || 1);
const UPDATE_C_PER_TX = Number(__ENV.UPDATE_C_PER_TX || 1);
const DELETE_INSERT_RATE = Number(__ENV.DELETE_INSERT_RATE || 0);
const SEED_BATCH_SIZE = Number(__ENV.SEED_BATCH_SIZE || 500);

const MYSQL_ADMIN_DSN = __ENV.MYSQL_ADMIN_DSN || 'root:root@tcp(mysql:3306)/';
const MYSQL_TEST_DSN = __ENV.MYSQL_TEST_DSN || `root:root@tcp(mysql:3306)/${DB_NAME}`;
const PG_ADMIN_DSN =
  __ENV.PG_ADMIN_DSN || 'postgres://postgres:postgres@postgresql:5432/postgres?sslmode=disable';
const PG_TEST_DSN =
  __ENV.PG_TEST_DSN || `postgres://postgres:postgres@postgresql:5432/${DB_NAME}?sslmode=disable`;

let vuTestDBConnection;
let lastReportAt = 0;

/**
 * Utility to identify the current database engine.
 */
function isMySQL() {
  return DB_ENGINE === 'mysql';
}

function openAdminDB() {
  return isMySQL() ? sql.open(driverMySQL, MYSQL_ADMIN_DSN) : sql.open(driverPostgres, PG_ADMIN_DSN);
}

function openTestDB() {
  return isMySQL() ? sql.open(driverMySQL, MYSQL_TEST_DSN) : sql.open(driverPostgres, PG_TEST_DSN);
}

function openTestDBForVU() {
  if (!vuTestDBConnection) {
    vuTestDBConnection = openTestDB();
  }
  return vuTestDBConnection;
}

/**
 * Setup Phase: Prepares the test database and table, then seeds it with 
 * the requested number of rows.
 */
export function setup() {
  let admin = null;
  let db = null;
  
  try {
    admin = openAdminDB();

    if (!isMySQL()) {
      // PostgreSQL: Terminate other connections to allow DROP DATABASE
      admin.exec(
        `SELECT pg_terminate_backend(pid)
           FROM pg_stat_activity
          WHERE datname = '${DB_NAME}' AND pid <> pg_backend_pid();`
      );
    }
    admin.exec(`DROP DATABASE IF EXISTS ${DB_NAME};`);
    admin.exec(`CREATE DATABASE ${DB_NAME};`);
    admin.close();
    admin = null;

    db = openTestDB();
    setupSchemaAndData(db);
    db.close();
    db = null;

    return { rows: ROWS };
  } catch (err) {
    if (db) try { db.close(); } catch (_) {}
    if (admin) try { admin.close(); } catch (_) {}
    console.error(`Setup failed: ${err.message}`);
    throw err;
  }
}

/**
 * Main VU Phase: Executes a single OLTP transaction per iteration.
 */
export default function (data) {
  const db = openTestDBForVU();
  runOltpTransaction(db, data.rows);
  maybeReport();
  sleep(0.05);
}

/**
 * OLTP Transaction Logic:
 * Groups multiple operations into a single BEGIN/COMMIT block.
 * Simulates real-world database usage patterns.
 */
function runOltpTransaction(db, rows) {
  const id = 1 + Math.floor(Math.random() * rows);
  const low = Math.max(1, id - RANGE_WIDTH);
  const high = Math.min(rows, id + RANGE_WIDTH);
  const start = Date.now();

  try {
    db.exec('BEGIN;');

    let pointSelect;
    let rangeSelect;

    // 1. Point Selects
    for (let i = 0; i < POINT_SELECTS_PER_TX; i++) {
      pointSelect = db.query(`SELECT id, k, c, pad FROM ${TABLE_NAME} WHERE id = ${id};`);
    }

    // 2. Range Selects
    for (let i = 0; i < RANGE_SELECTS_PER_TX; i++) {
      rangeSelect = db.query(
        `SELECT id, k FROM ${TABLE_NAME} WHERE id BETWEEN ${low} AND ${high} ORDER BY id;`
      );
    }

    // 3. Aggregate Selects
    for (let i = 0; i < SUM_SELECTS_PER_TX; i++) {
      db.query(`SELECT SUM(k) AS total_k FROM ${TABLE_NAME} WHERE id BETWEEN ${low} AND ${high};`);
    }

    // 4. Updates
    for (let i = 0; i < UPDATE_K_PER_TX; i++) {
      db.exec(`UPDATE ${TABLE_NAME} SET k = k + 1 WHERE id = ${id};`);
    }

    for (let i = 0; i < UPDATE_C_PER_TX; i++) {
      db.exec(`UPDATE ${TABLE_NAME} SET c = 'c-${id}-${__VU}-${__ITER}-${i}' WHERE id = ${id};`);
    }

    // 5. Optional Delete/Insert
    if (DELETE_INSERT_RATE > 0 && Math.random() < DELETE_INSERT_RATE) {
      db.exec(`DELETE FROM ${TABLE_NAME} WHERE id = ${id};`);
      db.exec(
        `INSERT INTO ${TABLE_NAME} (id, k, c, pad)
         VALUES (${id}, ${id % 100}, 'c-${id}', 'pad-${id}');`
      );
    }

    db.exec('COMMIT;');

    // Performance Validation
    if (POINT_SELECTS_PER_TX > 0) {
      check(pointSelect, { 'oltp: point-select row exists': (result) => result.length === 1 });
    }
    if (RANGE_SELECTS_PER_TX > 0) {
      check(rangeSelect, { 'oltp: range-select returns rows': (result) => result.length >= 1 });
    }
    txErrors.add(0, { db: DB_ENGINE });
  } catch (err) {
    try {
      db.exec('ROLLBACK;');
    } catch (_) {}
    txErrors.add(1, { db: DB_ENGINE });
  } finally {
    txLatency.add(Date.now() - start, { db: DB_ENGINE });
  }
}

/**
 * Teardown Phase: Cleans up the test environment.
 */
export function teardown() {
  try {
    const admin = openAdminDB();

    if (!isMySQL()) {
      admin.exec(
        `SELECT pg_terminate_backend(pid)
           FROM pg_stat_activity
          WHERE datname = '${DB_NAME}' AND pid <> pg_backend_pid();`
      );
    }
    admin.exec(`DROP DATABASE IF EXISTS ${DB_NAME};`);
    admin.close();
  } catch (err) {
    console.warn(`Teardown cleanup failed: ${err.message}`);
  }
}

/**
 * Internal helper to create the schema and seed data.
 */
function setupSchemaAndData(db) {
  db.exec(
    `CREATE TABLE ${TABLE_NAME} (
      id INT PRIMARY KEY,
      k INT NOT NULL,
      c VARCHAR(120) NOT NULL,
      pad VARCHAR(60) NOT NULL
    );`
  );
  db.exec(`CREATE INDEX idx_k ON ${TABLE_NAME}(k);`);

  for (let start = 1; start <= ROWS; start += SEED_BATCH_SIZE) {
    const end = Math.min(start + SEED_BATCH_SIZE - 1, ROWS);
    const values = [];

    for (let i = start; i <= end; i++) {
      values.push(`(${i}, ${i % 100}, 'c-${i}', 'pad-${i}')`);
    }

    db.exec(
      `INSERT INTO ${TABLE_NAME} (id, k, c, pad)
       VALUES ${values.join(', ')};`
    );
  }
}

/**
 * Optional periodic reporting logic (enabled via REPORT_INTERVAL_SEC).
 */
function maybeReport() {
  if (REPORT_INTERVAL_SEC <= 0 || __VU !== 1) {
    return;
  }

  const now = Date.now();
  if (lastReportAt === 0) {
    lastReportAt = now;
    return;
  }

  if ((now - lastReportAt) / 1000 >= REPORT_INTERVAL_SEC) {
    const elapsedSec = exec.instance.currentTestRunDuration / 1000;
    const iterations = exec.instance.iterationsCompleted;
    const approxTps = iterations / Math.max(elapsedSec, 1);
    console.log(
      `[interval-report] elapsed=${elapsedSec.toFixed(1)}s iterations=${iterations} approx_tps=${approxTps.toFixed(2)}`
    );
    lastReportAt = now;
  }
}
