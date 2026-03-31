import { check } from 'k6';
import sql from 'k6/x/sql';
import driverMySQL from 'k6/x/sql/driver/mysql';

export const options = {
  vus: 1,
  iterations: 5,
};

const DB_NAME = 'k6_perf_test';
const TABLE_NAME = 'items';

const MYSQL_ADMIN_DSN = __ENV.MYSQL_ADMIN_DSN || 'root:root@tcp(mysql:3306)/';
const MYSQL_TEST_DSN = __ENV.MYSQL_TEST_DSN || `root:root@tcp(mysql:3306)/${DB_NAME}`;
let mysqlVUConnection;

function openMySQLForVU() {
  if (!mysqlVUConnection) {
    mysqlVUConnection = sql.open(driverMySQL, MYSQL_TEST_DSN);
  }
  return mysqlVUConnection;
}

export function setup() {
  const admin = sql.open(driverMySQL, MYSQL_ADMIN_DSN);
  admin.exec(`DROP DATABASE IF EXISTS ${DB_NAME};`);
  admin.exec(`CREATE DATABASE ${DB_NAME};`);
  admin.close();

  const db = sql.open(driverMySQL, MYSQL_TEST_DSN);
  db.exec(
    `CREATE TABLE ${TABLE_NAME} (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(64) NOT NULL,
      amount INT NOT NULL
    );`
  );
  db.exec(`INSERT INTO ${TABLE_NAME} (name, amount) VALUES ('row-a', 10), ('row-b', 20);`);
  db.close();
}

export default function () {
  const mysql = openMySQLForVU();
  const mysqlRows = mysql.query(`SELECT id, name, amount FROM ${TABLE_NAME} ORDER BY id LIMIT 2;`);
  check(mysqlRows, { 'mysql: returned rows': (rows) => rows.length >= 2 });
}

export function teardown() {
  const db = sql.open(driverMySQL, MYSQL_TEST_DSN);
  db.exec(`DELETE FROM ${TABLE_NAME};`);
  db.exec(`DROP TABLE ${TABLE_NAME};`);
  db.close();

  const admin = sql.open(driverMySQL, MYSQL_ADMIN_DSN);
  admin.exec(`DROP DATABASE IF EXISTS ${DB_NAME};`);
  admin.close();
}
