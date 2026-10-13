-- =====================================================================
-- 00_source_diagnostics.sql  —  run ONCE before redesign (read-only)
-- Purpose : establish facts that decide join keys, partitioning and
--           duplicate risk. Every query returns a small result set.
-- Engine  : ANSI SQL. Replace :fy (e.g. 26), :from_date, :to_date_excl.
--           Owner prefix "dba." kept as in the current query.
-- =====================================================================

-- D1. Volume and distribution of the ledger for the migration window
SELECT COUNT(*)                     AS ledger_rows,
       COUNT(DISTINCT c_ref_br_code) AS ref_branches,
       COUNT(DISTINCT c_br_code)     AS br_codes,
       MIN(n_pk) AS min_pk, MAX(n_pk) AS max_pk,
       MIN(d_date) AS min_date, MAX(d_date) AS max_date
FROM   dba.ledger
WHERE  c_year = :fy AND d_date >= :from_date AND d_date < :to_date_excl;

-- D2. Is n_pk unique? (must return zero rows; it is the reconciliation key)
SELECT n_pk, COUNT(*) AS cnt
FROM   dba.ledger
WHERE  c_year = :fy
GROUP  BY n_pk
HAVING COUNT(*) > 1;

-- D3. Rows the per-store filter can never pick up (NULL / blank ref branch)
SELECT COUNT(*) AS rows_without_ref_branch
FROM   dba.ledger
WHERE  c_year = :fy AND d_date >= :from_date AND d_date < :to_date_excl
  AND  (c_ref_br_code IS NULL OR TRIM(c_ref_br_code) = '');

-- D4. How often does c_br_code differ from c_ref_br_code? (inter-branch rows)
SELECT COUNT(*) AS cross_branch_rows
FROM   dba.ledger
WHERE  c_year = :fy AND d_date >= :from_date AND d_date < :to_date_excl
  AND  c_br_code <> c_ref_br_code;

-- D5. Account master: is c_code unique? (duplicates multiply ledger rows)
SELECT c_code, COUNT(*) AS cnt
FROM   dba.act_mst
GROUP  BY c_code
HAVING COUNT(*) > 1;

-- D6. Row volume per remark source (decides staging size)
SELECT 'cash_depo' AS src, COUNT(*) AS rows_fy FROM dba.cash_depo WHERE c_year = :fy
UNION ALL SELECT 'crnt_det', COUNT(*) FROM dba.crnt_det WHERE c_year = :fy
UNION ALL SELECT 'inv_det',  COUNT(*) FROM dba.inv_det  WHERE c_year = :fy
UNION ALL SELECT 'jv_det',   COUNT(*) FROM dba.jv_det   WHERE c_year = :fy
UNION ALL SELECT 'pur_det',  COUNT(*) FROM dba.pur_det  WHERE c_year = :fy;

-- D7. Does a document carry more than one distinct remark? (MAX() drops the rest)
SELECT 'inv_det' AS src, COUNT(*) AS docs_with_multiple_remarks
FROM  (SELECT c_br_code, c_prefix, n_srno
       FROM   dba.inv_det
       WHERE  c_year = :fy AND c_remark IS NOT NULL AND TRIM(c_remark) <> ''
       GROUP  BY c_br_code, c_prefix, n_srno
       HAVING COUNT(DISTINCT c_remark) > 1) x;
-- repeat D7 for cash_depo, crnt_det, jv_det, pur_det

-- D8. Does d_date carry a time component? (BETWEEN '...-07-05' would drop
--     rows timed after 00:00 on the last day). Compare the two counts.
SELECT COUNT(*) AS rows_on_last_day_any_time
FROM   dba.ledger
WHERE  c_year = :fy AND d_date >= :last_day AND d_date < :to_date_excl;
SELECT COUNT(*) AS rows_on_last_day_midnight_only
FROM   dba.ledger
WHERE  c_year = :fy AND d_date = :last_day;
-- :last_day = '2026-07-05', :to_date_excl = '2026-07-06'. Counts must be equal.
