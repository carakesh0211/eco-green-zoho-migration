# Eco Green raw extract normaliser

## Purpose

The Eco Green team delivers each branch as a folder of raw table dumps rather than the two
contract files in `DATA_CONTRACT.md`. The normaliser turns that folder into one contract-v1
extraction run (`manifest.json`, `transactions.csv`, `trial_balance.csv`) so the existing ingest
pipeline consumes it unchanged. It also writes `allocations.csv` (settlement evidence) and
`normalisation_report.json` (exclusions, bridge, unknown ledgers). The module is pure
(`src/sources/ecogreen/normalise.js`: bytes in, bytes out); the CLI is `scripts/normalise-ecogreen.js`:

    node scripts/normalise-ecogreen.js --in <raw-folder> --profile <profile.json> --out <inbox-root>

Output goes to `<inbox-root>/<branch>/<run-id>/`, manifest last. Inside this repository the CLI only
writes under `var/`.

## Input files

Dates in raw files are `dd/mm/yy`; account codes may carry a leading apostrophe (stripped).
A document is identified by `c_br_code/c_year/c_prefix/n_srno` and becomes the `voucher_id`.
Missing optional files are skipped; a header-only file means "no such documents". A missing
required column on a file that has data rows stops the run with `HEADER_MISMATCH`.

| File | Columns used |
| --- | --- |
| `jv_det.csv` | document key, `n_seq` (line order), `c_act_code`, `n_debit`, `n_credit`, `d_date`, `c_ref_br_code`, `n_cancel_flag`, `c_remark` |
| `supp_pay_det.csv` | document key, `c_ref_br_code`, `c_inv_year`, `c_inv_prefix`, `n_inv_no`, `n_amount`, `d_date`, `c_supp_code`, `c_opp_act_code`, `n_cancel_flag`, `c_chq_no` (optional) |
| `set_det.csv` | document key, `c_ref_br_code`, `c_inv_year`, `c_inv_prefix`, `n_inv_no`, `n_amount`, `d_date`, `c_cust_code`, `n_cancel_flag` |
| `payment.csv`, `receipt.csv`, `cash_depo.csv`, `cash_with.csv`, `bank_to_bank.csv`, `b2b.csv` | document key, `d_date`, the debit, credit and amount columns named by the table spec; optional `c_remark`, `c_chq_no`, `c_ref_br_code`, `n_cancel_flag`; `payment.csv` also reads `n_cgst_amt`, `n_sgst_amt`, `n_igst_amt`, `n_cess_amt` |
| `jv_act.csv` (optional) | `c_code`, `c_name`: ledger and party names, taking priority over trial balance names |
| `tb.csv` (required) | `code`, `name`, `top`, `group`, `opdr`, `opcr`, `trdr`, `trcr`, `cldr`, `clcr` |

## Profile

A JSON file, one per branch run; `config/source-profiles/ecogreen.example.json` is the template.

| Field | Meaning |
| --- | --- |
| `branch_code`, `from_date`, `to_date` | Branch and inclusive date window (ISO dates). Required |
| `in_scope_prefixes` | Map of document prefix to `JOURNAL`, `PAYMENT`, `RECEIPT`, `CONTRA`, `EXPENSE` or `SETTLEMENT`. Required |
| `excluded_prefixes`, `hold_prefixes` | Inventory prefixes and on-hold prefixes. A prefix may appear in only one of the three lists |
| `cash_accounts` | Account codes whose use sets `payment_method` to `CASH`; anything else is `BANK` |
| `party_controls` | Entries of `control`, `name`, `party_type`, `party_prefixes`, `tb_groups` (see roll-up below) |
| `simple_tables` | Optional override of the table specs (`file`, `debit_col`, `credit_col`, `amount_col`, `gst_guard`) |
| `tb_file`, `extraction_run_id`, `extracted_at`, `profile_version` | Optional. Without `extraction_run_id` the id is derived from the branch, window and a hash of inputs plus profile, so the same inputs always give the same run |

## Scope rules

- In scope: prefixes `J`, `211`, `213` (journals), `P`, `Q` (payments), `R`, `H` (receipts),
  `X`, `Y`, `F`, `W` (contra), `E` (settlements).
