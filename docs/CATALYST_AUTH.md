# Catalyst Authentication for the AppSail console — research & decision

Access date for every source below: **2026-09-15** (today). This file is owned by the
Catalyst-Auth workstream (`src/server/auth_catalyst.js`, `src/server/routes/auth.js`,
`test/auth_catalyst.test.js`). It does not restate `docs/CATALYST_REFERENCES.md` (Data
Store / Stratus) or `DEPLOYMENT.md` §4c (AppSail deploy procedure) — see those for the
rest of the platform picture.

## 0. Empirically verified on the live Development AppSail origin (lead, 2026-09-15)

Probed `https://ecogreenmigrationconsole-50045897355.development.catalystappsail.in` with plain
HTTP GETs (no session):

| Path | Result | What it settles |
|---|---|---|
| `/__catalyst/sdk/init.js` | 200, `application/javascript`, 468 B: `catalyst.initApp({ project_Id, zaid, auth_domain: "https://accounts.zohoportal.in", is_appsail: true, ... })` | AppSail **does** serve the SDK init on its own origin (`is_appsail: true`), so a session established here is first-party to this origin — §3 item 1 is resolved. |
| `/__catalyst/auth/login` | 200, `text/html`, 3.1 KB hosted login page; loads only `https://static.zohocdn.com/catalyst-cdn/{css,js}/catalyst_hosted_login_page-*.min.*` and `https://static.zohocdn.com/catalyst/sdk/js/4.6.2/catalystWebSDK.js` | The platform serves a **hosted login page on the AppSail origin itself** (intercepted before Express — our helmet CSP does not apply to it). No login widget needs to be embedded in our pages; `AUTH_LOGIN_URL` = `<appsail-origin>/__catalyst/auth/login` is same-origin and leaks no ID that the page itself does not already expose. §3 items 2 and 4 resolved. |
| `/__catalyst/auth/signin` | 404 | Not a valid path. |

Consequences applied in this pass:
- `src/server/app.js` CSP `frame-src` tightened from the `https://*.zoho.com` guess to `'self'` + `https://accounts.zohoportal.in` (the observed `auth_domain`). `script-src` keeps `https://static.zohocdn.com` for the SDK bundle in case a page embeds it later.
- Deploy env: `AUTH_MODE=token,catalyst`, `AUTH_LOGIN_URL=https://<appsail-origin>/__catalyst/auth/login`, `AUTH_LOGOUT_URL` left unset until the sign-out path is observed (the UI clears the bearer token and calls `/auth/logout`, which 404s harmlessly when unset).
- Still unverified until a real user signs in: item 3 (`getCurrentUser()` throw-vs-null for no session — code handles both) and the post-login redirect target of the hosted page (expected: the `redirect_uri`/`service_url` query parameter — to be confirmed in the first manual sign-in and recorded here).

## 1. Decision

**Use Catalyst's Node SDK `userManagement().getCurrentUser()`, called with the
per-request app from `catalyst_runtime.js`'s existing `currentApp()`, gated behind
`AUTH_MODE` and composed with (never replacing) the existing bearer-token path.** Do
**not** enable AppSail's own `catalyst_auth: true` platform gate, and do **not** host the
login on the project's separate web-client domain
(`ecogreenmigration-60021033896.development.catalystserverless.in`). Instead, embed the
Catalyst Web SDK login widget **inside pages served by this same AppSail service**
(Embedded Authentication, not Hosted Authentication), so the login UI and the API it
calls are same-origin. This is the only architecture available without additional
token-exchange plumbing that has a chance of working given the cross-domain cookie
limitation documented in §3 below — but see §6, this is **not fully verified** for
AppSail specifically and needs an empirical check in Development before anyone relies
on it for a real login flow.

Rationale for rejecting the alternatives:

- **Hosted Authentication** (Catalyst-rendered Sign In/Sign Up/Password-Reset pages)
  lives on the project's own web-client/accounts domain, not on our AppSail domain. A
  session cookie set there does not carry to `https://ecogreenmigrationconsole-50045897355.development.catalystappsail.in`
  (separate origin) — see §3. Using it would require a server-side token exchange we are
  not building in this pass.
