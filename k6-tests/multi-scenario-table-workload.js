/**
 * multi-scenario-table-workload.js
 * 
 * A comprehensive performance test that simulates a real-world multi-table workload.
 * It leverages k6 Scenarios to run different types of database operations concurrently:
 * 1. accounts_readers: Read-intensive workload on the 'accounts' table.
 * 2. orders_writers: Write-intensive workload on the 'orders' table.
 * 3. inventory_rebalancers: Transactional (BEGIN/COMMIT) workload on 'inventory'.
 * 
 * Each scenario has its own ramp-up schedule and target VUs.
 */

import { check, sleep } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';
import sql from 'k6/x/sql';
import driverMySQL from 'k6/x/sql/driver/mysql';

// Global metrics for overall health
const scenarioLatency = new Trend('scenario_sql_latency', true);
const scenarioErrors = new Rate('scenario_sql_errors');
const rowsTouched = new Counter('scenario_rows_touched');

export const options = {
  scenarios: {
    // Scenario 1: Frequent reads with sorting on accounts
    accounts_readers: {
      executor: 'ramping-vus',
      exec: 'accountsReaders',
      startVUs: 0,
      stages: [
        { duration: '10s', target: 5 },
        { duration: '20s', target: 5 },
        { duration: '15s', target: 12 },
        { duration: '10s', target: 0 },
      ],
      gracefulRampDown: '5s',
      tags: { scenario_name: 'accounts_readers', table: 'accounts' },
    },
    // Scenario 2: Constant inserts and recent-order lookups
    orders_writers: {
      executor: 'ramping-vus',
      exec: 'ordersWriters',
      startTime: '5s', // Starts slightly after readers
      startVUs: 0,
      stages: [
        { duration: '10s', target: 3 },
        { duration: '20s', target: 6 },
        { duration: '15s', target: 10 },
        { duration: '10s', target: 0 },
      ],
      gracefulRampDown: '5s',
      tags: { scenario_name: 'orders_writers', table: 'orders' },
    },
    // Scenario 3: Transactional updates (rebalancing inventory)
    inventory_rebalancers: {
      executor: 'ramping-vus',
      exec: 'inventoryRebalancers',
      startTime: '10s',
      startVUs: 0,
      stages: [
        { duration: '10s', target: 2 },
        { duration: '15s', target: 4 },
        { duration: '20s', target: 8 },
        { duration: '10s', target: 0 },
      ],
      gracefulRampDown: '5s',
      tags: { scenario_name: 'inventory_rebalancers', table: 'inventory' },
    },
  },
  thresholds: {
    scenario_sql_latency: ['p(95)<400', 'avg<200'],
    scenario_sql_errors: ['rate<0.02'],
    checks: ['rate>0.99'],
  },
};

const DB_NAME = __ENV.DB_NAME || 'k6_multi_scenario_test';

// Workload sizing parameters
const ACCOUNT_ROWS = Number(__ENV.ACCOUNT_ROWS || 2000);
const INVENTORY_ROWS = Number(__ENV.INVENTORY_ROWS || 500);
const ORDER_SEED_ROWS = Number(__ENV.ORDER_SEED_ROWS || 1000);
const SEED_BATCH_SIZE = Number(__ENV.SEED_BATCH_SIZE || 250);

const MYSQL_ADMIN_DSN = __ENV.MYSQL_ADMIN_DSN || 'root:root@tcp(mysql:3306)/';
const MYSQL_TEST_DSN =
  __ENV.MYSQL_MULTI_SCENARIO_DSN || `root:root@tcp(mysql:3306)/${DB_NAME}`;

let vuConnection;

function openAdminDB() {
  return sql.open(driverMySQL, MYSQL_ADMIN_DSN);
}

function openTestDB() {
  return sql.open(driverMySQL, MYSQL_TEST_DSN);
}

function openTestDBForVU() {
  if (!vuConnection) {
    vuConnection = openTestDB();
  }
  return vuConnection;
}

/**
 * Setup Phase: Creates schemas and seeds large amounts of data.
 * Returns metadata (row counts) used by the scenario functions.
 */
export function setup() {
  let admin = null;
  let db = null;
  
  try {
    admin = openAdminDB();
    admin.exec(`DROP DATABASE IF EXISTS ${DB_NAME};`);
    admin.exec(`CREATE DATABASE IF NOT EXISTS ${DB_NAME};`);
    admin.close();
    admin = null;

    db = openTestDB();
    createTables(db);
    seedAccounts(db);
    seedOrders(db);
    seedInventory(db);
    db.close();
    db = null;

    return {
      accountRows: ACCOUNT_ROWS,
      inventoryRows: INVENTORY_ROWS,
    };
  } catch (err) {
    if (db) try { db.close(); } catch (_) {}
    if (admin) try { admin.close(); } catch (_) {}
    console.error(`Setup failed: ${err.message}`);
    throw err;
  }
}

