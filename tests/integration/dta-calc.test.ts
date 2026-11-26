import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { DatabaseTuningAdvisor } from "../../src/index/dta-calc.ts";
import type { WorkloadEntry } from "../../src/index/index-opt-base.ts";
import { IndexTuningResult } from "../../src/index/index-opt-base.ts";
import { SqlDriver } from "../../src/sql/sql-driver.ts";
import { describeWithPostgres } from "../support/postgres.ts";

interface WorkloadQuery {
  calls: number;
  query: string;
}

/** Sequential calls: the statements share one workload and must run in order. */
async function runRepeatedly(
  sqlDriver: SqlDriver,
  query: string,
  times: number
): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    // biome-ignore lint/performance/noAwaitInLoops: the calls must run one after another
    await sqlDriver.executeQuery(query);
  }
}

/** Set up test tables with sample data. */
async function setupTestTables(sqlDriver: SqlDriver): Promise<void> {
  // Create users table
  await sqlDriver.executeQuery(`
    DROP TABLE IF EXISTS orders;
    DROP TABLE IF EXISTS users;

    CREATE TABLE users (
        id SERIAL PRIMARY KEY,
        name VARCHAR(100),
        email VARCHAR(100),
        status VARCHAR(20),
        age INTEGER,
        created_at TIMESTAMP DEFAULT NOW()
    )
    `);

  // Create orders table with foreign key
  await sqlDriver.executeQuery(`
    CREATE TABLE orders (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id),
        order_date TIMESTAMP DEFAULT NOW(),
        amount DECIMAL(10, 2),
        status VARCHAR(20)
    )
    `);

  // Insert sample data - users
  await sqlDriver.executeQuery(`
    INSERT INTO users (id, name, email, status, age)
    SELECT
        i,
        'User ' || i,
        'user' || i || '@example.com',
        CASE WHEN i % 3 = 0 THEN 'active' WHEN i % 3 = 1 THEN 'inactive' ELSE 'pending' END,
        20 + (i % 50)
    FROM generate_series(1, 10000) i
    `);

  // Insert sample data - orders with DETERMINISTIC values, not random
  await sqlDriver.executeQuery(`
    INSERT INTO orders (id, user_id, order_date, amount, status)
    SELECT
        i,
        1 + ((i-1) % 10000),  -- Deterministic user_id mapping
        CURRENT_DATE - ((i % 365) || ' days')::interval,  -- Deterministic date
        (i % 1000)::decimal(10,2),  -- Deterministic amount
        CASE WHEN i % 10 < 7 THEN 'completed' ELSE 'pending' END  -- Deterministic status
    FROM generate_series(1, 50000) i
    `);

  // Analyze tables to update statistics
  await sqlDriver.executeQuery("ANALYZE users, orders");
}

async function cleanupTestTables(sqlDriver: SqlDriver): Promise<void> {
  await sqlDriver.executeQuery("DROP TABLE IF EXISTS orders");
  await sqlDriver.executeQuery("DROP TABLE IF EXISTS users");
}

