-- =====================================================================
-- 30_staging_build.sql  —  runs in the STAGING database, not Eco Green
-- Tested on DuckDB; PostgreSQL-compatible. Input tables are the raw
-- CSV loads of scripts 10-13 (all code columns loaded as TEXT, so the
-- CONVERT() in the original query is no longer needed).
--   raw_ledger, raw_remark (union of the five 11_* files),
--   raw_act_mst, src_control
-- Each CHECK query must return ZERO rows before the next step runs.
-- =====================================================================

-- CHECK 1: ledger key unique (duplicate delivery / overlapping partitions)
SELECT n_pk, COUNT(*) AS cnt FROM raw_ledger GROUP BY n_pk HAVING COUNT(*) > 1;

-- CHECK 2: account code unique (otherwise the join multiplies rows)
SELECT TRIM(c_code) AS c_code, COUNT(*) AS cnt
FROM raw_act_mst GROUP BY TRIM(c_code) HAVING COUNT(*) > 1;

-- STEP 1: one row per document key; all distinct remarks preserved
CREATE TABLE stg_remark AS
SELECT c_br_code, c_year, c_prefix, n_srno,
       STRING_AGG(DISTINCT TRIM(c_remark), ' | ' ORDER BY TRIM(c_remark)) AS c_remark,
       COUNT(DISTINCT src_table)        AS src_table_count,
       COUNT(DISTINCT TRIM(c_remark))   AS remark_count
FROM   raw_remark
GROUP  BY c_br_code, c_year, c_prefix, n_srno;

-- CHECK 3: same document key found in two different source tables
--          (prefix collision -> remark could attach to the wrong voucher)
SELECT * FROM stg_remark WHERE src_table_count > 1;

-- STEP 2: enrich ledger (every join is to a unique key -> no fan-out)
CREATE TABLE stg_ledger_enriched AS
SELECT l.n_pk, l.c_br_code, l.c_ref_br_code, l.c_year, l.c_prefix, l.n_tran_no,
       l.d_date, TRIM(l.c_act_code) AS c_act_code, TRIM(l.c_opp_act_code) AS c_opp_act_code,
       l.n_amount, l.n_flag,
       a.c_name   AS act_name,
       o.c_name   AS opp_act_name,
       o.c_grp_no AS opp_grp_no,     -- as per current query (opposite account)
       o.n_type   AS opp_type,
       r.c_remark,
       r.remark_count
FROM   raw_ledger l
LEFT JOIN raw_act_mst a ON TRIM(a.c_code) = TRIM(l.c_act_code)
LEFT JOIN raw_act_mst o ON TRIM(o.c_code) = TRIM(l.c_opp_act_code)
LEFT JOIN stg_remark  r ON  r.c_br_code = l.c_br_code AND r.c_year = l.c_year
                        AND r.c_prefix  = l.c_prefix  AND r.n_srno = l.n_tran_no;

-- CHECK 4: row count preserved (must return zero rows)
SELECT (SELECT COUNT(*) FROM raw_ledger) AS raw_rows,
       (SELECT COUNT(*) FROM stg_ledger_enriched) AS enriched_rows
WHERE  (SELECT COUNT(*) FROM raw_ledger) <> (SELECT COUNT(*) FROM stg_ledger_enriched);

-- CHECK 5: staging vs source control totals (13_*), per branch/account/flag
WITH s AS (
  SELECT c_ref_br_code, c_act_code, n_flag,
         COUNT(*) AS row_count, SUM(n_amount) AS amount_total
  FROM   stg_ledger_enriched GROUP BY c_ref_br_code, c_act_code, n_flag)
SELECT COALESCE(c.c_ref_br_code, s.c_ref_br_code) AS c_ref_br_code,
       COALESCE(c.c_act_code,   s.c_act_code)     AS c_act_code,
       COALESCE(c.n_flag,       s.n_flag)         AS n_flag,
       c.row_count AS src_rows, s.row_count AS stg_rows,
       c.amount_total AS src_amount, s.amount_total AS stg_amount
FROM   src_control c
FULL OUTER JOIN s
  ON  c.c_ref_br_code IS NOT DISTINCT FROM s.c_ref_br_code
  AND TRIM(c.c_act_code) = s.c_act_code
  AND c.n_flag = s.n_flag
WHERE  c.row_count IS DISTINCT FROM s.row_count
   OR  c.amount_total IS DISTINCT FROM s.amount_total;

-- CHECK 6: unmatched master / remark coverage (report, not a blocker)
SELECT c_ref_br_code,
       COUNT(*)                                          AS rows_total,
       SUM(CASE WHEN act_name     IS NULL THEN 1 ELSE 0 END) AS missing_act_name,
       SUM(CASE WHEN opp_act_name IS NULL AND c_opp_act_code IS NOT NULL THEN 1 ELSE 0 END) AS missing_opp_name,
       SUM(CASE WHEN c_remark     IS NULL THEN 1 ELSE 0 END) AS without_remark,
       SUM(CASE WHEN remark_count > 1     THEN 1 ELSE 0 END) AS multi_remark_rows
FROM   stg_ledger_enriched
GROUP  BY c_ref_br_code
ORDER  BY c_ref_br_code;

-- STEP 3 (DuckDB): write all per-store files in ONE statement
-- COPY (SELECT * FROM stg_ledger_enriched ORDER BY c_ref_br_code, d_date, n_pk)
--   TO 'out/ledger' (FORMAT CSV, HEADER, PARTITION_BY (c_ref_br_code));
-- PostgreSQL equivalent: one \copy ... WHERE c_ref_br_code = '<code>' per store.
