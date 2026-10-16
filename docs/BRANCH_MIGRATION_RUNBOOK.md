# Branch migration runbook – transactions and closing reconciliation

How one branch's migration-window transactions (opening date + 1 to the branch's cut-off) are
pushed to Zoho Books and reconciled. Proven on branch 460 in the test organisation; this is the
procedure for the live organisation. Every step reads or writes local files under `var/`
(git-ignored); only `preflight`, `post`, `apply` and `fetch` call Books.

## Order of work for a branch

1. Opening balances are in Books (live: uploaded manually; test: `scripts/opening-balance.js`).
2. Smart Pharma pushes its prefixes for the window (S, T, L, K, I, N, G, JT …), on contacts that
   already carry their Eco Green group's receivable / payable account.
3. We push our vouchers (rows with "To be pushed by" = ZOHO): steps B–E below.
4. Closing reconciliation: step F.

## Inputs (branch WorkDrive folder → `var/raw<branch>/txn/`)

| File | Use |
|---|---|
| `Ledger_<from>_to_<to> V2.xlsx` | every ledger line of the window, both owners, with narration and "To be pushed by" |
| `supplier_payment_details_act.csv` | Eco Green's payment → bill / debit note allocations |
| `invoice_receipt_det_act_<br>.csv` (zip when over 5 MB) | Eco Green's customer settlements (E knock-offs) |
| `Closing_tb_report_<to>.xlsx` | closing TB (Op / Tran / Cl per ledger) |
| opening plan `var/opening/<br>/plan.json` | the opening open items (customer traces, supplier working file, branch balances) |
| `accounts_zoho.csv` | our ledgers → Zoho account codes (written by step A, filled once) |

## A. Plan (no Books calls)

```
node scripts/txn-plan.js --branch <br> --ledger <ledger V2.xlsx> --opening var/opening/<br>/plan.json \
  --supplier <supplier csv> --customer <customer csv> --from <opening date + 1> --to <cut-off> \
  --out var/txn/<br> --account-map var/txn/<br>/accounts_zoho.csv
```

All checks must read OK: dates inside the window, every voucher balanced, one date per voucher,
every ledger mapped. Outputs: `report.md`, `applications.csv` (each receipt / payment → document),
`exceptions.csv`, `accounts.csv` (our ledgers to map), `accounts-all.csv` (every ledger, for the
reconciliation once Smart Pharma's side is in Books).

Rules built into the plan:
- Ownership is the "To be pushed by" column; Smart Pharma's vouchers are never posted by us.
- Date cells Excel turned into mm/dd dates are swapped back (`--excel-dates asis` if not).
- `#NAME?` ledger codes are keyed by ledger name; code 0 / type 3 is HO (Sundry Debtors – Inter
  Branch, contact 000).
- A party's control is its ledger group (`c_grp_no`, last six digits → e.g. 001005 Sundry
  Creditors-Expenses).
- Kinds: receipt (one customer credited), payment (one vendor debited), bill (one vendor
  credited – liabilities booked by journal), journal (everything else). Party lines that cancel
  inside a voucher (PhonePe / ONGC payment control) drop out.
- Application of receipts / payments: Eco Green's own settlement first (exact); knock-offs of
  documents older than the opening list go to the party's opening balance item (net opening);
  then the oldest opening item of the party; the rest stays unapplied (advance / excess payment).

## B. Preflight (Books reads only)

```
node scripts/txn-post.js preflight --out var/txn/<br> --account-map var/txn/<br>/accounts_zoho.csv \
  --opening var/opening/<br> --clearing-account-id <cash clearing account id> \
  --location <the branch's Books location id>
```

