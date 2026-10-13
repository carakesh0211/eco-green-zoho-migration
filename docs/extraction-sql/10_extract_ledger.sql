-- =====================================================================
-- 10_extract_ledger.sql  —  ONE pass for ALL stores (no joins)
-- Replaces 350 per-store runs. Branch split happens in staging.
-- Partition by month only if a single run exceeds the agreed window;
-- partitions use half-open date ranges so no row falls in two runs.
-- =====================================================================
SELECT l.n_pk,                 -- unique key: dedupe + reconciliation
       l.c_br_code,
       l.c_ref_br_code,
       l.c_year,
       l.c_prefix,
       l.n_tran_no,
       l.d_date,
       l.c_act_code,           -- native type; no CONVERT, no '''' prefix
       l.c_opp_act_code,
       l.n_amount,
       l.n_flag
FROM   dba.ledger l
WHERE  l.c_year = :fy
  AND  l.d_date >= :from_date        -- e.g. '2026-04-01'
  AND  l.d_date <  :to_date_excl;    -- e.g. '2026-07-06' (day AFTER the last day)
-- No ORDER BY: sorting is done in staging, not on the production server.
-- No branch predicate: every row, including NULL ref branch, is captured.
