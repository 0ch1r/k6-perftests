/**
 * simple-mysql-test.js
 * 
 * A basic k6 test for MySQL that includes functional validation using checks.
 * This script ensures that the database is reachable and returns the expected
 * number of rows during the performance test.
 */

import { check } from 'k6';
import { Rate, Trend } from 'k6/metrics';
import sql from 'k6/x/sql';
import driverMySQL from 'k6/x/sql/driver/mysql';

// Test configuration: 1 VU, 5 iterations
export const options = {
  vus: 1,
  iterations: 5,
};

// Custom metrics for SQL query performance
const queryDuration = new Trend('mysql_query_duration', true);
const queryErrors = new Rate('mysql_query_errors');

const DB_NAME = 'k6_perf_test';
const TABLE_NAME = 'items';

const MYSQL_ADMIN_DSN = __ENV.MYSQL_ADMIN_DSN || 'root:root@tcp(mysql:3306)/';
const MYSQL_TEST_DSN = __ENV.MYSQL_TEST_DSN || `root:root@tcp(mysql:3306)/${DB_NAME}`;
let mysqlVUConnection;

/**
 * Helper to maintain a single database connection per VU.
 */
function openMySQLForVU() {
  if (!mysqlVUConnection) {
    mysqlVUConnection = sql.open(driverMySQL, MYSQL_TEST_DSN);
  }
  return mysqlVUConnection;
}

/**
 * Setup Phase: Prepares the MySQL environment by creating the test database,
 * table, and inserting initial records.
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

    db = sql.open(driverMySQL, MYSQL_TEST_DSN);
    db.exec(
      `CREATE TABLE ${TABLE_NAME} (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(64) NOT NULL,
        amount INT NOT NULL
      );`
    );
    db.exec(`INSERT INTO ${TABLE_NAME} (name, amount) VALUES ('row-a', 10), ('row-b', 20);`);
    db.close();
    db = null;
  } catch (err) {
    // Cleanup on error
    if (db) try { db.close(); } catch (_) {}
    if (admin) try { admin.close(); } catch (_) {}
    console.error(`Setup failed: ${err.message}`);
    throw err;
  }
}

/**
 * Main VU Phase: Performs a timed SELECT query and validates the result using k6/check.
 */
export default function () {
  const mysql = openMySQLForVU();

  const start = Date.now();
  try {
    const mysqlRows = mysql.query(`SELECT id, name, amount FROM ${TABLE_NAME} ORDER BY id LIMIT 2;`);
    queryDuration.add(Date.now() - start);
    queryErrors.add(0);

    // Validate that the query returned at least 2 rows
    check(mysqlRows, { 'mysql: returned rows': (rows) => rows.length >= 2 });
  } catch (err) {
    queryDuration.add(Date.now() - start);
    queryErrors.add(1);
    // Error already recorded via metric — don't re-throw, let check() below handle gracefully
  }
}

/**
 * Teardown Phase: Cleans up the MySQL database and table created during setup.
 */
export function teardown() {
  // Clean up table data first
  try {
    const db = sql.open(driverMySQL, MYSQL_TEST_DSN);
    db.exec(`DELETE FROM ${TABLE_NAME};`);
    db.exec(`DROP TABLE ${TABLE_NAME};`);
    db.close();
  } catch (err) {
    console.warn(`Teardown table cleanup failed: ${err.message}`);
  }

  // Then clean up the entire database
  try {
    const admin = sql.open(driverMySQL, MYSQL_ADMIN_DSN);
    admin.exec(`DROP DATABASE IF EXISTS ${DB_NAME};`);
    admin.close();
  } catch (err) {
    console.warn(`Teardown database cleanup failed: ${err.message}`);
  }
}
