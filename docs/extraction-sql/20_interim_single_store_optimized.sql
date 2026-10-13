-- =====================================================================
-- 20_interim_single_store_optimized.sql
-- Use ONLY until the extract-once approach (10-13 + 30) is live.
-- Same output columns as the current query, minus Excel formatting.
-- Changes vs current query:
--   1. Remark sources are restricted to documents present in this
--      store's ledger slice (EXISTS) instead of the whole year for all
--      stores.
--   2. Account joins use native columns (no CONVERT on either side) so
--      an index on act_mst.c_code can be used. Confirm D5 + data types
--      first; if types differ, convert the LEDGER side only once.
--   3. Half-open date range.
--   4. '''' text prefix removed — apply at export/Excel stage only.
-- =====================================================================
SELECT l.c_br_code, l.c_year, l.c_prefix, l.n_tran_no,
       l.c_act_code, l.d_date, l.n_amount, l.c_opp_act_code,
       l.n_flag, l.c_ref_br_code, l.n_pk,
       o.c_grp_no, o.n_type,              -- NOTE: taken from OPPOSITE account,
       a.c_name AS act_name,              -- as in the current query; confirm intent
       o.c_name AS opp_act_name,
       r.c_remark
FROM   dba.ledger l
LEFT JOIN dba.act_mst a ON a.c_code = l.c_act_code
LEFT JOIN dba.act_mst o ON o.c_code = l.c_opp_act_code
LEFT JOIN (
       SELECT x.c_br_code, x.c_year, x.c_prefix, x.n_srno, MAX(x.c_remark) AS c_remark
       FROM (
             SELECT d.c_br_code, d.c_year, d.c_prefix, d.n_srno, d.c_remark FROM dba.cash_depo d
             WHERE d.c_year = :fy AND EXISTS (SELECT 1 FROM dba.ledger k
                   WHERE k.c_year = :fy AND k.c_ref_br_code = :branch
                     AND k.d_date >= :from_date AND k.d_date < :to_date_excl
                     AND k.c_br_code = d.c_br_code AND k.c_prefix = d.c_prefix AND k.n_tran_no = d.n_srno)
             UNION ALL
             SELECT d.c_br_code, d.c_year, d.c_prefix, d.n_srno, d.c_remark FROM dba.crnt_det d
             WHERE d.c_year = :fy AND EXISTS (SELECT 1 FROM dba.ledger k
                   WHERE k.c_year = :fy AND k.c_ref_br_code = :branch
                     AND k.d_date >= :from_date AND k.d_date < :to_date_excl
                     AND k.c_br_code = d.c_br_code AND k.c_prefix = d.c_prefix AND k.n_tran_no = d.n_srno)
             UNION ALL
             SELECT d.c_br_code, d.c_year, d.c_prefix, d.n_srno, d.c_remark FROM dba.inv_det d
             WHERE d.c_year = :fy AND EXISTS (SELECT 1 FROM dba.ledger k
                   WHERE k.c_year = :fy AND k.c_ref_br_code = :branch
                     AND k.d_date >= :from_date AND k.d_date < :to_date_excl
                     AND k.c_br_code = d.c_br_code AND k.c_prefix = d.c_prefix AND k.n_tran_no = d.n_srno)
             UNION ALL
             SELECT d.c_br_code, d.c_year, d.c_prefix, d.n_srno, d.c_remark FROM dba.jv_det d
             WHERE d.c_year = :fy AND EXISTS (SELECT 1 FROM dba.ledger k
                   WHERE k.c_year = :fy AND k.c_ref_br_code = :branch
                     AND k.d_date >= :from_date AND k.d_date < :to_date_excl
                     AND k.c_br_code = d.c_br_code AND k.c_prefix = d.c_prefix AND k.n_tran_no = d.n_srno)
             UNION ALL
             SELECT d.c_br_code, d.c_year, d.c_prefix, d.n_srno, d.c_remark FROM dba.pur_det d
             WHERE d.c_year = :fy AND EXISTS (SELECT 1 FROM dba.ledger k
                   WHERE k.c_year = :fy AND k.c_ref_br_code = :branch
                     AND k.d_date >= :from_date AND k.d_date < :to_date_excl
                     AND k.c_br_code = d.c_br_code AND k.c_prefix = d.c_prefix AND k.n_tran_no = d.n_srno)
       ) x
       WHERE x.c_remark IS NOT NULL AND TRIM(x.c_remark) <> ''
       GROUP BY x.c_br_code, x.c_year, x.c_prefix, x.n_srno
) r
  ON  r.c_br_code = l.c_br_code AND r.c_year = l.c_year
  AND r.c_prefix  = l.c_prefix  AND r.n_srno = l.n_tran_no
WHERE  l.c_year = :fy
  AND  l.c_ref_br_code = :branch
  AND  l.d_date >= :from_date
  AND  l.d_date <  :to_date_excl;
-- Supporting indexes (production only with DBA approval; free on a restored copy):
--   ledger   (c_ref_br_code, c_year, d_date)
--   ledger   (c_br_code, c_prefix, n_tran_no)
--   each det (c_br_code, c_prefix, n_srno, c_year)
--   act_mst  (c_code)