- **AppSail's `catalyst_auth: true` app-config.json flag** wraps the *entire* service
  behind Catalyst's own SSO layer at the platform/gateway level
  (`references/appsail-crossorigin.md` in the local `catalyst-appsail` skill, itself
  citing Catalyst's AppSail configuration behaviour). It is all-or-nothing — there is no
  documented per-route granularity — so it would also gate `GET /api/health` (must stay
  public per `app.js`'s own comment: "Unauthenticated, no IDs"), the new
  `GET /api/auth/config` (must stay public), and the existing bearer-token bot surface
  (which must never be touched by this change). Rejected.

## 2. Verified facts, with sources

| Fact | Source |
|---|---|
| `zcatalyst-sdk-node` 3.4.0 (installed) has **no** separate `authentication` module directory — user identity lives entirely on `UserManagement` (`app.userManagement()`), reached via `catalyst.initialize(req)` (user scope; admin scope only affects Data Store/ZCQL/Cache per `docs/CATALYST_REFERENCES.md`). | `node_modules/zcatalyst-sdk-node/lib/user-management/user-management.d.ts` (installed package, 2026-09-15) |
| `getCurrentUser(): Promise<ICatalystUser>` — no documented "throws vs returns null" contract in the typings themselves; the implementation (`user-management.js`) does a plain `GET /project-user/current` and returns `resp.data.data` — an unauthenticated/no-session request is expected to fail at the HTTP layer (the requester throws), not resolve to `null`. | `node_modules/zcatalyst-sdk-node/lib/user-management/user-management.js` (installed package) |
| `ICatalystUser` fields: `zuid`, `zaaid` (deprecated), `org_id`, `status`, `user_id`, `is_confirmed`, `email_id`, `first_name`, `last_name`, `created_time`, `modified_time`, `invited_time`, `role_details: { role_id, role_name }`. | `node_modules/zcatalyst-sdk-node/lib/utils/pojo/common.d.ts` |
| Web SDK: `catalyst.auth.isUserAuthenticated()` resolves `{ content: { email_id, user_id, first_name, ... } }` (note the `content` nesting) on success, rejects (401) when not logged in. `catalyst.auth.signIn('elementId', { redirect_url })` renders a login **iframe** with no default height (must be styled). `catalyst.auth.signOut(redirectUrl)` requires the redirect argument or it throws. `catalyst.auth.signUp(...)` requires `public_signup` enabled in the console (off by default). | Local `catalyst-authentication` skill, `references/auth-basics.md` (curated from Catalyst docs + prior verified incidents in sibling projects) |
| **Session cookies do not cross Catalyst service domains.** Functions (`*.catalystserverless.com`), AppSail (`*.catalystappsail.com`), and Slate (`*.onslate.com`) are separate origins; a cookie set by a login on one does not authenticate requests to another. Recommended fixes: host the auth flow on the same origin as the app, unify via domain mapping, or do a server-side token exchange. | Local `catalyst-authentication` skill, `references/auth-basics.md` |
| AppSail always gets its own `<service>-<ZAID>.catalystappsail.com` (or `.in` for this account's DC) subdomain, distinct from `*.catalystserverless.com`/`*.zohocatalyst.com` — this is exactly why Slate frontends need CORS configured to call AppSail APIs. | Local `catalyst-appsail` skill, `references/appsail-deploy.md` |
| `app-config.json` supports a `catalyst_auth` boolean. When `true`, Catalyst's own SSO layer wraps the AppSail service and intercepts unauthenticated requests platform-side; the local skill's guidance is to set it `false` (or omit it) "when using custom OAuth or any non-Catalyst auth" — implying it is a blunt, whole-service gate, not a per-route one. | Local `catalyst-appsail` skill, `references/appsail-crossorigin.md` |
| Embedded Authentication requires, in this exact order, `https://static.zohocdn.com/catalyst/sdk/js/<version>/catalystWebSDK.js` (main CDN bundle) then `/__catalyst/sdk/init.js` (project-specific init, same-origin relative path) — reversing the order or omitting the first script crashes `init.js` with `I18N is not defined` and `window.catalyst` is never set. | Local `catalyst-authentication` skill, `references/auth-basics.md`; corroborated by Catalyst's own embedded-authentication docs (`docs.catalyst.zoho.com/en/cloud-scale/help/authentication/native-catalyst-authentication/embedded-authentication/`, fetched 2026-09-15), which quote the same two script tags (CDN build `4.6.2` as of the fetch date) |
| Development environment: max **25** app users; no such cap after Production deployment. Every new project starts with **zero** app users — the console admin/collaborator is not an app user and `getCurrentUser()` returns `null`/errors for it. | Local `catalyst-authentication` skill, `references/auth-basics.md` |
| `X_ZOHO_CATALYST_ACCOUNTS_URL` and `X_ZOHO_CATALYST_CONSOLE_URL` are injected automatically into every AppSail instance's environment (alongside `X_ZOHO_CATALYST_ENVIRONMENT`, `X_ZOHO_CATALYST_LISTEN_PORT`, etc.). | Local `catalyst-appsail` skill, `references/appsail-deploy.md` |
| The gateway strips the `Authorization` header after its own validation and injects `x-zc-*` internal headers for the SDK to read — do not expect `req.headers.authorization` to reflect a Catalyst session; it never carries one. This is unrelated to, and does not conflict with, this app's own use of `Authorization: Bearer <token>` for the existing bot/human token path, which the Catalyst gateway does not intercept for AppSail (only Functions' `authentication: required` Security Rule does that interception, and this app is not a Catalyst Function). | Local `catalyst-authentication` skill, `references/auth-basics.md` |

## 3. What I could NOT verify (open questions)

These gaps are the reason `src/server/auth_catalyst.js`'s `resolveSession()` is written
defensively (any failure or empty response ⇒ treated as "no session", never thrown to the
caller, and the bearer-token path is completely unaffected) rather than assuming a
specific behaviour:

1. **Whether AppSail actually serves `/__catalyst/sdk/init.js` and injects the auth
   cookie/session for its own domain**, the way Catalyst Functions and Slate do. Every
   official tutorial and reference I could reach (`docs.catalyst.zoho.com/.../embedded-authentication/*`,
   the `leadmanager-appsail` tutorial series) either targets Functions/Slate explicitly
   or documents only the **console configuration steps**, not the request-time mechanics
   for an AppSail-hosted page. The one tutorial that does target AppSail
   (`docs.catalyst.zoho.com/en/tutorials/leadmanager-appsail/flask/enable-auth/`) covers
   only the console click-path (enable Embedded Authentication, add Zoho as a social
   provider) and explicitly defers the actual wiring to "scripts provided in the
   Configuration step," which are not present in the fetched page content.
2. **The exact iframe domain used by `catalyst.auth.signIn()`** (needed for a correct,
   *tight* CSP `frame-src`) is not stated in any fetched page. Docs only say "Authorized
   Domains" governs CORS/iframe access for *external* domains embedding *your* app — not
   the domain of Catalyst's own login iframe embedded *in* your app. Until this is
   confirmed empirically (e.g. by opening the browser network/console tab against the
   real Development project), the CSP change in this pass allow-lists `frame-src` for
   `https://*.zoho.com` and the project's own accounts URL pattern as a best-effort,
   documented as **unverified** — see §5.
3. **Whether `getCurrentUser()` throws or resolves to a falsy value for "no session".**
   The typings promise `Promise<ICatalystUser>` (not `ICatalystUser | null`), and the
   implementation makes a plain authenticated HTTP call with no visible null-guard, which
   suggests it **throws** (e.g. a 401 from the project-user API) rather than resolving to
   `null`. `resolveSession()` in `src/server/auth_catalyst.js` handles both shapes
   (`try/catch` around the call, plus a falsy/`no email_id` check on whatever value comes
   back) so this is safe either way, but which one actually happens in the real
   AppSail+Catalyst-session case is unconfirmed.
4. **Exact AUTH_LOGIN_URL / AUTH_LOGOUT_URL values for this project.**
   No page documents a stable, publicly-safe URL format for the hosted/embedded login
   entry point that avoids leaking the project ID or ZAID in the URL itself. This repo's
   convention (`docs/CATALYST_REFERENCES.md`, `DEPLOYMENT.md`) is to keep IDs out of
   anything unauthenticated (`GET /api/health` "Never includes any project/org/branch
   id"); `GET /api/auth/config` in this pass follows the same rule by simply relaying
   whatever `AUTH_LOGIN_URL`/`AUTH_LOGOUT_URL` an operator configures
   (or `null` if unset) rather than deriving/guessing a URL that might embed an ID.
5. **`registerUser`/`addUserToOrg` admin-scope requirement.** The Node SDK typings show
   both on `UserManagement`, with no scope annotation in the `.d.ts` itself;
   `docs/CATALYST_REFERENCES.md`'s own initialisation table says only Data
   Store/ZCQL/Cache honour the `admin` scope distinction, which would imply
   `registerUser`/`addUserToOrg` behave the same regardless of scope — but this is an
   inference, not a confirmed fact, and it was out of scope for this pass to test live
   (no user-provisioning endpoint was requested or built here).

## 4. Manual console steps an admin must perform

None of these can be done from code or CI; an admin/operator must do them in the
Catalyst console before `AUTH_MODE=catalyst` (or `token,catalyst`) is turned on for a
real deployment:

1. **Authentication → enable an authentication type.** Choose **Embedded
   Authentication** (not Hosted) for the reasons in §1. Hosted remains an option later if
   the domain-unification/token-exchange work in §6 is done.
2. **Authentication → Settings**: leave **Allow Public Signup** off unless self-service
   signup is actually wanted (`catalyst.auth.signUp()` silently fails until this is on —
   not used by this pass, which provisions `app_users` rows out-of-band and relies on
   Catalyst only for *identity*, via `getCurrentUser()`).
3. **Authentication → Users**: add each real human operator as a Catalyst app user
   (console "Add User", or the Node SDK's `registerUser`/`addUserToOrg` — this pass does
   not add a provisioning endpoint; use the console). Each user needs the app user role
   (the project's default `is_default: true` role — see the local `catalyst-authentication`
   skill's "First App User" section for the exact console/MCP steps).
   **Every Catalyst-authenticated human also needs a matching row in this app's own
   `app_users` table** (same email, `status: 'INVITED'` or `'ACTIVE'`) — Catalyst
   identity alone does not grant this console any role/branch scope; see §7.
4. **Authorized Domains** (Console → Authentication → Whitelisting, or equivalent): add
   this AppSail service's own origin
   (`ecogreenmigrationconsole-50045897355.development.catalystappsail.in`) if the console
   requires an explicit self-entry for the embedded widget's iframe/CORS to work same-
   origin. Not confirmed as strictly required for a same-origin embed (§3.2), but cheap
   to do and matches the platform's stated purpose for this section.
5. **Do NOT enable `catalyst_auth: true`** in `app-config.json` for this service — see
   §1. This is a deploy-time config file decision, not a console one, but it is listed
   here because it is easy for an operator following generic AppSail docs to add it by
   habit; doing so will break `GET /api/health` and the bot bearer-token path.
6. **Verify the redirect/callback origin** matches exactly (scheme + host, no trailing
   path surprises) whatever is configured in `AUTH_LOGIN_URL`'s target
   (Hosted) or embedded widget's `redirect_url` (Embedded) — a mismatch is the most common
   cause of `PATTERN_NOT_MATCHED` per the local skill's troubleshooting notes.

## 5. Env vars (AppSail `app-config.json` / deploy-time only — never committed with values)

| Var | Meaning | Default when unset |
|---|---|---|
| `AUTH_MODE` | `'token'` \| `'catalyst'` \| `'token,catalyst'` — which authentication path(s) `composeAuthenticate()` will try. | `'token'` (byte-for-byte the pre-existing behaviour: catalyst is never consulted) |
| `AUTH_LOGIN_URL` | Full URL of the hosted/embedded login entry point `GET /auth/login` 302s to. `null`/unset ⇒ `/auth/login` returns 404 `AUTH_MODE_NOT_ENABLED` and the console hides the "Sign in with Zoho" button. | unset (`null`) |
| `AUTH_LOGOUT_URL` | Same idea for `GET /auth/logout`. | unset (`null`) |
| `OWNER_BOOTSTRAP_EMAIL` | **Development only, one-time.** See §8. Enables the owner-bootstrap mechanism for a single matching Catalyst sign-in while no ACTIVE human admin exists yet; ignored entirely outside `environment === 'Development'`. Remove after the first admin is bootstrapped. | unset (mechanism disabled) |

## 6. CSP additions (this pass, `src/server/app.js` helmet block only)

Given the unresolved iframe-domain question in §3.2, the CSP change made in this pass is
deliberately scoped to what the Web SDK script tags themselves need, plus a best-effort,
explicitly-commented `frame-src` addition:

- `scriptSrc`: add `https://static.zohocdn.com` (the `catalystWebSDK.js` CDN — no
  `'unsafe-inline'`; `/__catalyst/sdk/init.js` is same-origin `'self'`, already allowed).
- `connectSrc`: add `'self'` is already present; no additional external `connect-src`
  origin is documented as required by the Web SDK for same-origin embedded auth (the SDK
  talks to `/__catalyst/*` paths on the current origin). Left unchanged beyond what
  `'self'` already covers, pending the empirical check in §3.1 — if that check shows the
  widget calling an external origin directly, this will need a follow-up.
- `frameSrc`: add `https://*.zoho.com` — **best-effort, unverified** (§3.2). Tightened to
  a specific accounts subdomain once the real iframe origin is confirmed in Development.

No `'unsafe-inline'` was added anywhere. Both new script tags are external `<script src>`
includes, not inline script, so the existing strict `scriptSrc` policy plus the one new
CDN origin is sufficient for them.

## 7. How this composes with the existing bearer-token model

This app's principal model (`src/server/auth.js`) is a flat `app_users`-style list keyed
by `token_sha256`, with `role`/`principal_type`/`branches` per CONTRACTS.md §H/§G.
Catalyst Authentication only ever proves **identity** (an email address, a Catalyst
`user_id`) — it carries no opinion about this app's roles or branch scoping. So
`authenticateSession()` in `src/server/auth_catalyst.js` treats a resolved Catalyst
session as nothing more than a verified email, then defers entirely to this app's own
`app_users` table (via the concurrently-developed `resolveDirectoryUser(store, { email })`)
to decide the role/principal_type/branches — exactly mirroring how the bearer path defers
to `token_sha256` lookups today. A Catalyst-authenticated email with no matching
`app_users` row (or an `INACTIVE` one) is refused with `403 USER_NOT_PROVISIONED`, never
silently granted a default role.

## 8. Owner bootstrap (Development only)

**Problem.** §4 above requires a human admin to add every Catalyst app user AND give
them a matching `app_users` row before they can sign in at all. That leaves a bootstrap
gap: the very first admin has no admin yet to provision them, and there is no HTTP
admin endpoint that can be called without already holding an admin bearer token
(`POST /api/admin/users` requires `auth.requireRole('admin')`). Owner bootstrap closes
that gap for a freshly-deployed Development app **without** any new HTTP endpoint and
without ever accepting a bearer token for it — it only ever runs inside the existing
Catalyst session path (`authenticateSession()` in `src/server/auth_catalyst.js`).

**Mechanism.** On every successful Catalyst sign-in, `authenticateSession()` calls an
internal `maybeBootstrapOwner()` step, gated by **all** of:

1. `environment === 'Development'` — the literal string, passed into
   `createCatalystSessionAuth({ ..., environment })` by the caller (e.g. `createApp()`).
   Any other value (`'Production'`, `'UAT'`, unset/`undefined`) disables it completely;
   this is checked before anything else, so a Production deploy never even queries the
   store for this.
2. The env var `OWNER_BOOTSTRAP_EMAIL` is set (private Catalyst/AppSail configuration —
   **never committed**, not even to `.env.example` with a real value).
3. **The latch is open**: no `app_users` row currently has
   `role='admin' AND principal_type='human' AND status='ACTIVE'`
   (`findActiveHumanAdmin(store)`). This is the durable, *data-driven* part of the
   gate — once any human admin is ACTIVE, this permanently returns false, **even if the
   env var is left set**. The env var alone can never re-open it; only deleting every
   ACTIVE human admin row would (and nothing in this codebase does that automatically).
4. The signed-in Catalyst email equals `OWNER_BOOTSTRAP_EMAIL`, compared
   case-insensitively and with both sides trimmed.

The pure decision (`shouldBootstrapOwner({ environment, ownerEmail, sessionEmail,
activeHumanAdminExists })`) and the latch query (`findActiveHumanAdmin(store)`) are both
exported from `src/server/auth_catalyst.js` for unit testing independent of HTTP.

**What happens on a match.** Before the normal `app_users` lookup:

- If an `app_users` row already exists for that email, it is promoted in place: `role`
  → `'admin'`, `branches_json` → `'["*"]'`, `status` → `'ACTIVE'`, `version` →
  `version + 1`. Its `id` never changes.
- Otherwise a new row is inserted: `id: 'owner-<sha256(email).slice(0,12)>'`,
  `display_name`: the Catalyst account's first+last name, or the literal `'Owner'` if
  Catalyst has neither, `role: 'admin'`, `principal_type: 'human'`, `status: 'ACTIVE'`,
  `branches_json: '["*"]'`, `created_by: 'owner-bootstrap'`, `version: 1`.
- Either way, one `USER.OWNER_BOOTSTRAP` audit event is emitted: `actor` and `entityId`
  are the app_users row's `id` (never the email — the hashed-actor convention already
  used for denies), `entityType: 'app_users'`, `reason: 'OWNER_BOOTSTRAP_EMAIL matched;
  no active human admin existed'`, and `before`/`after` are the row snapshots **with the
  `email` field stripped** — `audit.emit()`'s own `redact()` only scrubs
  token/secret-shaped keys, so this file strips `email` itself before the row ever
  reaches the audit payload.
- The request then continues through the existing `app_users` lookup immediately below,
  which now finds the row ACTIVE — the same sign-in proceeds as that admin. There is no
  separate "you are now the owner" response; `GET /api/auth/me` simply reflects
  `role: 'admin'`, `branches: ['*']`.

**Idempotence.** A second sign-in with the same email is a pure no-op: the latch is now
closed (an ACTIVE human admin exists), so `shouldBootstrapOwner()` returns `false`
before any write — no version bump, no second audit event.

**What it will never do:** create a second admin once one exists (even for the same
configured email pointed at a different Catalyst account), run outside Development,
run over HTTP, or log/audit the raw email anywhere.

**Owner procedure (do this once, on a fresh Development deploy with zero ACTIVE human
admins):**

1. In the Catalyst/AppSail console, set the environment variable
   `OWNER_BOOTSTRAP_EMAIL` to the exact email of the Zoho account that will be the first
   admin. Do **not** commit this value anywhere.
2. Sign in to the console once with that Zoho account (via the normal Catalyst
   Embedded Authentication flow — §1/§4 above).
3. Verify: `GET /api/auth/me` should now show `"role": "admin"` and
   `"branches": ["*"]`.
4. **Remove `OWNER_BOOTSTRAP_EMAIL` from the environment.** The data-driven latch
   already makes the mechanism permanently inert once step 2 succeeds, but removing the
   var closes the door at the configuration layer too, and avoids any confusion for a
   future reader of the deploy config about why it is still there.