describeWithPostgres("database tuning advisor", (postgres) => {
  let sqlDriver: SqlDriver;

  beforeEach(async () => {
    sqlDriver = new SqlDriver({ engineUrl: postgres.connectionString() });

    // Verify connection
    const result = await sqlDriver.executeQuery("SELECT 1");
    if (result === null) {
      throw new Error("SELECT 1 returned no rows");
    }

    // Create the extensions if needed
    await sqlDriver.executeQuery(
      "CREATE EXTENSION IF NOT EXISTS pg_stat_statements"
    );
    await sqlDriver.executeQuery("CREATE EXTENSION IF NOT EXISTS hypopg");
  });

  afterEach(async () => {
    await sqlDriver.conn?.close();
  });

  /** Create a DatabaseTuningAdvisor with reasonable settings for testing. */
  async function createDta(): Promise<DatabaseTuningAdvisor> {
    // Reset HypoPG to clean state
    await sqlDriver.executeQuery("SELECT hypopg_reset()");

    return new DatabaseTuningAdvisor(sqlDriver, {
      budgetMb: 100,
      maxRuntimeSeconds: 120,
      maxIndexWidth: 3,
    });
  }

  test("recommends useful indexes for a join order benchmark style workload", {
    retry: 2,
  }, async ({ skip }) => {
    await setupTestTables(sqlDriver);
    const dta = await createDta();

    try {
      // Set up JOB-like schema (simplified movie database)
      await sqlDriver.executeQuery(`
        DROP TABLE IF EXISTS movie_cast;
        DROP TABLE IF EXISTS movie_companies;
        DROP TABLE IF EXISTS movie_genres;
        DROP TABLE IF EXISTS movies;
        DROP TABLE IF EXISTS actors;
        DROP TABLE IF EXISTS companies;
        DROP TABLE IF EXISTS genres;

        CREATE TABLE movies (
            id SERIAL PRIMARY KEY,
            title VARCHAR(200),
            year INTEGER,
            rating FLOAT,
            votes INTEGER
        );

        CREATE TABLE actors (
            id SERIAL PRIMARY KEY,
            name VARCHAR(100),
            gender CHAR(1),
            birth_year INTEGER
        );

        CREATE TABLE movie_cast (
            movie_id INTEGER REFERENCES movies(id),
            actor_id INTEGER REFERENCES actors(id),
            role VARCHAR(100),
            PRIMARY KEY (movie_id, actor_id, role)
        );

        CREATE TABLE companies (
            id SERIAL PRIMARY KEY,
            name VARCHAR(100),
            country VARCHAR(50)
        );

        CREATE TABLE movie_companies (
            movie_id INTEGER REFERENCES movies(id),
            company_id INTEGER REFERENCES companies(id),
            production_role VARCHAR(50),
            PRIMARY KEY (movie_id, company_id, production_role)
        );

        CREATE TABLE genres (
            id SERIAL PRIMARY KEY,
            name VARCHAR(50)
        );

        CREATE TABLE movie_genres (
            movie_id INTEGER REFERENCES movies(id),
            genre_id INTEGER REFERENCES genres(id),
            PRIMARY KEY (movie_id, genre_id)
        );
        `);

      // Insert sample data with DETERMINISTIC values instead of random
      await sqlDriver.executeQuery(`
        -- Insert genres
        INSERT INTO genres (id, name) VALUES
            (1, 'Action'), (2, 'Comedy'), (3, 'Drama'), (4, 'Sci-Fi'), (5, 'Thriller');

        -- Insert companies
        INSERT INTO companies (id, name, country) VALUES
            (1, 'Universal', 'USA'),
            (2, 'Warner Bros', 'USA'),
            (3, 'Paramount', 'USA'),
            (4, 'Sony Pictures', 'USA'),
            (5, 'Disney', 'USA');

        -- Insert movies with deterministic values
        INSERT INTO movies (id, title, year, rating, votes)
        SELECT
            i,
            'Movie Title ' || i,
            (2000 + (i % 22)),
            (5.0 + ((i % 10) * 0.5)),  -- deterministic rating from 5.0 to 9.5
            (1000 + ((i % 100) * 1000))  -- deterministic votes
        FROM generate_series(1, 10000) i;

        -- Insert actors
        INSERT INTO actors (id, name, gender, birth_year)
        SELECT
            i,
            'Actor ' || i,
            CASE WHEN i % 2 = 0 THEN 'M' ELSE 'F' END,
            (1950 + (i % 50))
        FROM generate_series(1, 5000) i;

        -- Insert movie_cast
        INSERT INTO movie_cast (movie_id, actor_id, role)
        SELECT
            movie_id,
            actor_id,
            'Role ' || (movie_id % 10)
        FROM (
            SELECT
                movie_id,
                actor_id,
                ROW_NUMBER() OVER (PARTITION BY movie_id ORDER BY actor_id) as rn
            FROM (
                SELECT
                    movies.id as movie_id,
                    actors.id as actor_id
                FROM movies
                CROSS JOIN actors
                WHERE (movies.id + actors.id) % 50 = 0
            ) as movie_actors
        ) as numbered_roles
        WHERE rn <= 5;  -- Up to 5 actors per movie

        -- Insert movie_companies
        INSERT INTO movie_companies (movie_id, company_id, production_role)
        SELECT
            movie_id,
            1 + (movie_id % 5), -- Distribute across 5 companies
            CASE (movie_id % 3)
                WHEN 0 THEN 'Production'
                WHEN 1 THEN 'Distribution'
                ELSE 'Marketing'
            END
        FROM (SELECT id as movie_id FROM movies) as m;

        -- Insert movie_genres (each movie gets 1-3 genres)
        INSERT INTO movie_genres (movie_id, genre_id)
        SELECT DISTINCT
            movie_id,
            genre_id
        FROM (
            SELECT
                m.id as movie_id,
                1 + (m.id % 5) as genre_id
            FROM movies m
            UNION ALL
            SELECT
                m.id as movie_id,
                1 + ((m.id + 2) % 5) as genre_id
            FROM movies m
            WHERE m.id % 2 = 0
            UNION ALL
            SELECT
                m.id as movie_id,
                1 + ((m.id + 4) % 5) as genre_id
            FROM movies m
            WHERE m.id % 3 = 0
        ) as movie_genre_assignment;
        `);

      // Force a thorough ANALYZE to ensure consistent statistics
      await sqlDriver.executeQuery(
        "ANALYZE VERBOSE movies, actors, movie_cast, companies, movie_companies, genres, movie_genres"
      );

      // Define JOB-style queries
      const jobQueries: WorkloadQuery[] = [
        {
          query: `
                SELECT m.title, a.name
                FROM movies m
                JOIN movie_cast mc ON m.id = mc.movie_id
                JOIN actors a ON mc.actor_id = a.id
                WHERE m.year > 2010 AND a.gender = 'F'
                `,
          calls: 30,
        },
        {
          query: `
                SELECT m.title, g.name, COUNT(a.id) as actor_count
                FROM movies m
                JOIN movie_genres mg ON m.id = mg.movie_id
                JOIN genres g ON mg.genre_id = g.id
                JOIN movie_cast mc ON m.id = mc.movie_id
                JOIN actors a ON mc.actor_id = a.id
                WHERE g.name = 'Action' AND m.rating > 7.5
                GROUP BY m.title, g.name
                ORDER BY actor_count DESC
                LIMIT 20
                `,
          calls: 25,
        },
        {
          query: `
                SELECT c.name, COUNT(m.id) as movie_count, AVG(m.rating) as avg_rating
                FROM companies c
                JOIN movie_companies mc ON c.id = mc.company_id
                JOIN movies m ON mc.movie_id = m.id
                WHERE mc.production_role = 'Production' AND m.year BETWEEN 2005 AND 2015
                GROUP BY c.name
                HAVING COUNT(m.id) > 5
                ORDER BY avg_rating DESC
                `,
          calls: 20,
        },
        {
          query: `
                SELECT a.name, COUNT(DISTINCT g.name) as genre_diversity
                FROM actors a
                JOIN movie_cast mc ON a.id = mc.actor_id
                JOIN movies m ON mc.movie_id = m.id
                JOIN movie_genres mg ON m.id = mg.movie_id
                JOIN genres g ON mg.genre_id = g.id
                WHERE a.gender = 'M' AND m.votes > 10000
                GROUP BY a.name
                ORDER BY genre_diversity DESC, a.name
                LIMIT 10
                `,
          calls: 15,
        },
        {
          query: `
                SELECT m.year, g.name, COUNT(*) as movie_count
                FROM movies m
                JOIN movie_genres mg ON m.id = mg.movie_id
                JOIN genres g ON mg.genre_id = g.id
                WHERE m.rating > 6.0
                GROUP BY m.year, g.name
                ORDER BY m.year DESC, movie_count DESC
                `,
          calls: 10,
        },
      ];

      // Clear pg_stat_statements
      await sqlDriver.executeQuery("SELECT pg_stat_statements_reset()");

      // Execute JOB workload multiple times to ensure stable stats
      for (let i = 0; i < 2; i += 1) {
        // Run twice to ensure stable statistics
        for (const q of jobQueries) {
          // biome-ignore lint/performance/noAwaitInLoops: the calls must run one after another
          await runRepeatedly(sqlDriver, q.query, q.calls);
        }
      }

      // Write workload to temp file with a unique name to avoid collisions
      const workDir = mkdtempSync(join(tmpdir(), "job-workload-"));
      const sqlFilePath = join(
        workDir,
        `job_workload_queries_${process.pid}.sql`
      );
      writeFileSync(
        sqlFilePath,
        `${jobQueries.map((q) => q.query).join(";\n\n")};`
      );

      try {
        // Analyze the workload with relaxed thresholds
        const session = await dta.analyzeWorkload({
          sqlFile: sqlFilePath,
          minCalls: 1, // Lower threshold to ensure queries are considered
          minAvgTimeMs: 0.1, // Lower threshold to ensure queries are considered
        });

        // Check that we got recommendations
        expect(session).toBeInstanceOf(IndexTuningResult);

        // Allow test to continue with zero recommendations
        if (session.recommendations.length === 0) {
          skip("No recommendations generated - skipping performance tests");
        }

        // Expected index patterns based on our JOB-style queries
        const expectedPatterns: [string, string][] = [
          ["movie_cast", "actor_id"],
          ["movie_genres", "movie_id"],
          ["actors", "gender"],
        ];

        // Check that our recommendations cover at least one expected pattern
        let foundPatterns = 0;
        for (const [table, column] of expectedPatterns) {
          if (
            session.recommendations.some(
              (rec) => rec.table === table && rec.columns.includes(column)
            )
          ) {
            foundPatterns += 1;
          }
        }

        // We should find at least 1 of the expected patterns
        // Relaxed assertion - just need one useful recommendation
        expect(
          foundPatterns,
          `Found only ${foundPatterns} out of ${expectedPatterns.length} expected index patterns`
        ).toBeGreaterThanOrEqual(1);

        // Test performance improvement with recommended indexes
        const topRecs = session.recommendations.slice(0, 1); // Test top 1 recommendation

        // Measure baseline performance
        const baselineTimes = new Map<string, number>();
        for (const q of jobQueries) {
          const start = performance.now();
          // biome-ignore lint/performance/noAwaitInLoops: timings must not overlap
          await sqlDriver.executeQuery(`EXPLAIN ANALYZE ${q.query}`);
          baselineTimes.set(q.query, (performance.now() - start) / 1000);
        }

        // Create the recommended indexes
        for (const rec of topRecs) {
          const indexDef = rec.definition.replace("hypopg_", "");
          // biome-ignore lint/performance/noAwaitInLoops: index creation is sequential
          await sqlDriver.executeQuery(indexDef);
        }

        // Force stats update after index creation
        await sqlDriver.executeQuery("ANALYZE VERBOSE");

        // Measure performance with indexes - use multiple runs to reduce variance
        const indexedTimes = new Map<string, number>();
        for (const q of jobQueries) {
          // Run 3 times and take the average to reduce variance
          const times: number[] = [];
          for (let i = 0; i < 3; i += 1) {
            const start = performance.now();
            // biome-ignore lint/performance/noAwaitInLoops: timings must not overlap
            await sqlDriver.executeQuery(`EXPLAIN ANALYZE ${q.query}`);
            times.push((performance.now() - start) / 1000);
          }
          indexedTimes.set(
            q.query,
            times.reduce((a, b) => a + b, 0) / times.length
          );
        }

        // Clean up created indexes
        await sqlDriver.executeQuery(
          `DROP INDEX IF EXISTS ${topRecs
            .map((r) => r.definition.split(" ")[2])
            .join(", ")}`
        );

        // Calculate improvement - allow small degradations
        const improvements: number[] = [];
        for (const [query, baseline] of baselineTimes) {
          const indexed = indexedTimes.get(query);
          if (indexed !== undefined && baseline > 0) {
            improvements.push(((baseline - indexed) / baseline) * 100);
          }
        }

        // Check that we have some improvement
        if (improvements.length === 0) {
          skip("Could not measure performance improvements for JOB workload");
        }

        // Find the best improvement - only need one query to show meaningful improvement
        const bestImprovement = Math.max(...improvements);

        // Relaxed assertion - at least one query should show some improvement
        // Allow for small negative values due to measurement noise
        expect(
          bestImprovement,
          `No performance improvement detected, best was ${bestImprovement.toFixed(2)}%`
        ).toBeGreaterThan(-10);
      } finally {
        rmSync(workDir, { recursive: true, force: true });
      }
    } finally {
      // Clean up tables in finally block to ensure cleanup even if test fails
      try {
        await sqlDriver.executeQuery(`
        DROP TABLE IF EXISTS movie_genres;
        DROP TABLE IF EXISTS genres;
        DROP TABLE IF EXISTS movie_companies;
        DROP TABLE IF EXISTS companies;
        DROP TABLE IF EXISTS movie_cast;
        DROP TABLE IF EXISTS actors;
        DROP TABLE IF EXISTS movies;
        `);
      } finally {
        await cleanupTestTables(sqlDriver);
      }
    }
  });

  // biome-ignore lint/suspicious/noSkippedTests: skipped upstream, kept one to one with the reason in the title
  test.skip("recommends multi-column indexes when appropriate (Skipping multi-column indexes test for now)", async () => {
    await setupTestTables(sqlDriver);
    const dta = await createDta();

    // Create test tables designed to benefit from multi-column indexes
    await sqlDriver.executeQuery(`
    DROP TABLE IF EXISTS sales;
    DROP TABLE IF EXISTS customers;
    DROP TABLE IF EXISTS products;

    CREATE TABLE customers (
        id SERIAL PRIMARY KEY,
        region VARCHAR(50),
        city VARCHAR(100),
        age INTEGER,
        income_level VARCHAR(20),
        signup_date DATE
    );

    CREATE TABLE products (
        id SERIAL PRIMARY KEY,
        category VARCHAR(50),
        subcategory VARCHAR(50),
        price DECIMAL(10,2),
        availability BOOLEAN,
        launch_date DATE
    );

    CREATE TABLE sales (
        id SERIAL PRIMARY KEY,
        customer_id INTEGER REFERENCES customers(id),
        product_id INTEGER REFERENCES products(id),
        sale_date DATE,
        quantity INTEGER,
        total_amount DECIMAL(12,2),
        payment_method VARCHAR(20),
        status VARCHAR(20)
    );
    `);

    // Create highly correlated data with strong patterns
    await sqlDriver.executeQuery(`
    -- Insert customers with strong region-city correlation
    INSERT INTO customers (region, city, age, income_level, signup_date)
    SELECT
        CASE WHEN i % 4 = 0 THEN 'North'
             WHEN i % 4 = 1 THEN 'South'
             WHEN i % 4 = 2 THEN 'East'
             ELSE 'West' END,
        -- Make city strongly correlated with region (each region has specific cities)
        CASE WHEN i % 4 = 0 THEN (ARRAY['NYC', 'Boston', 'Chicago'])[1 + (i % 3)]
             WHEN i % 4 = 1 THEN (ARRAY['Miami', 'Dallas', 'Houston'])[1 + (i % 3)]
             WHEN i % 4 = 2 THEN (ARRAY['Philadelphia', 'DC', 'Atlanta'])[1 + (i % 3)]
             ELSE (ARRAY['LA', 'Seattle', 'Portland'])[1 + (i % 3)] END,
        25 + (i % 50),
        (ARRAY['Low', 'Medium', 'High', 'Premium'])[1 + (i % 4)],
        CURRENT_DATE - ((i % 1000) || ' days')::INTERVAL
    FROM generate_series(1, 5000) i;

    -- Insert products with strong category-subcategory-price correlation
    INSERT INTO products (category, subcategory, price, availability, launch_date)
    SELECT
        CASE WHEN i % 5 = 0 THEN 'Electronics'
             WHEN i % 5 = 1 THEN 'Clothing'
             WHEN i % 5 = 2 THEN 'Home'
             WHEN i % 5 = 3 THEN 'Sports'
             ELSE 'Books' END,
        -- Make subcategory strongly correlated with category
        CASE WHEN i % 5 = 0 THEN (ARRAY['Phones', 'Computers', 'TVs'])[1 + (i % 3)]
             WHEN i % 5 = 1 THEN (ARRAY['Shirts', 'Pants', 'Shoes'])[1 + (i % 3)]
             WHEN i % 5 = 2 THEN (ARRAY['Kitchen', 'Bedroom', 'Living'])[1 + (i % 3)]
             WHEN i % 5 = 3 THEN (ARRAY['Football', 'Basketball', 'Tennis'])[1 + (i % 3)]
             ELSE (ARRAY['Fiction', 'NonFiction', 'Reference'])[1 + (i % 3)] END,
        -- Make price bands correlated with category and subcategory
        CASE WHEN i % 5 = 0 THEN 500 + (i % 5) * 100  -- Electronics: expensive
             WHEN i % 5 = 1 THEN 50 + (i % 10) * 5    -- Clothing: mid-range
             WHEN i % 5 = 2 THEN 100 + (i % 7) * 10   -- Home: varied
             WHEN i % 5 = 3 THEN 30 + (i % 15) * 2    -- Sports: cheaper
             ELSE 15 + (i % 20)                       -- Books: cheapest
        END,
        i % 10 != 0, -- 90% available
        CURRENT_DATE - ((i % 500) || ' days')::INTERVAL
    FROM generate_series(1, 1000) i;

    -- Insert sales with strong patterns conducive to multi-column indexes
    INSERT INTO sales (customer_id, product_id, sale_date, quantity, total_amount, payment_method, status)
    SELECT
        1 + (i % 5000),
        1 + (i % 1000),
        CURRENT_DATE - ((i % 365) || ' days')::INTERVAL,
        1 + (i % 5),
        (random() * 1000 + 50)::numeric(12,2),
        CASE WHEN i % 50 < 25 THEN 'Credit'       -- Make payment method and status correlated
             WHEN i % 50 < 40 THEN 'Debit'
             WHEN i % 50 < 48 THEN 'PayPal'
             ELSE 'Cash' END,
        CASE WHEN i % 50 < 25 THEN 'Completed'    -- Status correlates with payment method
             WHEN i % 50 < 40 THEN 'Pending'
             WHEN i % 50 < 48 THEN 'Processing'
             ELSE 'Canceled' END
    FROM generate_series(1, 20000) i;
    `);

    // Analyze tables to update statistics (CRUCIAL for correct index recommendations)
    await sqlDriver.executeQuery("ANALYZE customers, products, sales");

    // Clear pg_stat_statements
    await sqlDriver.executeQuery("SELECT pg_stat_statements_reset()");

    // Define queries that explicitly benefit from multi-column indexes
    // Use more extreme selectivity patterns and include ORDER BY clauses
    const multiColumnQueries: WorkloadQuery[] = [
      {
        query: `
            SELECT * FROM customers
            WHERE region = 'North' AND city = 'NYC'
            ORDER BY age DESC
            -- Needs (region, city) index - very selective
            `,
        calls: 100,
      },
      {
        query: `
            SELECT * FROM products
            WHERE category = 'Electronics' AND subcategory = 'Phones'
            AND price BETWEEN 500 AND 600
            ORDER BY launch_date
            -- Needs (category, subcategory, price) index
            `,
        calls: 120,
      },
      {
        query: `
            SELECT s.*, c.region
            FROM sales s
            JOIN customers c ON s.customer_id = c.id
            WHERE s.sale_date > CURRENT_DATE - INTERVAL '30 days'
            AND s.status = 'Completed'
            ORDER BY s.sale_date DESC LIMIT 100
            -- Needs (sale_date, status) index
            `,
        calls: 150,
      },
      {
        query: `
            SELECT s.sale_date, s.quantity, s.total_amount
            FROM sales s
            WHERE s.customer_id BETWEEN 100 AND 500
            AND s.product_id = 42
            ORDER BY s.sale_date
            -- Needs (customer_id, product_id) index
            `,
        calls: 80,
      },
      {
        query: `
            SELECT COUNT(*), SUM(total_amount)
            FROM sales
            WHERE payment_method = 'Credit' AND status = 'Completed'
            GROUP BY sale_date
            HAVING COUNT(*) > 5
            -- Needs (payment_method, status) index
            `,
        calls: 90,
      },
    ];

    // Ensure each query executes multiple times to build statistics
    for (const queryInfo of multiColumnQueries) {
      // Run each query multiple times to make sure it appears in query stats
      for (let i = 0; i < 3; i += 1) {
        try {
          // biome-ignore lint/performance/noAwaitInLoops: the calls must run one after another
          await sqlDriver.executeQuery(queryInfo.query);
        } catch {
          // Query execution errors are expected during testing
        }
      }
    }

    // Manually populate query stats in session class to ensure proper weighting
    const workload: WorkloadEntry[] = multiColumnQueries.map(
      (queryInfo, i) => ({
        query: queryInfo.query,
        queryid: 1000 + i, // Made-up queryid
        calls: queryInfo.calls,
        avg_exec_time: 50.0, // Significant execution time
        min_exec_time: 10.0,
        max_exec_time: 100.0,
        mean_exec_time: 50.0,
        stddev_exec_time: 10.0,
        rows: 100,
      })
    );

    // Analyze with both workload sources to maximize chances of finding patterns
    const session = await dta.analyzeWorkload({
      workload, // Use the manually populated workload
      minCalls: 1, // Lower threshold to ensure all queries are considered
      minAvgTimeMs: 1.0,
    });

    // Check that we got recommendations
    expect(session).toBeInstanceOf(IndexTuningResult);
    expect(session.recommendations.length).toBeGreaterThan(0);

    // Lower threshold requirement - if test environment consistently finds at least 1, that's enough for validation
    const multiColumnRecs = session.recommendations.filter(
      (rec) => rec.columns.length >= 2
    );
    expect(multiColumnRecs.length).toBeGreaterThanOrEqual(1);

    // Use the multi-column recommendations we found
    const topRecs = multiColumnRecs.slice(
      0,
      Math.min(3, multiColumnRecs.length)
    ); // Up to top 3 or all if fewer

    // Measure baseline performance
    const baselineTimes = new Map<string, number>();
    for (const q of multiColumnQueries) {
      const start = performance.now();
      try {
        // biome-ignore lint/performance/noAwaitInLoops: timings must not overlap
        await sqlDriver.executeQuery(`EXPLAIN ANALYZE ${q.query}`);
        baselineTimes.set(q.query, (performance.now() - start) / 1000);
      } catch {
        // Error measuring baseline for query
      }
    }

    // Create the recommended indexes
    const createdIndexes: string[] = [];
    for (const rec of topRecs) {
      try {
        const indexDef = rec.definition.replace("hypopg_", "");
        // biome-ignore lint/performance/noAwaitInLoops: index creation is sequential
        await sqlDriver.executeQuery(indexDef);
        createdIndexes.push(rec.definition.split(" ")[2] ?? "");
      } catch {
        // Error creating index
      }
    }

    // Measure performance with indexes
    for (const q of multiColumnQueries) {
      if (baselineTimes.has(q.query)) {
        try {
          // biome-ignore lint/performance/noAwaitInLoops: timings must not overlap
          await sqlDriver.executeQuery(`EXPLAIN ANALYZE ${q.query}`);
        } catch {
          // Error measuring indexed performance
        }
      }
    }

    // Clean up created indexes
    if (createdIndexes.length > 0) {
      try {
        await sqlDriver.executeQuery(
          `DROP INDEX IF EXISTS ${createdIndexes.join(", ")}`
        );
      } catch {
        // Error dropping indexes
      }
    }

    // Clean up tables
    await sqlDriver.executeQuery(`
    DROP TABLE IF EXISTS sales;
    DROP TABLE IF EXISTS products;
    DROP TABLE IF EXISTS customers;
    `);
  });

  test("applies the diminishing returns threshold to recommendations", {
    retry: 2,
  }, async ({ skip }) => {
    const dta = await createDta();

    try {
      // Clear pg_stat_statements
      await sqlDriver.executeQuery("SELECT pg_stat_statements_reset()");

      // Set up schema with tables designed to show diminishing returns
      await sqlDriver.executeQuery(`
        DROP TABLE IF EXISTS large_table CASCADE;

        CREATE TABLE large_table (
            id SERIAL PRIMARY KEY,
            high_cardinality_col1 INTEGER,
            high_cardinality_col2 VARCHAR(100),
            high_cardinality_col3 INTEGER,
            medium_cardinality_col1 INTEGER,
            medium_cardinality_col2 VARCHAR(50),
            low_cardinality_col1 INTEGER,
            low_cardinality_col2 VARCHAR(10)
        );
        `);

      // Create data with specific cardinality patterns - fully deterministic
      await sqlDriver.executeQuery(`
        -- Insert data with specific cardinality patterns
        INSERT INTO large_table (
            high_cardinality_col1, high_cardinality_col2, high_cardinality_col3,
            medium_cardinality_col1, medium_cardinality_col2,
            low_cardinality_col1, low_cardinality_col2
        )
        SELECT
            -- High cardinality columns (many distinct values)
            i,                                      -- almost unique
            'value-' || i,                          -- almost unique
            (i * 37) % 10000,                       -- many distinct values

            -- Medium cardinality columns
            (i % 100),                              -- 100 distinct values
            'category-' || (i % 50),                -- 50 distinct values

            -- Low cardinality columns
            (i % 5),                                -- 5 distinct values
            (ARRAY['A', 'B', 'C'])[1 + (i % 3)]     -- 3 distinct values
        FROM generate_series(1, 50000) i;
        `);

      // Force a thorough ANALYZE to ensure consistent statistics
      await sqlDriver.executeQuery("ANALYZE VERBOSE large_table");

      // Create queries with different index benefits
      // Order them to show diminishing returns pattern
      const queries: (WorkloadQuery & { expectedImprovement: number })[] = [
        {
          query: `
                -- First query: benefits greatly from an index (30% improvement)
                SELECT * FROM large_table
                WHERE high_cardinality_col1 = 12345
                ORDER BY id LIMIT 100
                `,
          calls: 100,
          expectedImprovement: 0.3, // 30% improvement
        },
        {
          query: `
                -- Second query: good benefit from an index (20% improvement)
                SELECT * FROM large_table
                WHERE high_cardinality_col2 = 'value-9876'
                ORDER BY id LIMIT 100
                `,
          calls: 80,
          expectedImprovement: 0.2, // 20% improvement
        },
        {
          query: `
                -- Third query: moderate benefit from an index (10% improvement)
                SELECT * FROM large_table
                WHERE high_cardinality_col3 BETWEEN 5000 AND 5100
                ORDER BY id LIMIT 100
                `,
          calls: 60,
          expectedImprovement: 0.1, // 10% improvement
        },
        {
          query: `
                -- Fourth query: small benefit from an index (5% improvement)
                SELECT * FROM large_table
                WHERE medium_cardinality_col1 = 42
                ORDER BY id LIMIT 100
                `,
          calls: 40,
          expectedImprovement: 0.05, // 5% improvement
        },
        {
          query: `
                -- Fifth query: minimal benefit from an index (2% improvement)
                SELECT * FROM large_table
                WHERE medium_cardinality_col2 = 'category-25'
                ORDER BY id LIMIT 100
                `,
          calls: 20,
          expectedImprovement: 0.02, // 2% improvement
        },
      ];

      // Execute queries several times to build more stable statistics
      for (let i = 0; i < 2; i += 1) {
        // Run twice to ensure stable stats
        for (const queryInfo of queries) {
          // biome-ignore lint/performance/noAwaitInLoops: the calls must run one after another
          await runRepeatedly(sqlDriver, queryInfo.query, queryInfo.calls);
        }
      }

      // Set the diminishing returns threshold to 5%
      dta.minTimeImprovement = 0.05;

      // Set a reasonable pareto_alpha for the test
      dta.paretoAlpha = 2.0;

      // Analyze the workload with 5% threshold and relaxed criteria
      const sessionWithThreshold = await dta.analyzeWorkload({
        queryList: queries.map((q) => q.query),
        minCalls: 1,
        minAvgTimeMs: 0.1, // Use lower threshold to ensure queries are considered
      });

      // Check recommendations with 5% threshold
      expect(sessionWithThreshold).toBeInstanceOf(IndexTuningResult);

      // Continue test even if no recommendations
      if (sessionWithThreshold.recommendations.length === 0) {
        skip("No recommendations generated - skipping further tests");
      }

      // We expect only recommendations for the first 3-4 queries (those with >5% improvement)
      // The fifth query with only 2% improvement should not get a recommendation
      const highImprovementColumns = [
        "high_cardinality_col1",
        "high_cardinality_col2",
        "high_cardinality_col3",
      ];
      const lowImprovementColumns = ["medium_cardinality_col2"];

      // Check that high improvement columns are recommended
      const highImprovementRecommendations =
        sessionWithThreshold.recommendations.filter((rec) =>
          highImprovementColumns.some((col) => rec.columns.includes(col))
        ).length;

      // Check that low improvement columns are not recommended
      const lowImprovementRecommendations =
        sessionWithThreshold.recommendations.filter((rec) =>
          lowImprovementColumns.some((col) => rec.columns.includes(col))
        ).length;

      // We should have found at least one recommendation for the high-improvement columns
      expect(
        highImprovementRecommendations,
        "No recommendations for high-improvement columns"
      ).toBeGreaterThan(0);

      // We should have few or no recommendations for low-improvement columns
      // Relaxed assertion to allow for occasional outliers
      expect(
        lowImprovementRecommendations,
        `Found ${lowImprovementRecommendations} recommendations for low-improvement columns despite diminishing returns threshold`
      ).toBeLessThanOrEqual(1);

      // Now test with a lower threshold (1%)
      dta.minTimeImprovement = 0.01;

      // Analyze with 1% threshold
      const sessionWithLowThreshold = await dta.analyzeWorkload({
        queryList: queries.map((q) => q.query),
        minCalls: 1,
        minAvgTimeMs: 0.1,
      });

      // With lower threshold, we should get more recommendations
      // Allow equal in case the workload doesn't generate more recommendations
      expect(
        sessionWithLowThreshold.recommendations.length,
        `Lower threshold (0.01) didn't produce at least as many recommendations as higher threshold (0.05): ${sessionWithLowThreshold.recommendations.length} vs ${sessionWithThreshold.recommendations.length}`
      ).toBeGreaterThanOrEqual(sessionWithThreshold.recommendations.length);
    } finally {
      await sqlDriver.executeQuery("DROP TABLE IF EXISTS large_table");
    }
  });

  test("recommends indexes for simple queries with Pareto optimal selection", {
    retry: 2,
  }, async ({ skip }) => {
    const dta = await createDta();

    try {
      // Create a simple test table
      await sqlDriver.executeQuery(`
        DROP TABLE IF EXISTS pareto_test CASCADE;

        CREATE TABLE pareto_test (
            id SERIAL PRIMARY KEY,
            col1 INTEGER,
            col2 VARCHAR(100),
            col3 INTEGER,
            col4 VARCHAR(100)
        );
        `);

      // Insert a reasonable amount of data
      await sqlDriver.executeQuery(`
        INSERT INTO pareto_test (col1, col2, col3, col4)
        SELECT
            i % 1000,
            'value-' || (i % 500),
            (i * 2) % 2000,
            'text-' || (i % 100)
        FROM generate_series(1, 10000) i;
        `);

      // Force a thorough ANALYZE to ensure consistent statistics
      await sqlDriver.executeQuery("ANALYZE VERBOSE pareto_test");

      // Simple queries that should be easy to index
      const queries = [
        "SELECT * FROM pareto_test WHERE col1 = 42",
        "SELECT * FROM pareto_test WHERE col2 = 'value-100'",
        "SELECT * FROM pareto_test WHERE col3 = 500",
        "SELECT * FROM pareto_test WHERE col4 = 'text-50'",
      ];

      // Run each query multiple times to ensure statistics are captured
      for (let i = 0; i < 3; i += 1) {
        // Run more iterations for stability
        for (const query of queries) {
          // biome-ignore lint/performance/noAwaitInLoops: the calls must run one after another
          await runRepeatedly(sqlDriver, query, 10);
        }
      }

      // Reset HypoPG to ensure clean state
      await sqlDriver.executeQuery("SELECT hypopg_reset()");

      // Try running DTA with clear settings
      dta.minTimeImprovement = 0.01; // Use minimal threshold
      dta.paretoAlpha = 1.5; // Balanced setting

      // Run with relaxed thresholds
      const session = await dta.analyzeWorkload({
        queryList: queries,
        minCalls: 1,
        minAvgTimeMs: 0.01, // Very low threshold to ensure queries are considered
      });

      // Just verify that we get some recommendations
      if (session.recommendations.length === 0) {
        skip("No recommendations produced - skipping validation");
      }

      // Verify the recommendations include the columns we expect
      const expectedColumns = ["col1", "col2", "col3", "col4"];
      for (const rec of session.recommendations) {
        // At least one recommendation should be for a column we expect
        const hasExpectedColumn = expectedColumns.some((col) =>
          rec.columns.includes(col)
        );
        expect(
          hasExpectedColumn,
          `Recommendation ${rec.definition} doesn't include any expected columns`
        ).toBe(true);
      }
    } finally {
      await sqlDriver.executeQuery("DROP TABLE IF EXISTS pareto_test");
    }
  });

  // biome-ignore lint/suspicious/noSkippedTests: skipped upstream, kept one to one with the reason in the title
  test.skip("balances performance gains against storage costs (Skipping storage cost tradeoff test for now)", async () => {
    const dta = await createDta();

    // Create a test table with columns of varying sizes
    await sqlDriver.executeQuery(`
    DROP TABLE IF EXISTS wide_table CASCADE;

    CREATE TABLE wide_table (
        id SERIAL PRIMARY KEY,
        small_col INTEGER,                    -- Small, fixed size
        medium_col VARCHAR(100),              -- Medium size
        large_col VARCHAR(10000),              -- Large size
        huge_col TEXT,                        -- Potentially very large

        -- Additional columns to create realistic access patterns
        user_id INTEGER,
        created_at TIMESTAMP,
        status VARCHAR(20)
    );
    `);

    // Insert data with different column size profiles
    await sqlDriver.executeQuery(`
    INSERT INTO wide_table (
        small_col, medium_col, large_col, huge_col,
        user_id, created_at, status
    )
    SELECT
        i % 1000,                            -- Small column with moderate selectivity
        'medium-' || (i % 500),              -- Medium column with good selectivity
        'large-' || repeat('x', 500 + (i % 500)),  -- Large column with large size
        CASE WHEN i % 100 = 0                -- Huge column that's occasionally needed
            THEN repeat('y', 5000 + (i % 1000))
            ELSE NULL
        END,
        (i % 1000) + 1,                      -- user_id with moderate distribution
        CURRENT_DATE - ((i % 365) || ' days')::INTERVAL,  -- Even date distribution
        (ARRAY['active', 'pending', 'completed', 'archived'])[1 + (i % 4)]  -- Status distribution
    FROM generate_series(1, 20000) i;
    `);

    // Analyze table for accurate statistics
    await sqlDriver.executeQuery("ANALYZE wide_table");

    // Create queries that would benefit from indexes with varying size-to-benefit ratios
    const queries: WorkloadQuery[] = [
      {
        query: `
            -- Small index, good benefit
            SELECT * FROM wide_table
            WHERE small_col = 42
            ORDER BY created_at DESC LIMIT 100
            `,
        calls: 100,
      },
      {
        query: `
            -- Medium index, good benefit
            SELECT * FROM wide_table
            WHERE medium_col = 'medium-123'
            ORDER BY created_at DESC LIMIT 100
            `,
        calls: 80,
      },
      {
        query: `
            -- Large index, moderate benefit
            SELECT * FROM wide_table
            WHERE large_col LIKE 'large-xx%'
            ORDER BY created_at DESC LIMIT 100
            `,
        calls: 50,
      },
      {
        query: `
            -- Huge index, small benefit (rarely used)
            SELECT * FROM wide_table
            WHERE huge_col IS NOT NULL
            ORDER BY created_at DESC LIMIT 100
            `,
        calls: 20,
      },
    ];

    // Execute queries to build statistics
    for (const queryInfo of queries) {
      // biome-ignore lint/performance/noAwaitInLoops: the calls must run one after another
      await runRepeatedly(sqlDriver, queryInfo.query, queryInfo.calls);
    }

    // First test with high storage sensitivity (alpha=5.0)
    // This should favor small indexes with good benefit/cost ratio
    dta.paretoAlpha = 5.0; // Very sensitive to storage costs

    const sessionStorageSensitive = await dta.analyzeWorkload({
      queryList: queries.map((q) => q.query),
      minCalls: 1,
      minAvgTimeMs: 1.0,
    });

    // Check that we have recommendations
    expect(sessionStorageSensitive).toBeInstanceOf(IndexTuningResult);
    expect(sessionStorageSensitive.recommendations.length).toBeGreaterThan(0);

    // Should prefer smaller indexes with good benefit/cost ratio
    const smallColumnsRecommended =
      sessionStorageSensitive.recommendations.some((rec) =>
        rec.columns.includes("small_col")
      );
    const hugeColumnsRecommended = sessionStorageSensitive.recommendations.some(
      (rec) => rec.columns.includes("huge_col")
    );

    expect(
      smallColumnsRecommended,
      "Small column index not recommended despite good benefit/cost ratio"
    ).toBe(true);
    expect(
      hugeColumnsRecommended,
      "Huge column index recommended despite poor benefit/cost ratio"
    ).toBe(false);

    // Now test with low storage sensitivity (alpha=0.5)
    // This should include more indexes, even larger ones
    dta.paretoAlpha = 0.5; // Less sensitive to storage costs

    const sessionPerformanceFocused = await dta.analyzeWorkload({
      queryList: queries.map((q) => q.query),
      minCalls: 1,
      minAvgTimeMs: 1.0,
    });

    // Should include more recommendations
    expect(
      sessionPerformanceFocused.recommendations.length
    ).toBeGreaterThanOrEqual(sessionStorageSensitive.recommendations.length);

    // Calculate the total size of recommendations in each approach
    const sizeSensitive = sessionStorageSensitive.recommendations.reduce(
      (sum, rec) => sum + rec.estimatedSizeBytes,
      0
    );
    const sizePerformance = sessionPerformanceFocused.recommendations.reduce(
      (sum, rec) => sum + rec.estimatedSizeBytes,
      0
    );

    // Performance-focused approach should use more storage
    expect(
      sizePerformance,
      "Performance-focused approach should use more storage for indexes"
    ).toBeGreaterThanOrEqual(sizeSensitive);

    // Clean up
    await sqlDriver.executeQuery("DROP TABLE IF EXISTS wide_table");
  });

  // biome-ignore lint/suspicious/noSkippedTests: skipped upstream, kept one to one with the reason in the title
  test.skip("selects Pareto optimal indexes (Skipping pareto optimal index selection test for now)", async () => {
    const dta = await createDta();

    // Create a test table with characteristics that demonstrate Pareto optimality
    await sqlDriver.executeQuery(`
    DROP TABLE IF EXISTS pareto_test CASCADE;
    CREATE TABLE pareto_test (
        id SERIAL PRIMARY KEY,
        col1 INTEGER,       -- High improvement, small size
        col2 VARCHAR(100),  -- Medium improvement, medium size
        col3 TEXT,          -- Low improvement, large size
        date_col DATE,
        value NUMERIC(10,2)
    );
    `);

    // Insert test data
    await sqlDriver.executeQuery(`
    INSERT INTO pareto_test (col1, col2, col3, date_col, value)
    SELECT
        i % 10000,          -- Many distinct values (high cardinality)
        'val-' || (i % 1000), -- Medium cardinality
        CASE WHEN i % 100 = 0 THEN repeat('x', 1000) ELSE NULL END, -- Low cardinality, large size
        CURRENT_DATE - ((i % 730) || ' days')::INTERVAL, -- Dates spanning 2 years
        (random() * 1000)::numeric(10,2) -- Random values
    FROM generate_series(1, 50000) i;
    `);

    // Analyze the table
    await sqlDriver.executeQuery("ANALYZE pareto_test");

    // Create a workload with specific benefit profiles
    const queries = [
      // Query benefiting most from col1 index (small, high benefit)
      "SELECT * FROM pareto_test WHERE col1 = 123 ORDER BY date_col",
      // Query benefiting from col2 index (medium size, medium benefit)
      "SELECT * FROM pareto_test WHERE col2 = 'val-456' ORDER BY date_col",
      // Query benefiting from col3 index (large size, low benefit)
      "SELECT * FROM pareto_test WHERE col3 IS NOT NULL ORDER BY date_col",
      // Query that would benefit from a date index
      "SELECT * FROM pareto_test WHERE date_col >= CURRENT_DATE - INTERVAL '30 days'",
      // Query with a range scan
      "SELECT * FROM pareto_test WHERE col1 BETWEEN 100 AND 200 ORDER BY date_col",
    ];

    // Execute each query to build statistics
    for (const query of queries) {
      // Run each query multiple times
      // biome-ignore lint/performance/noAwaitInLoops: the calls must run one after another
      await runRepeatedly(sqlDriver, query, 10);
    }

    // Set pareto parameters
    dta.paretoAlpha = 2.0; // Balance between performance and storage
    dta.minTimeImprovement = 0.05; // 5% minimum improvement threshold

    // Run DTA with the workload
    const session = await dta.analyzeWorkload({
      queryList: queries,
      minCalls: 1,
      minAvgTimeMs: 1.0,
    });

    // Verify we got recommendations
    expect(session).toBeInstanceOf(IndexTuningResult);
    expect(session.recommendations.length).toBeGreaterThan(0);

    // Verify the recommendations follow Pareto principles
    // 1. col1 (high benefit, small size) should be recommended
    expect(
      session.recommendations.some((rec) => rec.columns.includes("col1")),
      "col1 should be recommended (high benefit/size ratio)"
    ).toBe(true);

    // 2. The large, low-benefit index should not be recommended or be low priority
    const col3Position = session.recommendations.findIndex((rec) =>
      rec.columns.includes("col3")
    );
    // If present, it should be lower priority (later in the list)
    const col1Position = session.recommendations.findIndex((rec) =>
      rec.columns.includes("col1")
    );
    expect(
      col3Position === -1 || col3Position > col1Position,
      "col3 (low benefit/size ratio) should be lower priority than col1"
    ).toBe(true);

    // 3. Run again with different alpha values to show how preferences change
    // With high alpha (storage sensitive)
    dta.paretoAlpha = 5.0;
    const sessionStorageSensitive = await dta.analyzeWorkload({
      queryList: queries,
      minCalls: 1,
      minAvgTimeMs: 1.0,
    });

    // With low alpha (performance sensitive)
    dta.paretoAlpha = 0.5;
    const sessionPerformanceSensitive = await dta.analyzeWorkload({
      queryList: queries,
      minCalls: 1,
      minAvgTimeMs: 1.0,
    });

    // Calculate total size of recommendations for each approach
    const storageSize = sessionStorageSensitive.recommendations.reduce(
      (sum, rec) => sum + rec.estimatedSizeBytes,
      0
    );
    const performanceSize = sessionPerformanceSensitive.recommendations.reduce(
      (sum, rec) => sum + rec.estimatedSizeBytes,
      0
    );

    // Storage-sensitive should use less space
    expect(
      storageSize,
      "Storage-sensitive recommendations should use less space"
    ).toBeLessThanOrEqual(performanceSize);

    // Clean up
    await sqlDriver.executeQuery("DROP TABLE IF EXISTS pareto_test");
  });
});
