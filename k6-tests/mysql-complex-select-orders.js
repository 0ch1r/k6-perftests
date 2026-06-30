/**
 * mysql-complex-select-orders.js
 * 
 * A performance test for MySQL that simulates a complex analytical workload.
 * It uses the 'stages' executor to ramp up and down Virtual Users, and executes
 * a heavy SQL query involving aggregates, subqueries (EXISTS), and sorting.
 */

import { check, sleep } from "k6";
import { Rate, Trend } from 'k6/metrics';
import sql from "k6/x/sql";
import driverMySQL from "k6/x/sql/driver/mysql";

// Custom metrics for SQL query performance
const queryDuration = new Trend('mysql_complex_query_duration', true);
const queryErrors = new Rate('mysql_complex_query_errors');

// Test configuration: Ramps VUs through various stages to simulate peak and off-peak load
export const options = {
  stages: [
    { duration: "5s", target: 10 },   // Ramp up to 10 VUs
    { duration: "10s", target: 10 },  // Stay at 10 VUs
    { duration: "1m", target: 25 },   // Ramp up to 25 VUs (Peak)
    { duration: "30s", target: 0 },   // Ramp down
    { duration: "5s", target: 20 },   // Sudden spike
    { duration: "25s", target: 20 },  // Sustain spike
    { duration: "5s", target: 0 },    // Final ramp down
  ],
};

const MYSQL_DSN =
  __ENV.MYSQL_DSN ||
  __ENV.MYSQL_TEST_DSN ||
  "root:root@tcp(mysql:3306)/sysbench";
let vuConnection;

/**
 * Helper to maintain a single database connection per VU.
 */
function openMySQLForVU() {
  if (!vuConnection) {
    vuConnection = sql.open(driverMySQL, MYSQL_DSN);
  }
  return vuConnection;
}

/**
 * Main VU Phase: Executes a timed complex analytical SELECT query.
 * The query calculates revenue per customer for specific price ranges and
 * verifies if the customer has made specific types of recent orders.
 */
export default function () {
  const db = openMySQLForVU();

  // Parameterize queries to avoid identical cache hits
  const minPrice = 10 + (__VU % 25);
  const maxPrice = minPrice + 40;
  const customerFloor = 1 + ((__ITER * 37) % 50000);
  const customerCeiling = customerFloor + 5000;

  const start = Date.now();
  try {
    const rows = db.query(
      `SELECT
         o.customer_id,
         COUNT(*) AS order_count,
         SUM(o.quantity) AS total_quantity,
         ROUND(SUM(o.quantity * o.price), 2) AS total_revenue,
         ROUND(AVG(o.price), 2) AS avg_price,
         MIN(o.created_at) AS first_order_at,
         MAX(o.created_at) AS last_order_at
       FROM orders o
       WHERE o.price BETWEEN ${minPrice} AND ${maxPrice}
         AND o.customer_id BETWEEN ${customerFloor} AND ${customerCeiling}
         AND EXISTS (
           SELECT 1
           FROM orders recent
           WHERE recent.customer_id = o.customer_id
             AND recent.product_id = o.product_id
             AND recent.quantity >= 2
         )
       GROUP BY o.customer_id
       HAVING COUNT(*) >= 1
       ORDER BY total_revenue DESC, order_count DESC
       LIMIT 20;`,
    );

    queryDuration.add(Date.now() - start);
    queryErrors.add(0);

    // Validate that the result set is non-empty
    check(rows, {
      "mysql complex select returned rows": (result) => result.length > 0,
    });
  } catch (err) {
    queryDuration.add(Date.now() - start);
    queryErrors.add(1);
    // Error already recorded via metric — don't re-throw, let check() below handle gracefully
  }

  // Pacing: Wait before the next iteration
  sleep(0.2);
}