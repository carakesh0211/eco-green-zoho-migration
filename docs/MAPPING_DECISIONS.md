# Mapping decision register

Owner decisions on ledger-to-Books mapping, in the order they were taken. Each entry names
the source ledger (code and name as it appears in the Eco Green trial balance), the decision,
and what it changes in the mapping rules (`docs/ECOGREEN_SOURCE.md` §Building the Books
mapping). Codes and account names only; no balances, parties or transactions.

Target account ids are per Books organisation. A decision names the account; the id is
resolved when the mapping is rebuilt against the organisation being loaded.

| # | Date | Source ledger | Decision | Effect on rules | Status |
|---|---|---|---|---|---|
| 1 | 2026-10-08 | Bank ledgers `000939` Hdfc Bank-50200113215259, `000903` Indusind Bank-ho-650001857587, `000905` (name per the branch 461 trial balance) | Create matching accounts in the testing org, type `bank`, named exactly as the source ledger so the name match proposes them | `LEDGER_ACCOUNT` rules for the three codes after the accounts exist and the mapping is rebuilt | Accounts not yet created: no connector in the 2026-10-08 session reached org 60091274394 |
| 2 | 2026-10-08 | `002000` Sundry Debtors | Map to the Books account "Sundry Debtors" itself. There is no sub-account for it; the header is the target | `LEDGER_ACCOUNT` rule with `reviewer_target_id` set to the header account, overriding the builder's "group header" downgrade | Decided, rule not yet edited |
| 3 | 2026-10-08 | `002022` Sundry Debtors-collection Account | Confirmed: target "Sundry Debtors-Collection(Card & Upi)" | Approve the proposed `LEDGER_ACCOUNT` rule as is | Decided, rule not yet approved |
| 4 | open | `UR_REC` Chq Recd But Not Reconciled, `UR_PAY` Chq Paid But Not Reconciled (group "Bank Reconciliation A/c") | Awaiting the owner. Options put forward: (a) create two clearing accounts in Books with the same names, type `other_current_asset` / `other_current_liability`; (b) post these lines to the bank account they clear into and rely on Books bank reconciliation. Option (a) keeps Layer A and Layer C tying ledger for ledger and is the recommendation | Two `LEDGER_ACCOUNT` rules once decided | Open |

## Notes

- Decision 2: Zoho Books accepts transactions on a parent account; sub-accounts are a
  reporting grouping. The mapping builder still flags a header as `REVIEW` so that choosing
  it is always an explicit reviewer action, which this entry records.
- Decision 1: Books `account_code` is not the Eco Green ledger code and is never used for
  matching. Setting it to the source code on the new accounts is optional and harmless.
- Applying decisions 1 to 3 to the hosted store: edit `mapping-rules.json` or re-run
  `scripts/build-mapping.js` with the reviewer columns, re-upload (approved rows with
  unchanged targets are skipped), approve in the Mapping screen, then re-transform the run.
