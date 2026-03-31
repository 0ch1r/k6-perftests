import { check, sleep } from 'k6';
import exec from 'k6/execution';
import { Rate, Trend } from 'k6/metrics';
import sql from 'k6/x/sql';
import driverMySQL from 'k6/x/sql/driver/mysql';
import driverPostgres from 'k6/x/sql/driver/postgres';

const txLatency = new Trend('oltp_tx_latency', true);
const txErrors = new Rate('oltp_tx_errors');

export const options = {
  vus: Number(__ENV.VUS || 10),
  duration: __ENV.DURATION || '1m',
  thresholds: {
    oltp_tx_latency: ['p(95)<300', 'avg<150'],
    oltp_tx_errors: ['rate<0.01'],
    checks: ['rate>0.99'],
  },
};

const DB_ENGINE = __ENV.DB_ENGINE || 'mysql';
const DB_NAME = __ENV.DB_NAME || 'k6_perf_test';
const TABLE_NAME = 'sbtest1';
const ROWS = Number(__ENV.ROWS || 1000);
const REPORT_INTERVAL_SEC = Number(__ENV.REPORT_INTERVAL_SEC || 0);
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

export function setup() {
  const admin = openAdminDB();

  if (!isMySQL()) {
    admin.exec(
      `SELECT pg_terminate_backend(pid)
         FROM pg_stat_activity
        WHERE datname = '${DB_NAME}' AND pid <> pg_backend_pid();`
    );
  }
  admin.exec(`DROP DATABASE IF EXISTS ${DB_NAME};`);
  admin.exec(`CREATE DATABASE ${DB_NAME};`);
  admin.close();

  const db = openTestDB();
  setupSchemaAndData(db);
  db.close();

  return { rows: ROWS };
}

function runOltpTransaction(db, rows) {
  const id = 1 + Math.floor(Math.random() * rows);
  const low = Math.max(1, id - RANGE_WIDTH);
  const high = Math.min(rows, id + RANGE_WIDTH);
  const start = Date.now();

  try {
    db.exec('BEGIN;');

    let pointSelect;
    let rangeSelect;

    for (let i = 0; i < POINT_SELECTS_PER_TX; i++) {
      pointSelect = db.query(`SELECT id, k, c, pad FROM ${TABLE_NAME} WHERE id = ${id};`);
    }

    for (let i = 0; i < RANGE_SELECTS_PER_TX; i++) {
      rangeSelect = db.query(
        `SELECT id, k FROM ${TABLE_NAME} WHERE id BETWEEN ${low} AND ${high} ORDER BY id;`
      );
    }

    for (let i = 0; i < SUM_SELECTS_PER_TX; i++) {
      db.query(`SELECT SUM(k) AS total_k FROM ${TABLE_NAME} WHERE id BETWEEN ${low} AND ${high};`);
    }

    for (let i = 0; i < UPDATE_K_PER_TX; i++) {
      db.exec(`UPDATE ${TABLE_NAME} SET k = k + 1 WHERE id = ${id};`);
    }

    for (let i = 0; i < UPDATE_C_PER_TX; i++) {
      db.exec(`UPDATE ${TABLE_NAME} SET c = 'c-${id}-${__VU}-${__ITER}-${i}' WHERE id = ${id};`);
    }

    if (DELETE_INSERT_RATE > 0 && Math.random() < DELETE_INSERT_RATE) {
      db.exec(`DELETE FROM ${TABLE_NAME} WHERE id = ${id};`);
      db.exec(
        `INSERT INTO ${TABLE_NAME} (id, k, c, pad)
         VALUES (${id}, ${id % 100}, 'c-${id}', 'pad-${id}');`
      );
    }

    db.exec('COMMIT;');

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

export default function (data) {
  const db = openTestDBForVU();
  runOltpTransaction(db, data.rows);
  maybeReport();
  sleep(0.05);
}

export function teardown() {
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
}
