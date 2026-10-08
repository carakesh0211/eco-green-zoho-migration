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

## Settlements drive the set-off (owner decision, 2026-10-02)

A settlement (`E`) passes no ledger entry of its own, but it is the record of which credit
(receipt, journal, credit note, advance) was set off against which outstanding document.
That set-off must be reproduced in Zoho Books by applying the credit to the bill or invoice,
so `allocations.csv` is a required input of the apply-credit step, not optional evidence.

Each allocation row carries:

| column | meaning |
|---|---|
| `side` | `CREDIT` when the amount is negative (the credit being consumed), `OUTSTANDING` when positive (the document being cleared) |
| `ref_prefix` | prefix of the referenced document |
| `ref_in_run` | `YES` when the referenced document is one of the vouchers in this run, `NO` when it is not (already in Books, or dated outside the window), `AMBIGUOUS` when more than one voucher matches |
| `ref_voucher_id` | the matching voucher when `ref_in_run` is `YES` |

`normalisation_report.json` summarises these under `output.allocations_by_ref`.

The cut-off date is inclusive: a branch migrated on a given date includes documents dated
that day (day end).

## Ledger-table format (second delivery format)

From 2026-10-07 a branch may arrive as three files instead of raw table dumps. Set
`"format": "ledger-table"` in the profile (template: `config/source-profiles/ecogreen-ledger-table.example.json`);
`scripts/normalise-ecogreen.js` dispatches on it, and the module is `src/sources/ecogreen/ledger_table.js`
(`.xlsx` is read by the dependency-free `src/sources/ecogreen/xlsx.js`; `.csv` is accepted too, and the
format is recognised from the bytes, not the file name).

| Profile field | File |
| --- | --- |
| `ledger_file` (default `ledger.xlsx`) | One table of every transaction of the period, one row per account line: `c_br_code`, `c_year`, `c_prefix`, `d_date`, `n_tran_no`, `c_act_code`, `act_name`, `Debit`, `Credit` (negative, or a positive magnitude; see *Credit sign* below), `c_opp_act_code`, `opp_act_name`, plus the helper columns below |
| `closing_tb_file` (default `closing_tb.xlsx`, required) | Trial balance report as at the cut-off: opening, transactions and closing per account |
| `opening_tb_file` (default `opening_tb.xlsx`, optional) | The same report as at 31 March, used only to check the year-end carry-forward |

Both reports have a few title rows, then the `Act Code` header row (`Description`, `Op.Debit`, `Op.Credit`,
`Tran. Debit`, `Tran. Credit`, `Cl.Debit`, `Cl.Credit`, ...), group-heading and total rows with no Act Code
(ignored), and account rows. Repeated Act Codes are summed.

**Helper columns.** `To be pushed by` says who posts the document: rows equal to `pushed_by_value` (default
`ZOHO`, case, spacing and punctuation ignored) are migrated by us; rows pushed by another party
(Smartpharma) are already or will be in Books and are not emitted. `Status` is, for a party line, the name
of the control ledger the party belongs to. A party code that is not an account in the trial balance is posted to the
trial-balance ledger whose `Description` matches `Status` (case and punctuation ignored); `party_code`
and `party_name` (`act_name`) are kept on the line. `control_aliases` in the profile maps a `Status` name the
trial balance does not carry to a ledger code. An unresolved `Status` keeps the raw code on the line and is listed
in `report.unknown_controls`.

**Vouchers.** A document is `c_year/c_prefix/n_tran_no`; `c_br_code` is ignored, so the lines of one document that
carry different branch codes (for example `0` and the branch) join into one voucher. The voucher type comes from
`prefix_types`. Net amount per line is `Debit + Credit` when the source writes credits as negatives, or `Debit - Credit`
when it writes both columns as positive magnitudes (the branch 460 delivery of 2026-10-08 does); positive is a debit
line, negative a credit line. Lines of one document with different dates take the earliest.

**Credit sign.** `credit_sign` in the profile is `auto` (default), `negative` or `positive`. Under `auto` the
convention is read from the non-footer rows: only negative credits (or none) means `negative`, only positive credits
means `positive`, and a column that mixes both stops the run with `CREDIT_SIGN_AMBIGUOUS` instead of guessing per row.
The outcome is `report.credit_sign` (`sign`, `source` = `detected` or `profile`, and the positive and negative cell
counts). A wrong convention shows up as every voucher unbalanced and the trial balance ties failing on every ledger
we touch, so the report is the first thing to check on a new delivery.

