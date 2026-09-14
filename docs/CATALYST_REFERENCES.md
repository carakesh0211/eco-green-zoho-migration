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

## Not verified / open

- Maximum object size and per-project bucket count (not stated on the pages fetched).
- Whether `putObject` on a versioned bucket returns the new `versionId` synchronously (typings return `boolean`).
- Modular `@zcatalyst/*` SDK API surface (0.0.x; not adopted).
