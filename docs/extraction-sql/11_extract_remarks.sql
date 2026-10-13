-- =====================================================================
-- 11_extract_remarks.sql  —  ONE pass per remark source for the year
-- DISTINCT collapses repeated line-level remarks to one row per
-- (document, remark). Aggregation to one row per document is done in
-- staging so no remark is silently discarded by MAX().
-- Run the five statements separately (or in parallel, max 2 at a time).
-- =====================================================================
SELECT DISTINCT 'CASH_DEPO' AS src_table, c_br_code, c_year, c_prefix, n_srno, c_remark
FROM   dba.cash_depo
WHERE  c_year = :fy AND c_remark IS NOT NULL AND TRIM(c_remark) <> '';

SELECT DISTINCT 'CRNT_DET' AS src_table, c_br_code, c_year, c_prefix, n_srno, c_remark
FROM   dba.crnt_det
WHERE  c_year = :fy AND c_remark IS NOT NULL AND TRIM(c_remark) <> '';

SELECT DISTINCT 'INV_DET' AS src_table, c_br_code, c_year, c_prefix, n_srno, c_remark
FROM   dba.inv_det
WHERE  c_year = :fy AND c_remark IS NOT NULL AND TRIM(c_remark) <> '';

SELECT DISTINCT 'JV_DET' AS src_table, c_br_code, c_year, c_prefix, n_srno, c_remark
FROM   dba.jv_det
WHERE  c_year = :fy AND c_remark IS NOT NULL AND TRIM(c_remark) <> '';

SELECT DISTINCT 'PUR_DET' AS src_table, c_br_code, c_year, c_prefix, n_srno, c_remark
FROM   dba.pur_det
WHERE  c_year = :fy AND c_remark IS NOT NULL AND TRIM(c_remark) <> '';

-- Payment / receipt tagging (bill-wise adjustment) tables are NOT in the
-- current query. Add one extract per table here once the DBA names them
-- (see EXTRACTION_OPTIMIZATION.md §9). Same pattern: key columns + tag
-- columns, filtered by year only, no joins.