**Excel date damage and the repair rule.** The extractor writes `dd/mm/yy` text, but opening the file in Excel turns
some of it into real dates with day and month swapped (9 April read as 4 September). Text dates are parsed as
`dd/mm/yy` and never changed. Date-typed cells are read as they are; if that leaves any date-typed cell outside the
profile window and reading every one of them with day and month swapped puts all of them inside, the swapped reading is
used for all date-typed cells. Otherwise nothing is changed. The outcome is `report.date_repair`
(`swapped_day_month`, and the counts of cells outside the window under each reading).

**Trial balance emitted to the contract.** Because Smartpharma's documents are already in Books, each ledger is built
as: opening = Eco Green opening plus the other pusher's movement (what Books holds before our documents), period debit
and credit = the gross sides of our emitted lines (Layer A compares gross sides, not the net), closing = the Eco Green
closing. Opening plus our period then equals the Eco Green closing whenever the whole population ties, so Layer A can
pass; any gap shows up as a Layer A failure on that ledger.

**`trial_balance_components.csv`** is the proof behind that construction: per ledger the signed (debit positive)
`opening`, `movement_other_pusher`, `movement_ours`, `closing`, the report's own `closing_report_movement`, `difference`
(opening + both movements - closing), `in_trial_balance` and `ties` (`YES` only when the difference is nil and the
report movement equals the table movement). `report.trial_balance_ties` summarises it and lists failing ledgers.

**Exclusions and the bridge.** Every ledger row is emitted or excluded under exactly one reason: `FOOTER` (no prefix
or no transaction number: totals and trailing rows), `PUSHED_BY_OTHER`, `PUSHED_BY_UNKNOWN` (blank pusher),
`UNKNOWN_PREFIX` (not in `prefix_types`), `BAD_DATE`, `OUT_OF_WINDOW` and `ZERO_AMOUNT`. `report.bridge` ties when
source rows equal emitted plus excluded rows; `report.exclusions` gives rows, documents and gross amount per prefix and
reason. Rows pushed by us but excluded still count in the ledger movement above, so they surface as tie or Layer A
differences rather than disappearing. `report.opening_differences` lists ledgers whose 31 March closing differs from the
1 April opening (year-end closing of income and expense accounts is expected there); it is empty when no opening file
is supplied. `report.unbalanced_vouchers` lists documents split between pushers.

**Books structure (owner decision).** Books carries one sub-account per Eco Green control ledger under Accounts
Receivable or Accounts Payable, with the party as the contact. The emitted `ledger_code` therefore stays the Eco Green
control code and the party is carried in `party_code` and `party_name`; no per-party ledger is created.

## Building the Books mapping

`scripts/build-mapping.js` proposes the mapping rules (`MODULE_ROUTE`, `LEDGER_ACCOUNT`, `PARTY`) for a normalised run
from Books reference data. The matching lives in `src/core/mapping_proposals.js` (pure functions, no store, no I/O).

```
node scripts/build-mapping.js --run <normalised-run-folder> --books-ref <folder with accounts.json + contacts.json> \
  --org <books org id> --out <folder> [--mapping-version map_test_v1] [--effective-from 2026-04-01] \
  [--threshold 0.8] [--decided-on 2026-10-08]
```

**Inputs.** The run folder supplies `transactions.csv` and `trial_balance.csv` (and `manifest.json` for the run id in the
report). Ledger names come from the trial balance, falling back to the transactions. Only ledgers that appear in the
transactions are mapped (`usage_count` = transaction lines using the ledger); the report counts the trial-balance-only
ledgers. Parties come from the transactions (`party_code`, `party_name`, usage, the distinct ledgers they sit under).
Voucher types are the distinct `voucher_type` values. The Books reference data is projected from the Books API outside
the app: `accounts.json` (`account_id, account_name, account_code, account_type, parent_account_id, parent_account_name,
depth, is_active, is_system_account`) and `contacts.json` (`contact_id, contact_name, company_name, contact_type,
customer_sub_type, status, gst_no, vendor_name`).

**Name matching.** Books account codes are a different numbering from the source ledger codes, so accounts are matched by
**name only**, never by `account_code`. Names are normalised first: upper-case; abbreviations expanded before
punctuation is stripped (`CGSTTDS`/`SGSTTDS`/`IGSTTDS` to `CGST TDS` etc., `FY-2025-2026`/`FY-25-26` to `FY 25 26`,
`RECD` to `RECEIVED`, `CHQ` to `CHEQUE`, `AGST`/`AGT` to `AGAINST`, `R&M`, `P&S`, `S&D`, `R&T`, standalone `HO` to
`HEAD OFFICE`, `A/C` to `ACCOUNT`); then every non-alphanumeric run becomes one space. Digit runs (bank account numbers)
are kept. The similarity of two normalised names is `0.6 * Dice(character bigrams, spaces removed) + 0.4 * token Jaccard`.
The candidate pool holds only active Books accounts whose name does not contain `DO NOT USE` / `DO_NOT_USE`.

