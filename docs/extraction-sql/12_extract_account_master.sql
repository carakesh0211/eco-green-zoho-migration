-- =====================================================================
-- 12_extract_account_master.sql  —  ONCE for the whole migration
-- Master data is small; joining it 350 x 2 times on the server is waste.
-- =====================================================================
SELECT c_code, c_name, c_grp_no, n_type
FROM   dba.act_mst;