Resolves every Zoho account, contact, journal party control and the clearing account; checks
that **every contact carries its Eco Green group's receivable / payable account** (blank or wrong
stops the run: `contact-controls.csv`); finds the documents payments are applied to by number –
Smart Pharma's convention `<branch>/<yy>/<prefix>/<000000>`, the opening's own number, or
`--doc-numbers` (`doc,party,books_number`), on the number or the reference# of the party's own
documents. Opening documents not found stop the run (`documents-not-found.csv`; the party's open
documents are listed in `document-candidates.csv` to name them) unless `--allow-missing-docs`.
`--location` is required when the opening was resolved in another organisation (test → live);
bill lines take the organisation's exemption named OPENING unless `--tax-exemption-id`. `preflight.md` must list no problems.
Test organisation only: `--contact-controls skip`.

## C. Smoke test, then full post

Posting needs the application's guard (`BOOKS_DRIVER=live`, `POSTING_ENABLED=true`,
`POSTING_AUTHORIZATION_REF`), `BOOKS_ORG_ALLOWLIST` naming only the target organisation, and
`--confirm-org` with its id.

```
node scripts/txn-post.js post --out var/txn/<br> --confirm-org <org id> --per-kind 1   # check these in Books
node scripts/txn-post.js post --out var/txn/<br> --confirm-org <org id>
```

Order: our bills, journals, customer payments, vendor payments, credit / debit note set-offs.
A receipt / payment whose counter-entry is one cash / bank account posts directly; otherwise
it goes through the clearing account plus a journal to the voucher's own ledgers (the clearing
account must end at nil). Every voucher carries reference `<branch>/<yy>/<prefix>/<000000>` and
is looked up before it is created: a stopped run (rate block, daily limit, unconfirmed write) is
simply run again. `post-log.jsonl` records every write.

## D. Apply (pass 2)

Applications to documents not yet in Books at post time (`waiting.csv`) wait as unused credit.
Once those documents are in Books: rerun preflight, then

```
node scripts/txn-post.js apply --out var/txn/<br> --confirm-org <org id>
```

Adds them to the payments already posted (never beyond a payment's unused amount) and makes the
pending credit / debit note set-offs. Safe to rerun.

## E. Checks after posting

- Clearing account: nil.
- `post-log.jsonl`: no FAILED / UNKNOWN lines; POSTED counts per module match the plan.

## F. Closing reconciliation (₹1 tolerance)

```
node scripts/txn-recon.js fetch  --out var/recon/<br> --to <cut-off> --location <location id>
node scripts/txn-recon.js report --out var/recon/<br> --to <cut-off> --closing-tb <closing TB.xlsx> \
  --ledger <ledger V2.xlsx> --opening var/opening/<br> --txn var/txn/<br> \
  --posted all --account-map var/txn/<br>/accounts-all.csv --strict-controls
```

- **A** Eco Green closing TB movement vs the ledger table, per TB code (the file is complete).
- **B** Books trial balance vs opening + posted lines, per Zoho account; with `--strict-controls`
  every Sundry Debtors / Creditors account must tie on its own (contacts carry their group's
  account). Without it (test organisation), the receivable / payable accounts tie as a group.
- **C** every customer / vendor: Books net balance (open documents less unused credits) vs
  opening documents + posted lines; Eco Green's closing per party alongside.

`--posted ours` (default) reconciles only our side (test organisation, where Smart Pharma did not
push). Exit code 0 = everything ties; `recon.md`, `integrity.csv`, `tb.csv`, `parties.csv`.

## Decisions on record

| Topic | Decision |
|---|---|
| Opening | Net opening: open items as per Eco Green's traces; a party's TB balance not in the list is its opening balance item |
| Previous-year knock-offs in the window | Applied to the party's opening balance item |
| Receipts / payments without an Eco Green settlement | Oldest opening item of the party, rest unapplied |
| Narration | `c_remarks`; when empty, "<Kind> <prefix>/<no> – <party or ledger>" |
| HO / inter-branch (code 0) | Sundry Debtors – Inter Branch Transaction (FRP0026G), contact 000 |
| Receivable / payable controls | Live: each contact carries its Eco Green group's account; test org: Books defaults |
| Clearing account | Opening Advances Clearing (cash), nets to nil |
| Tolerance | ₹1 per account and per party |
