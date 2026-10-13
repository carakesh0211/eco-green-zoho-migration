-- =====================================================================
-- 13_source_control_totals.sql  —  run in the SAME window as 10_*
-- Transfer-completeness control: proves every source row arrived in
-- staging. (Accounting completeness is proven separately against the
-- Eco Green application's own branch-wise Trial Balance report.)
-- =====================================================================
SELECT c_ref_br_code,
       c_act_code,
       n_flag,
       COUNT(*)      AS row_count,
       SUM(n_amount) AS amount_total,
       MIN(n_pk)     AS min_pk,
       MAX(n_pk)     AS max_pk
FROM   dba.ledger
WHERE  c_year = :fy
  AND  d_date >= :from_date
  AND  d_date <  :to_date_excl
GROUP  BY c_ref_br_code, c_act_code, n_flag;