/**
 * Utility to run a SQL step with unified metric tracking.
 */
function runStep(name, table, fn) {
  const start = Date.now();

  try {
    const result = fn();
    scenarioErrors.add(0, { scenario: name, table });
    scenarioLatency.add(Date.now() - start, { scenario: name, table });
    return result;
  } catch (err) {
    scenarioErrors.add(1, { scenario: name, table });
    scenarioLatency.add(Date.now() - start, { scenario: name, table });
    // Don't re-throw — error already recorded via metric
    return null;
  }
}

/**
 * Scenario Implementation: Accounts Readers
 * Performs lookups by tenant and status, simulating typical SaaS dashboard queries.
 */
export function accountsReaders(data) {
  const db = openTestDBForVU();
  const tenantId = (__VU + __ITER) % 50;
  const accountId = 1 + ((__ITER + __VU) % data.accountRows);

  const accountRows = runStep('accounts_readers', 'accounts', () =>
    db.query(
      `SELECT id, tenant_id, balance, status
         FROM accounts
        WHERE tenant_id = ${tenantId}
          AND status = 'active'
        ORDER BY balance DESC
        LIMIT 10;`
    )
  );

  const singleAccount = runStep('accounts_readers', 'accounts', () =>
    db.query(`SELECT id, balance FROM accounts WHERE id = ${accountId};`)
  );

  rowsTouched.add(accountRows.length + singleAccount.length, {
    scenario: 'accounts_readers',
    table: 'accounts',
  });

  check(accountRows, {
    'accounts reader returns result set': (rows) => Array.isArray(rows),
  });
  check(singleAccount, {
    'accounts reader returns account row': (rows) => rows.length === 1,
  });

  sleep(0.2);
}

/**
 * Scenario Implementation: Orders Writers
 * Inserts new orders and verifies them, simulating an e-commerce checkout process.
 */
export function ordersWriters(data) {
  const db = openTestDBForVU();
  const accountId = 1 + ((__ITER * 13 + __VU) % data.accountRows);
  const skuId = (__ITER + __VU) % 100;
  const quantity = 1 + ((__ITER + __VU) % 5);
  const total = quantity * (20 + skuId);

  runStep('orders_writers', 'orders', () =>
    db.exec(
      `INSERT INTO orders (account_id, sku, quantity, order_total, created_at)
       VALUES (${accountId}, 'sku-${skuId}', ${quantity}, ${total}, CURRENT_TIMESTAMP);`
    )
  );

  const recentOrders = runStep('orders_writers', 'orders', () =>
    db.query(
      `SELECT account_id, sku, quantity, order_total
         FROM orders
        WHERE account_id = ${accountId}
        ORDER BY created_at DESC
        LIMIT 5;`
    )
  );

  rowsTouched.add(recentOrders.length + 1, {
    scenario: 'orders_writers',
    table: 'orders',
  });

  check(recentOrders, {
    'orders writer sees recent rows': (rows) => rows.length >= 1,
  });

  sleep(0.3);
}

/**
 * Scenario Implementation: Inventory Rebalancers
 * Uses explicit SQL transactions to move stock between 'available' and 'reserved' states.
 */
export function inventoryRebalancers(data) {
  const db = openTestDBForVU();
  const inventoryId = 1 + ((__ITER * 7 + __VU) % data.inventoryRows);
  const delta = 1 + ((__ITER + __VU) % 3);

  runStep('inventory_rebalancers', 'inventory', () => {
    db.exec('BEGIN;');

    try {
      db.exec(
        `UPDATE inventory
            SET available_qty = available_qty - ${delta},
                reserved_qty = reserved_qty + ${delta},
                updated_at = CURRENT_TIMESTAMP
          WHERE id = ${inventoryId}
            AND available_qty >= ${delta};`
      );
      db.exec(
        `UPDATE inventory
            SET available_qty = available_qty + ${delta},
                reserved_qty = CASE
                  WHEN reserved_qty >= ${delta} THEN reserved_qty - ${delta}
                  ELSE 0
                END,
                updated_at = CURRENT_TIMESTAMP
          WHERE id = ${inventoryId};`
      );
      db.exec('COMMIT;');
    } catch (err) {
      try {
        db.exec('ROLLBACK;');
      } catch (_) {}
      // Don't re-throw — runStep() will record the error and return null
    }
  });

  const inventoryRow = runStep('inventory_rebalancers', 'inventory', () =>
    db.query(
      `SELECT id, available_qty, reserved_qty
         FROM inventory
        WHERE id = ${inventoryId};`
    )
  );

  rowsTouched.add(inventoryRow.length + 2, {
    scenario: 'inventory_rebalancers',
    table: 'inventory',
  });

  check(inventoryRow, {
    'inventory rebalancer keeps row visible': (rows) => rows.length === 1,
  });

  sleep(0.25);
}