**Statuses.**

| status | meaning | rule produced |
|---|---|---|
| `EXACT` | exactly one pool entry has the same normalised name (score 1) | yes |
| `AMBIGUOUS` | several pool entries have the same normalised name; all listed, none chosen | no |
| `FUZZY` | no exact match, best score at least the threshold (default 0.8) and at least 0.05 ahead of the runner-up | yes |
| `REVIEW` | best score at least 0.5 but not a safe pick, or the proposed Books account is a group header | no |
| `NONE` | nothing scores 0.5 | no |
| `ACCOUNT` | (parties only) the party is itself a GL account in Books | yes |

A proposal that lands on a Books account that has child accounts (an upper-case `SUNDRY DEBTORS` header over
`Sundry Debtors-Corporate`, say) is downgraded to `REVIEW` with the note "Books account is a group header; choose a
sub-account". Nothing is proposed against inactive or `DO NOT USE` accounts.

**Parties.** A party is first checked against the active, non-placeholder accounts: if its code equals a Books
`account_code` (case-insensitive) or its normalised name equals an account's normalised name, and exactly one account
matches, the party maps to that **account** (`ACCOUNT`, `target_meta.kind` is `account`). These are the payment clearing
accounts whose Books code is the source party code; the transform posts such a party on the line instead of the ledger
account. If several accounts match the party is `AMBIGUOUS` (kind `account`). Otherwise the party is matched against
active contacts by normalised `contact_name` with the same `EXACT` / `AMBIGUOUS` / `FUZZY` / `REVIEW` / `NONE` rules; the
row carries `kind` `contact` and the target's `contact_type`.

**Outputs** (in `--out`):

- `mapping-rules.json`: an array of rule rows for `POST /api/mappings`. Every row is `DRAFT`, `effective_to` null,
  `approved_by` null; `target_meta` is an object (the API stringifies it). `MODULE_ROUTE` has one row per voucher type with
  target `journal`; every type except `JOURNAL` carries the owner-decision note the transform requires for a journal
  fallback (dated by `--decided-on`, default today). `LEDGER_ACCOUNT` rows exist for `EXACT` / `FUZZY` accounts and carry
  `account_name`, `account_type`, `parent_account_name`, `books_org_id` and the `match` (status, score, source name,
  usage). `PARTY` rows exist for `EXACT` / `FUZZY` / `ACCOUNT` parties and carry `kind`, the target name and type,
  `books_org_id` and the `match`.
- `review-accounts.csv` and `review-contacts.csv`: the review sheets, columns `source_key, source_name, usage_count,
  status, [kind, contact_type (contacts only),] proposed_target_id, proposed_target_name, target_type, target_parent,
  score, candidate_2, candidate_3, note, reviewer_decision, reviewer_target_id`. The last two are left blank for the
  reviewer. Where no target is proposed (`REVIEW`, `AMBIGUOUS`, `NONE`) the proposed columns show the best candidate for
  the reviewer, and the status says it was not proposed. Candidates read `name [id] score`.
- `mapping-report.json`: run id, `books_org_id`, mapping version, counts by status for accounts and contacts, rule
  counts, the module routes and `generated_at`. Counts only, no names.

The sheets carry real ledger, party and Books names, so inside this repository the output may only go under `var/`.

**Loading and approval.** The rules are uploaded as `DRAFT` with `POST /api/mappings`, never approved by the script. The
reviewer works through the sheets, fixes the non-proposed rows (and anything wrongly proposed) and approves the rules in
the console (Mapping screen). Nothing posts until the rules it needs are `APPROVED`.

**Target ids are per Books organisation.** `account_id` and `contact_id` belong to one Books organisation. A mapping built
against the testing organisation is not valid for the live organisation: rebuild it from the live organisation's
reference data (a new `--org` and a new `--mapping-version`) and re-review it. `books_org_id` is kept in each rule's
`target_meta` so the origin is never in doubt.

**Books `account_code` is not the source ledger code.** It is never used to match a ledger. The one use of
`account_code` is the party-as-account check above, where Books holds a clearing account coded with the source party code.
