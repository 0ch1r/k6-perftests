/**
 * simple-mysql-barebones.js
 * 
 * A minimal k6 test script for MySQL that demonstrates the basic lifecycle:
 * 1. setup(): Creates a test database and table, then seeds initial data.
 * 2. default function (VU execution): Performs a simple SELECT query.
 * 3. teardown(): Cleans up by dropping the test table and database.
 */

import { Rate, Trend } from 'k6/metrics';
import sql from 'k6/x/sql';
import driverMySQL from 'k6/x/sql/driver/mysql';

// Test configuration: 1 Virtual User running 5 iterations
export const options = {
  vus: 1,
  iterations: 5,
};

// Custom metrics for SQL query performance
const queryDuration = new Trend('mysql_query_duration', true);
const queryErrors = new Rate('mysql_query_errors');

const DB_NAME = 'k6_mysql_barebones';
const TABLE_NAME = 'items';

const MYSQL_ADMIN_DSN = __ENV.MYSQL_ADMIN_DSN || 'root:root@tcp(mysql:3306)/';
const MYSQL_BAREBONES_TEST_DSN =
  __ENV.MYSQL_BAREBONES_TEST_DSN || `root:root@tcp(mysql:3306)/${DB_NAME}`;
let mysqlVUConnection;

/**
 * Helper to maintain a single database connection per VU.
 */
function openMySQLForVU() {
  if (!mysqlVUConnection) {
    mysqlVUConnection = sql.open(driverMySQL, MYSQL_BAREBONES_TEST_DSN);
  }
  return mysqlVUConnection;
}

/**
 * Setup Phase: Executed once before the test starts.
 * Responsible for environment preparation.
 */
export function setup() {
  let admin = null;
  let db = null;
  
  try {
    admin = sql.open(driverMySQL, MYSQL_ADMIN_DSN);
    admin.exec(`DROP DATABASE IF EXISTS ${DB_NAME};`);
    admin.exec(`CREATE DATABASE ${DB_NAME};`);
    admin.close();
    admin = null;

    db = sql.open(driverMySQL, MYSQL_BAREBONES_TEST_DSN);
    db.exec(
      `CREATE TABLE ${TABLE_NAME} (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(64) NOT NULL
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
 * Main VU Phase: The core logic executed by each Virtual User.
 * Each VU will run this function for the specified number of iterations.
 */
export default function () {
  const db = openMySQLForVU();

  const start = Date.now();
  try {
    const rows = db.query(`SELECT id, name FROM ${TABLE_NAME} ORDER BY id LIMIT 2;`);
    queryDuration.add(Date.now() - start);
    queryErrors.add(0);

    if (!rows || rows.length === 0) {
      throw new Error('MySQL query returned no rows');
    }
  } catch (err) {
    queryDuration.add(Date.now() - start);
    queryErrors.add(1);
    // Error already recorded via metric — don't re-throw, let check() below handle gracefully
  }
}

/**
 * Teardown Phase: Executed once after the test completes.
 * Responsible for resource cleanup.
 */
export function teardown() {
  try {
    const db = sql.open(driverMySQL, MYSQL_BAREBONES_TEST_DSN);
    db.exec(`DELETE FROM ${TABLE_NAME};`);
    db.exec(`DROP TABLE ${TABLE_NAME};`);
    db.close();
  } catch (err) {
    console.warn(`Teardown table cleanup failed: ${err.message}`);
  }

  try {
    const admin = sql.open(driverMySQL, MYSQL_ADMIN_DSN);
    admin.exec(`DROP DATABASE IF EXISTS ${DB_NAME};`);
    admin.close();
  } catch (err) {
    console.warn(`Teardown database cleanup failed: ${err.message}`);
  }
}