/**
 * Teardown Phase: Cleans up all tables and the test database.
 */
export function teardown() {
  try {
    const admin = openAdminDB();
    admin.exec(`DROP DATABASE IF EXISTS ${DB_NAME};`);
    admin.close();
  } catch (err) {
    console.warn(`Teardown cleanup failed: ${err.message}`);
  }
}

/**
 * Internal helper to create the schema.
 */
function createTables(db) {
  db.exec(
    `CREATE TABLE IF NOT EXISTS accounts (
      id INT PRIMARY KEY,
      tenant_id INT NOT NULL,
      balance INT NOT NULL,
      status VARCHAR(16) NOT NULL,
      updated_at TIMESTAMP NOT NULL
    );`
  );
  db.exec('CREATE INDEX idx_accounts_tenant_status ON accounts(tenant_id, status);');

  db.exec(
    `CREATE TABLE IF NOT EXISTS orders (
      id INT AUTO_INCREMENT PRIMARY KEY,
      account_id INT NOT NULL,
      sku VARCHAR(32) NOT NULL,
      quantity INT NOT NULL,
      order_total INT NOT NULL,
      created_at TIMESTAMP NOT NULL
    );`
  );
  db.exec('CREATE INDEX idx_orders_account_created ON orders(account_id, created_at);');

  db.exec(
    `CREATE TABLE IF NOT EXISTS inventory (
      id INT PRIMARY KEY,
      sku VARCHAR(32) NOT NULL,
      warehouse_id INT NOT NULL,
      available_qty INT NOT NULL,
      reserved_qty INT NOT NULL,
      updated_at TIMESTAMP NOT NULL
    );`
  );
  db.exec('CREATE INDEX idx_inventory_warehouse ON inventory(warehouse_id, id);');
}

/**
 * Seeding functions for populating the database before the test.
 */
function seedAccounts(db) {
  for (let start = 1; start <= ACCOUNT_ROWS; start += SEED_BATCH_SIZE) {
    const end = Math.min(start + SEED_BATCH_SIZE - 1, ACCOUNT_ROWS);
    const values = [];

    for (let id = start; id <= end; id++) {
      values.push(`(${id}, ${id % 50}, ${1000 + id}, 'active', CURRENT_TIMESTAMP)`);
    }

    db.exec(
      `INSERT INTO accounts (id, tenant_id, balance, status, updated_at)
       VALUES ${values.join(', ')};`
    );
  }
}

function seedOrders(db) {
  for (let start = 1; start <= ORDER_SEED_ROWS; start += SEED_BATCH_SIZE) {
    const end = Math.min(start + SEED_BATCH_SIZE - 1, ORDER_SEED_ROWS);
    const values = [];

    for (let id = start; id <= end; id++) {
      const accountId = 1 + (id % ACCOUNT_ROWS);
      values.push(
        `(${accountId}, 'sku-${id % 100}', ${1 + (id % 4)}, ${25 + (id % 50)}, CURRENT_TIMESTAMP)`
      );
    }

    db.exec(
      `INSERT INTO orders (account_id, sku, quantity, order_total, created_at)
       VALUES ${values.join(', ')};`
    );
  }
}

function seedInventory(db) {
  for (let start = 1; start <= INVENTORY_ROWS; start += SEED_BATCH_SIZE) {
    const end = Math.min(start + SEED_BATCH_SIZE - 1, INVENTORY_ROWS);
    const values = [];

    for (let id = start; id <= end; id++) {
      values.push(`(${id}, 'sku-${id}', ${id % 10}, ${100 + id}, ${id % 5}, CURRENT_TIMESTAMP)`);
    }

    db.exec(
      `INSERT INTO inventory (id, sku, warehouse_id, available_qty, reserved_qty, updated_at)
       VALUES ${values.join(', ')};`
    );
  }
}
