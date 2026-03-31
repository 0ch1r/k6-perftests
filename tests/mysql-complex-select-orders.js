import { check, sleep } from "k6";
import sql from "k6/x/sql";
import driverMySQL from "k6/x/sql/driver/mysql";

export const options = {
  stages: [
    { duration: "5s", target: 10 },
    { duration: "10s", target: 10 },
    { duration: "1m", target: 25 },
    { duration: "30s", target: 0 },
    { duration: "5s", target: 20 },
    { duration: "25s", target: 20 },
    { duration: "5s", target: 0 },
  ],
};

const MYSQL_DSN =
  __ENV.MYSQL_DSN ||
  __ENV.MYSQL_TEST_DSN ||
  "root:root@tcp(mysql:3306)/sysbench";
let vuConnection;

function openMySQLForVU() {
  if (!vuConnection) {
    vuConnection = sql.open(driverMySQL, MYSQL_DSN);
  }
  return vuConnection;
}

export default function () {
  const db = openMySQLForVU();

  const minPrice = 10 + (__VU % 25);
  const maxPrice = minPrice + 40;
  const customerFloor = 1 + ((__ITER * 37) % 50000);
  const customerCeiling = customerFloor + 5000;

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

  check(rows, {
    "mysql complex select returned rows": (result) => Array.isArray(result),
  });

  sleep(0.2);
}
