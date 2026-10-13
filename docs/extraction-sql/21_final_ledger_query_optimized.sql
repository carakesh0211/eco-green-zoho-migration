-- =====================================================================
-- 21_final_ledger_query_optimized.sql
-- Same result as the current "final ledger query" (same columns, same
-- rows, same duplicates). Only the amount of data read and grouped
-- changes:
--   * lk  = this store's ledger document keys, computed once.
--   * Remark sources are read only for documents in lk, instead of the
--     whole year for all stores. Every row of a matched document is
--     kept, so MAX(c_remark) is unchanged.
--   * set_det / supp_pay_det are restricted to invoice numbers present
--     in lk. Rows are NOT de-duplicated, so the row multiplication of
--     the original join is preserved exactly.
-- The CONVERT() joins, BETWEEN, '''' prefix and MAX() are deliberately
-- unchanged (see notes at the end).
-- =====================================================================
with lk as (
    select distinct c_br_code, c_prefix, n_tran_no
    from dba.ledger
    where c_year = 26
      and c_ref_br_code = '462'
      and d_date between '2026-04-01' and '2026-07-05'
)
select
    l.c_br_code,
    l.c_year,
    l.c_prefix,
    l.n_tran_no,
    '''' + convert(varchar(50), l.c_act_code) as c_act_code,
    l.d_date,
    l.n_amount,
    '''' + convert(varchar(50), l.c_opp_act_code) as c_opp_act_code,
    l.n_flag,
    l.c_ref_br_code,
    l.n_pk,
    o.c_grp_no,
    o.n_type,
    a.c_name as act_name,
    o.c_name as opp_act_name,
    r.c_remark,
    i.n_inv_no as set_det_inv_no,
    s.n_inv_no as supp_pay_det_inv_no

from dba.ledger as l

left join dba.act_mst as a
    on convert(varchar(50), l.c_act_code) = convert(varchar(50), a.c_code)

left join dba.act_mst as o
    on convert(varchar(50), l.c_opp_act_code) = convert(varchar(50), o.c_code)

left join (
    select d.n_inv_no
    from dba.set_det as d
    where d.n_inv_no in (select n_tran_no from lk)
) as i
    on l.n_tran_no = i.n_inv_no

left join (
    select d.n_inv_no
    from dba.supp_pay_det as d
    where d.n_inv_no in (select n_tran_no from lk)
) as s
    on l.n_tran_no = s.n_inv_no

left join (
    select c_br_code, c_year, c_prefix, n_srno, max(c_remark) as c_remark
    from (
        select d.c_br_code, d.c_year, d.c_prefix, d.n_srno, d.c_remark
        from dba.cash_depo as d
        join lk on lk.c_br_code = d.c_br_code and lk.c_prefix = d.c_prefix and lk.n_tran_no = d.n_srno
        where d.c_year = 26

        union all

        select d.c_br_code, d.c_year, d.c_prefix, d.n_srno, d.c_remark
        from dba.crnt_det as d
        join lk on lk.c_br_code = d.c_br_code and lk.c_prefix = d.c_prefix and lk.n_tran_no = d.n_srno
        where d.c_year = 26

        union all

        select d.c_br_code, d.c_year, d.c_prefix, d.n_srno, d.c_remark
        from dba.inv_det as d
        join lk on lk.c_br_code = d.c_br_code and lk.c_prefix = d.c_prefix and lk.n_tran_no = d.n_srno
        where d.c_year = 26

        union all

        select d.c_br_code, d.c_year, d.c_prefix, d.n_srno, d.c_remark
        from dba.jv_det as d
        join lk on lk.c_br_code = d.c_br_code and lk.c_prefix = d.c_prefix and lk.n_tran_no = d.n_srno
        where d.c_year = 26

        union all

        select d.c_br_code, d.c_year, d.c_prefix, d.n_srno, d.c_remark
        from dba.pur_det as d
        join lk on lk.c_br_code = d.c_br_code and lk.c_prefix = d.c_prefix and lk.n_tran_no = d.n_srno
        where d.c_year = 26
    ) as x
    where x.c_remark is not null
      and trim(x.c_remark) <> ''
    group by c_br_code, c_year, c_prefix, n_srno
) as r
    on  r.c_br_code = l.c_br_code
   and r.c_year    = l.c_year
   and r.c_prefix  = l.c_prefix
   and r.n_srno    = l.n_tran_no

where l.c_year = 26
  and l.c_ref_br_code = '462'
  and l.d_date between '2026-04-01' and '2026-07-05';

-- ---------------------------------------------------------------------
-- Indexes that speed this query up without changing its result
-- (ask the DBA; skip any that already exist):
--   ledger        (c_ref_br_code, c_year, d_date)
--   cash_depo, crnt_det, inv_det, jv_det, pur_det
--                 (c_br_code, c_prefix, n_srno, c_year)
--   set_det       (n_inv_no)
--   supp_pay_det  (n_inv_no)
--   act_mst       (c_code)
-- The CONVERT() on both sides of the act_mst joins blocks index use.
-- It is kept because removing it is only safe if ledger.c_act_code /
-- c_opp_act_code and act_mst.c_code have the same data type.
-- ---------------------------------------------------------------------