- Excluded as inventory: `A`, `L`, `U`, `N`, `G`, `S`, `T`, `I`, `K`. Smart Pharma already posts
  these to Zoho Books, so migrating them would duplicate postings.
- On hold: `JT` (auto-TDS journals) until their treatment is agreed.
- Window: `from_date` and `to_date` are both included. Each branch has its own end date.
- Rows whose `c_ref_br_code` (or `c_br_code` when that column is absent) is another branch are excluded.

## From tables to vouchers

- **Journals** (`jv_det`): already double-entry, one row per line. Debit and credit on a row are
  netted to one side, and a negative amount flips the side. Lines follow `n_seq`.
- **Supplier payments** (`supp_pay_det`): one row per invoice paid. Each row gives a line on the
  supplier (debit for a positive amount, credit for a negative one) with `reference_no` set to the
  invoice reference `branch/inv_year/inv_prefix/inv_no`. The document then gets one credit line
  per opposite account carrying the net amount (reference is the cheque number), so the voucher
  balances. An account that nets to zero gets no line. Every row also yields an allocation row.
- **Single-row documents** (`payment`, `receipt`, `cash_depo`, `cash_with`, `bank_to_bank`, `b2b`):
  a balanced two-line voucher from the spec's debit and credit accounts; a negative amount swaps
  them. Contra vouchers carry no payment method. `payment.csv` rows with any non-zero GST
  amount are held back as `UNSUPPORTED_GST_SPLIT` until the tax split is modelled.
- **Settlements** (`set_det`): allocation evidence only. They produce rows in `allocations.csv`
  (voucher, party, invoice reference, amount) and no transaction lines.

## Party control roll-up

Eco Green's trial balance carries control balances, not one row per party, so party-level lines
are rolled up to a control ledger and the party is kept in `party_code`:

- A vendor line (code `V` plus digits, not itself a trial balance ledger) posts to `CTRL-AP`
  with the vendor as party. A customer line (`H` plus digits) posts to `CTRL-AR` with the
  customer as party.
- A trial balance code whose `group` is listed in a control's `tb_groups` posts to that control
  with no party; its balance columns are summed into one control row. Duplicate trial balance
  codes are merged the same way.
- `txn_count` per ledger is the number of distinct in-scope vouchers touching it.

## Exclusions and the bridge

Every raw row is either emitted or counted under exactly one reason: `OTHER_BRANCH`,
`CANCELLED`, `EXCLUDED_INVENTORY`, `ON_HOLD`, `UNKNOWN_PREFIX`, `BAD_DATE`, `BEFORE_WINDOW`,
`AFTER_WINDOW`, `ZERO_AMOUNT`, `UNSUPPORTED_GST_SPLIT`. `report.bridge` lists, per table,
`source_rows = emitted_rows + excluded_rows` and a `ties` flag, which must be true everywhere.
`report.exclusions` gives rows, documents and amount per table, prefix and reason.
`report.unknown_ledgers` lists ledger codes used by vouchers but absent from the trial balance, and
`report.unbalanced_vouchers` lists source documents that do not balance (they are still emitted).
A `SETTLEMENT` prefix found inside `jv_det` is currently counted under `UNKNOWN_PREFIX`.

## Open assumptions

- The debit and credit direction of `cash_depo`, `cash_with`, `bank_to_bank`, `payment` and
  `receipt` is a default, not yet confirmed against data (only supplier payments are confirmed).
  Correct it per profile through `simple_tables` before trusting those vouchers.
- Settlements are treated as allocation evidence with no ledger effect. This is unconfirmed.
- The trial balance has control accounts only, so Layer A reconciliation runs at control level,
  not per party.
- `txn_count` is derived from the in-scope transactions; the source does not supply it.
- Money must be 2dp; anything else stops the run with `MONEY_PARSE`.

## Data handling

Real extracts, profiles that name real branches, and normalised output are client financial data.
They live only under the gitignored `var/` directory and are never committed. Tests and examples
use synthetic values only (branch `PILOT01`, invented party and account codes).
