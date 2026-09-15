# Catalyst platform references (verified 2026-09-14)

Official sources consulted before implementing the Data Store and Stratus adapters.
Access date for every link: **2026-09-14**. The older Tally-tool `CATALYST_NOTES.md` was
used only as a secondary hint; every fact below was re-checked against these sources or
against the installed SDK package itself.

## SDK identity

| Item | Fact | Source |
|---|---|---|
| Current Node SDK | `zcatalyst-sdk-node` **3.4.0** (`dist-tags.latest`, modified 2026-04-20) — not deprecated on npm | `npm view zcatalyst-sdk-node` (2026-09-14) |
| v2 docs deprecation banner | The v2 docs pages carry "This SDK is currently in deprecation. Migrate to JavaScript SDK now." The modular JS SDK (`@zcatalyst/datastore` 0.0.3, `@zcatalyst/stratus` 0.0.5, `@zcatalyst/zcql` 0.0.2) is still 0.0.x | https://docs.catalyst.zoho.com/en/sdk/nodejs/v2/overview/ ; `npm view @zcatalyst/*` |
| Decision | Use `zcatalyst-sdk-node` 3.4.0 behind an injectable transport so the modular SDK can replace it without touching adapter logic | this repo, `src/adapters/store/catalyst.js`, `src/adapters/archive/stratus.js` |

## Initialisation (from the 3.4.0 package source, `lib/catalyst-namespace.js`, `lib/utils/credential.js`)

- Inside functions/AppSail: `catalyst.initialize(req)` / `initialize(context)`; scope `{ scope: 'admin' | 'user' }` (scopes affect Data Store and ZCQL only).
- Outside Catalyst: the SDK reads env `CATALYST_CONFIG` (JSON or file path with `x-zc-projectid`, `x-zc-project-key`, `x-zc-environment`, `x-zc-project-domain`) and `CATALYST_AUTH` (JSON `{client_id, client_secret, refresh_token}` → refresh-token OAuth credential). **This requires an OAuth self-client credential, which has not been provisioned for this project** — local live smoke therefore runs through the authenticated Catalyst MCP, not the SDK.

## Data Store

| Item | Fact | Source |
|---|---|---|
| Methods | `app.datastore().table(nameOrId)` → `insertRow`, `insertRows`, `getRow(id)`, `getPagedRows({nextToken,maxRows})`, `getIterableRows`, `updateRow`, `deleteRow`; `app.zcql().executeZCQLQuery(sql)` | package typings `lib/datastore/table.d.ts`, `lib/zcql/zcql.d.ts`; https://docs.catalyst.zoho.com/en/sdk/nodejs/v2/cloud-scale/data-store/insert-rows/ ; https://docs.catalyst.zoho.com/en/sdk/nodejs/v2/cloud-scale/zcql/execute-zcql-query/ |
| ZCQL row cap | max **300 rows** per SELECT/UPDATE/INSERT/DELETE; paginate with LIMIT/OFFSET | https://docs.catalyst.zoho.com/en/cloud-scale/help/zcql/syntax-exceptions/ |
| ZCQL `OFFSET` is 1-based | `SELECT … ORDER BY ROWID LIMIT 3 OFFSET 0` and `… OFFSET 1` return the same first three rows; `… OFFSET 3` starts AT the third row (the last row of the previous page). A 0-based paginator therefore repeats one row per page boundary (observed: a 351-row `branch_summaries` read returned 352 rows, `EG-0158` twice). `src/adapters/store/catalyst.js` translates the Store's 0-based `offset` to `OFFSET offset+1`; the fake mirrors the 1-based semantics; regression test in `test/store_catalyst.test.js` (700 rows). Every paged SELECT also carries an `ORDER BY …, ROWID` tiebreak. | Live ZCQL via Catalyst MCP `Execute_Query`, Development, 2026-09-15 |
| ZCQL SELECT column cap | max **30 selected columns** per SELECT (`SELECT *` counts its expansion) — error text: `"More than 30 select columns are not allowed"`. Not listed on the syntax-exceptions page fetched 2026-09-14 above; hit live when the synthetic seed's CLASSIFY_TRANSFORM stage selected all 43 columns of `vouchers`. `src/adapters/store/catalyst.js` splits a wide SELECT into <=30-column chunks (ROWID in every chunk) and re-joins by ROWID; `src/adapters/store/catalyst_fake.js` enforces the same cap. | observed live (Development), **2026-09-15** |
| Columns per table | max **100** | https://docs.catalyst.zoho.com/en/cloud-scale/help/data-store/tables/ |
| Development quotas | **5,000 rows per table**, **25,000 rows per project** in the Development environment | https://docs.catalyst.zoho.com/en/faq/cloud-scale/ |
| Column types (console/API) | `varchar` (max_length, is_unique), `text` (no unique/index/max_length), `int`, `bigint` (is_unique), `double`, `boolean`, `date`, `datetime`, `encrypted text`, `foreign key` | Catalyst MCP `CatalystbyZoho_Create_Column` schema (2026-09-14) |
| Composite uniqueness | not available → synthetic `uk` varchar column with `is_unique` (kept from schema.sql) | Create_Column schema (single-column `is_unique` only) |
| IaC | `iac:import` **creates a new project**; existing projects get additive columns via console/API | https://docs.catalyst.zoho.com/en/cli/v1/export-and-import-projects/introduction/ ; observed CLI behaviour |

