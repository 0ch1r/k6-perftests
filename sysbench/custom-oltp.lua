-- custom-oltp.lua
--
-- A custom Sysbench script that:
-- 1. Creates a custom table schema
-- 2. Implements OLTP-style read/write operations
-- 3. Supports prepare / run / cleanup phases

local table_name = "orders"
local thread_con = nil

sysbench.cmdline.options = {
	table_size = { "Number of rows to pre-create during prepare", 100000 },
}

-- Generate a random row for inserts
local function random_row()
	return {
		customer_id = sysbench.rand.default(1, 100000),
		product_id = sysbench.rand.default(1, 50000),
		quantity = sysbench.rand.default(1, 10),
		price = sysbench.rand.default(100, 10000) / 100.0,
	}
end

-- Called during `sysbench --script=custom-oltp.lua prepare`
function prepare()
	local drv = sysbench.sql.driver()
	local con = drv:connect()
	local table_size = sysbench.opt.table_size

	print("Creating custom table `" .. table_name .. "`")

	con:query("DROP TABLE IF EXISTS " .. table_name)

	con:query([[
    CREATE TABLE ]] .. table_name .. [[ (
      id BIGINT PRIMARY KEY AUTO_INCREMENT,
      customer_id BIGINT NOT NULL,
      product_id BIGINT NOT NULL,
      quantity INT NOT NULL,
      price DECIMAL(10,2) NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_customer (customer_id),
	      INDEX idx_product (product_id)
	    )
	  ]])

	print("Loading " .. table_size .. " rows into `" .. table_name .. "`")

	for _ = 1, table_size do
		local row = random_row()
		con:query(
			string.format(
				"INSERT INTO %s (customer_id, product_id, quantity, price) VALUES (%d, %d, %d, %.2f)",
				table_name,
				row.customer_id,
				row.product_id,
				row.quantity,
				row.price
			)
		)
	end

	con:disconnect()
end

-- Called during `sysbench --script=custom-oltp.lua cleanup`
function cleanup()
	local drv = sysbench.sql.driver()
	local con = drv:connect()

	print("Dropping table `" .. table_name .. "`")
	con:query("DROP TABLE IF EXISTS " .. table_name)

	con:disconnect()
end

function thread_init()
	local drv = sysbench.sql.driver()
	thread_con = drv:connect()
end

function thread_done()
	if thread_con then
		thread_con:disconnect()
		thread_con = nil
	end
end

-- OLTP read/write event
function event()
	-- 70% reads, 30% writes
	local r = sysbench.rand.uniform(1, 100)

	if r <= 70 then
		-- READ: random lookup
		local id = sysbench.rand.default(1, 100000)
		thread_con:query("SELECT * FROM " .. table_name .. " WHERE id=" .. id)
	else
		-- WRITE: insert a new row
		local row = random_row()
		thread_con:query(
			string.format(
				"INSERT INTO %s (customer_id, product_id, quantity, price) VALUES (%d, %d, %d, %.2f)",
				table_name,
				row.customer_id,
				row.product_id,
				row.quantity,
				row.price
			)
		)
	end
end
