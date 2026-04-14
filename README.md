# k6 SQL Performance Test Environment

This project provides a Docker Compose-based environment for SQL performance and load testing with `k6` + `xk6-sql`, `sysbench`, MySQL, and PostgreSQL.

## What this project includes

- `docker-compose.yml`: 4 services
  - `k6-sql` (custom k6 build with SQL extensions)
  - `sysbench` (on-demand sysbench runner)
  - `mysql`
  - `postgresql`
- `docker/k6-sql/Dockerfile`: builds `k6` with:
  - `github.com/grafana/xk6-sql`
  - `github.com/grafana/xk6-sql-driver-mysql`
  - `github.com/grafana/xk6-sql-driver-postgres`
- `tests/` folder (mounted into `k6-sql` as `/tests`)
  - `simple-mysql-barebones.js`
  - `simple-postgresql-barebones.js`
  - `simple-mysql-test.js`
  - `simple-postgresql-test.js`
  - `sql-threshold-mysql-test.js`
  - `sql-threshold-postgresql-test.js`
  - `oltp-read-write-like.js`
  - `mysql-complex-select-orders.js`
  - `multi-scenario-table-workload.js`

## Prerequisites

- Docker Desktop (or Docker Engine + Compose plugin)

## Build the k6 image

From the project root:

```bash
docker compose build k6-sql
```

## Start database containers

```bash
docker compose up -d mysql postgresql
```

## Run test scripts

The `tests/` directory is volume-mounted into the k6 container at `/tests`.

## Run sysbench on demand

The `sysbench` service is intended for explicit `docker compose run` usage, similar to `k6-sql`.

Example:

```bash
docker compose run --rm sysbench \
  --db-driver=mysql \
  --mysql-host=mysql \
  --mysql-user=root \
  --mysql-password=root \
  oltp_read_write prepare
```

### 1) Simple SQL test

MySQL:

```bash
docker compose run --rm k6-sql run /tests/simple-mysql-test.js
```

PostgreSQL:

```bash
docker compose run --rm k6-sql run /tests/simple-postgresql-test.js
```

### 2) Barebones connectivity tests

MySQL:

```bash
docker compose run --rm k6-sql run /tests/simple-mysql-barebones.js
```

PostgreSQL:

```bash
docker compose run --rm k6-sql run /tests/simple-postgresql-barebones.js
```

### 3) SQL thresholds test (latency + errors)

MySQL:

```bash
docker compose run --rm k6-sql run /tests/sql-threshold-mysql-test.js
```

PostgreSQL:

```bash
docker compose run --rm k6-sql run /tests/sql-threshold-postgresql-test.js
```

### 4) OLTP-style read/write test

MySQL (default):

```bash
docker compose run --rm k6-sql run /tests/oltp-read-write-like.js
```

PostgreSQL:

```bash
docker compose run --rm -e DB_ENGINE=postgresql k6-sql run /tests/oltp-read-write-like.js
```

With optional interval reporting every 10 seconds:

```bash
docker compose run --rm -e REPORT_INTERVAL_SEC=10 k6-sql run /tests/oltp-read-write-like.js
```

You can also tune load:

```bash
docker compose run --rm \
  -e VUS=20 \
  -e DURATION=2m \
  -e ROWS=5000 \
  k6-sql run /tests/oltp-read-write-like.js
```

You can tune the OLTP transaction mix:

```bash
docker compose run --rm \
  -e POINT_SELECTS_PER_TX=10 \
  -e RANGE_SELECTS_PER_TX=1 \
  -e SUM_SELECTS_PER_TX=1 \
  -e UPDATE_K_PER_TX=1 \
  -e UPDATE_C_PER_TX=1 \
  -e DELETE_INSERT_RATE=0.05 \
  -e RANGE_WIDTH=20 \
  k6-sql run /tests/oltp-read-write-like.js
```

You can tune setup batching for larger seed datasets:

```bash
docker compose run --rm \
  -e ROWS=20000 \
  -e SEED_BATCH_SIZE=1000 \
  k6-sql run /tests/oltp-read-write-like.js
```

### 5) MySQL complex SELECT test against `orders`

This test does not create or clean up schema. It expects the `orders` table from `sysbench/custom-oltp.lua` to already exist and contain data.

Run the staged k6 workload:

```bash
docker compose run --rm k6-sql run /tests/mysql-complex-select-orders.js
```

If you need to point the test at a different MySQL database, pass a DSN:

```bash
docker compose run --rm \
  -e MYSQL_DSN='root:root@tcp(mysql:3306)/sbtest' \
  k6-sql run /tests/mysql-complex-select-orders.js
```

Optional: prepare the `orders` table with sysbench if you have not created it yet:

```bash
docker compose run --rm sysbench \
  /tests/custom-oltp.lua \
  --db-driver=mysql \
  --mysql-host=mysql \
  --mysql-user=root \
  --mysql-password=root \
  --table_size=100000 \
  prepare
```

### 6) Multi-scenario staged workload across different tables

This test creates its own schema and runs three scenarios in parallel:

- `accounts_readers`: read-heavy lookups on `accounts`
- `orders_writers`: insert + recent-read traffic on `orders`
- `inventory_rebalancers`: transactional updates on `inventory`

Run against MySQL:

```bash
docker compose run --rm k6-sql run /tests/multi-scenario-table-workload.js
```

Run against PostgreSQL:

```bash
docker compose run --rm \
  -e DB_ENGINE=postgresql \
  k6-sql run /tests/multi-scenario-table-workload.js
```

You can tune the seeded table sizes:

```bash
docker compose run --rm \
  -e ACCOUNT_ROWS=5000 \
  -e INVENTORY_ROWS=1000 \
  -e ORDER_SEED_ROWS=3000 \
  -e SEED_BATCH_SIZE=500 \
  k6-sql run /tests/multi-scenario-table-workload.js
```

## Image and extension version pinning

The custom `k6` image is pinned to explicit versions in `docker/k6-sql/Dockerfile` so rebuilds are reproducible instead of following moving `latest` tags.

## One-command run (default compose command)

`docker-compose.yml` defaults `k6-sql` to:

```bash
docker compose up --build --abort-on-container-exit k6-sql
```

This runs `/tests/simple-mysql-test.js`.

## Stop and clean up

```bash
docker compose down -v
```