## Stratus

| Item | Fact | Source |
|---|---|---|
| Methods | `app.stratus().bucket(name)` → `putObject(key, body, options)`, `getObject(key,{versionId})` (Readable), `headObject(key,{versionId,throwErr})` → boolean, `listPagedObjects`, `listPagedVersions`, `generatePreSignedUrl(key,'PUT'|'GET')`; `stratus.headBucket(name)` | package typings `lib/stratus/bucket.d.ts`, `lib/stratus/index.d.ts`; https://docs.catalyst.zoho.com/en/sdk/nodejs/v2/cloud-scale/stratus/overview/ |
| Bucket features | versioning (version IDs per object), encryption at rest and in flight, audit logs of every object access (audit consent), malware scanning, protected (authenticated) vs public buckets | https://docs.catalyst.zoho.com/en/cloud-scale/help/stratus/introduction/ ; https://docs.catalyst.zoho.com/en/cloud-scale/help/stratus/stratus-permissions/ |
| Bucket creation flags (API) | `bucket_meta: { type: 'protected'|'public', encryption, versioning, audit_consent, caching }` | Catalyst MCP `CatalystbyZoho_Create_Bucket` schema (2026-09-14) |
| Object key limit | `object_key` max **255** characters (API) | Catalyst MCP `Head_Object` / `Get_Object` schema |
| `listPagedObjects` contract | Options `{ prefix?, continuationToken?, maxKeys?, folderListing?, orderBy? }` (sent as qs `prefix`, `continuation_token`, `max_keys`, `folder_listing`, `order_by`); resolves to `{ key_count, max_keys?, truncated: 'true'\|'false', next_continuation_token?, contents }` where `bucket.js` wraps each entry as `StratusObject` (key at `keyDetails.key`). It is **not** the Table `getPagedRows` shape (`more_records`/`next_token`) — an adapter that assumed that shape saw an empty listing on live Stratus and let a different-bytes put through (fixed 2026-09-15; `src/adapters/archive/stratus.js` now fails closed with `LIST_SHAPE_UNEXPECTED` when `contents` is absent) | package `lib/utils/pojo/stratus.d.ts` (`IStratusPagedObjectOptions`, `IStratusObjects`), `lib/stratus/bucket.js`, `lib/stratus/object.js`; live `POST /api/dev/archive-smoke` on Development (2026-09-15) |
| First-bucket creation | `Create_Bucket` via API/MCP returns `OPERATION_NOT_ALLOWED` until the project owner opens Stratus in the console once; the first bucket was created through the console form. Bucket `ecogreen-pilot-evidence-dev`: protected, encryption on, versioning on, audit on, caching disabled (confirmed by `Get_Bucket_Details`) | Catalyst console, 2026-09-15 |
| `getDetails()` / `headBucket()` contract (readiness check) | `bucket.getDetails(): Promise<IStratusBucket>` → `{ bucket_name, bucket_url?, objects_count?, size_in_bytes?, bucket_meta?: { versioning, caching: { status }, encryption, audit_consent } }`; **no `protected`/`type` field** on this response shape, despite the Create_Bucket API accepting `bucket_meta.type` at creation time (row above) — that field is not documented as echoed back by `getDetails()`, so `src/adapters/archive/stratus.js`'s `verify()` maps `protected` to `null` rather than guessing. `stratus.headBucket(bucketName)` → `boolean` only (no metadata) — used as the fallback when `getDetails` is unavailable, so `verify()` then reports every flag field as `null` too. Backs the `ENABLED_VERIFIED`/`ENABLED_UNVERIFIED` split in `/api/health` (`src/server/archive_health.js`) | package typings `lib/stratus/bucket.d.ts` (`getDetails`), `lib/stratus/index.d.ts` (`headBucket`), `lib/utils/pojo/stratus.d.ts` lines 93-116 (`IStratusBucketMeta`, `IStratusBucket`) |

## Not verified / open

- Maximum object size and per-project bucket count (not stated on the pages fetched).
- Whether `putObject` on a versioned bucket returns the new `versionId` synchronously (typings return `boolean`).
- Modular `@zcatalyst/*` SDK API surface (0.0.x; not adopted).
