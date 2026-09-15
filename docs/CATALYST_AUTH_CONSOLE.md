# Catalyst Native Authentication (Hosted, Zoho sign-in) — Console Guide for EcoGreenMigration (Development)

Research date / access date for all cited URLs: **2026-09-15**. All facts below come from the official Zoho Catalyst documentation site (`docs.catalyst.zoho.com`) unless explicitly marked UNVERIFIED. No application code was read or edited to produce this document.

---

## A. Exact owner console steps — Enable Hosted Authentication with Zoho sign-in

These steps reproduce the documented Hosted Authentication setup wizard [VERIFIED — Catalyst Docs, "Configure Hosted Authentication for the Application" (Node.js tutorial), https://docs.catalyst.zoho.com/en/tutorials/hosted-login-app/nodejs/configure-hosted-login/, accessed 2026-09-15; corroborated by "Hosted Authentication Type — Introduction", https://docs.catalyst.zoho.com/en/cloud-scale/help/authentication/native-catalyst-authentication/hosted-authentication-type/introduction/, accessed 2026-09-15]. Perform these in the **Development** environment of the EcoGreenMigration project.

1. Open the Catalyst console for the project, switch to the **Development** environment.
2. Go to **Cloud Scale → Authentication** (listed under "Security & Identity"). [VERIFIED, same source]
3. In the **Native Catalyst Authentication** section, click **Set Up**. [VERIFIED, same source]
4. On the type-selection screen, choose **Hosted** (vs. **Embedded**) and click **Next**. [VERIFIED — matches the "Hosted vs Embedded" first step referenced in the task and confirmed by the tutorial's step sequence]
5. **Configure Hosted Login** screen:
   a. Enter your organization's name in the **Company Name** field (required). [VERIFIED]
   b. Optionally upload a **Company Logo** image. [VERIFIED]
   c. Use the color/branding controls to style the Sign In / Sign Up / Password Reset pages; a live **Preview** pane shows the three pages. [VERIFIED]
   d. Toggle **Public Signup** on if you want end-users to self-register; a confirmation pop-up ("Yes, Proceed") appears. For EcoGreenMigration, decide this per pilot plan — see Section C for what turning it off means. [VERIFIED — https://docs.catalyst.zoho.com/en/cloud-scale/help/authentication/public-signup/, accessed 2026-09-15]
   e. Under **Social Logins**, you will see individual enable controls for **Zoho, Google, Microsoft 365, LinkedIn, Facebook**. To offer "sign in with Zoho," enable only the **Zoho** tile and supply the **Client Name** it asks for; leave Google/Microsoft365/LinkedIn/Facebook off. [VERIFIED — https://docs.catalyst.zoho.com/en/cloud-scale/help/authentication/social-logins/configuring-social-logins/, accessed 2026-09-15]
      - **Note:** Social Logins require Public Signup to be enabled first ("Public Signup must be enabled to use Social Logins.") [VERIFIED, same source]
   f. Click **Next**.
6. **Additional Settings** screen (this is the same "last step of all the authentication setups" that also hosts Authorized Domains — see Section B): [VERIFIED — https://docs.catalyst.zoho.com/en/cloud-scale/help/authentication/whitelisting/authorized-domains/introduction/, accessed 2026-09-15]
   a. Leave **Custom User Validation** off unless you have a Basic I/O function ready to approve/reject sign-ups (see Section D). It requires Public Signup to already be enabled. [VERIFIED]
   b. Optionally add entries under **Authorized Domains** — this grants CORS/iFrame access to those domains; it does **not** control post-login redirect targets (see Section B). [VERIFIED — https://docs.catalyst.zoho.com/en/cloud-scale/help/authentication/whitelisting/authorized-domains/introduction/, accessed 2026-09-15]
7. Click **Finish**. Catalyst generates secure **Access URLs** for the Login, Sign Up, and Password Reset pages. [VERIFIED — https://docs.catalyst.zoho.com/en/tutorials/hosted-login-app/nodejs/configure-hosted-login/, accessed 2026-09-15]

### Adding the owner and pilot-team users (Users tab)

Path: **Cloud Scale → Authentication → Users** (`#/cloudscale/authentication/users`). [VERIFIED — console path corroborated by https://docs.catalyst.zoho.com/en/cloud-scale/help/authentication/user-management/introduction/ and .../users/implementation/, accessed 2026-09-15]

1. Click **Add User**.
2. Fill in: **First Name**, **Last Name**, **Email ID**, and choose a **Role** from the dropdown. [VERIFIED — https://docs.catalyst.zoho.com/en/cloud-scale/help/authentication/user-management/users/implementation/, accessed 2026-09-15]
3. Optionally enter an **Org ID**. If left blank, Catalyst auto-generates a unique organization ID for that user ("If no Org ID is explicitly specified during user addition, Catalyst will automatically assign one" and "The organization of a user cannot be changed later, once it is associated with their account"). [VERIFIED — https://docs.catalyst.zoho.com/en/cloud-scale/help/authentication/user-management/users/introduction, accessed 2026-09-15] To put the owner and pilot-team users in the same org, give them the **same Org ID** explicitly.
4. Choose the primary platform (**Web / Android / iOS**) and either check **Use Default Redirect URL** (uses the app's configured homepage) or type a custom redirect URL. [VERIFIED — https://docs.catalyst.zoho.com/en/cloud-scale/help/authentication/user-management/users/implementation/, accessed 2026-09-15]
5. Submit. Catalyst emails the invited user a link to a hosted sign-up form; the user opens it, authenticates the link, and **sets their own password**; they are then redirected to the specified redirect URL. [VERIFIED, same source, and https://docs.catalyst.zoho.com/en/cloud-scale/help/authentication/user-management/introduction/, accessed 2026-09-15]
6. Repeat for each pilot-team member. Development environment cap: **maximum 25 users**; unlimited after promotion to Production. [VERIFIED — https://docs.catalyst.zoho.com/en/cloud-scale/help/authentication/user-management/introduction/ and https://docs.catalyst.zoho.com/en/sdk/nodejs/v2/cloud-scale/authentication/add-new-user/, accessed 2026-09-15]
7. Users can later be **Enabled/Disabled** via a toggle in the **Status** column of the Users tab; a disabled user cannot log in until re-enabled. [VERIFIED — https://docs.catalyst.zoho.com/en/cloud-scale/help/authentication/user-management/users/implementation/, accessed 2026-09-15]

---

## B. Redirect / logout findings

### 1. Hosted login post-sign-in redirect

- **`redirect_url`** is the field name documented for the **User Management REST API / SDK invitation calls** (`registerUser` / `addUserToOrg` / the `POST .../project-user/signup` endpoint) — it is passed when an admin adds/invites a user, and it is where the browser is sent *after that user sets their password and signs in for the first time*. [VERIFIED — https://docs.catalyst.zoho.com/en/api/code-reference/cloud-scale/authentication/add-user-to-existing-org/, https://docs.catalyst.zoho.com/en/sdk/nodejs/v2/cloud-scale/authentication/add-new-user/, and https://docs.catalyst.zoho.com/en/sdk/javascript/v1/cloudscale/authentication/add-user-to-org/, all accessed 2026-09-15]. Max length 200 characters. [VERIFIED, REST API reference above]
- **`service_url`** is the field name documented in the **Embedded Authentication** client-side script snippet (`catalyst.auth.signIn(...)` config) — "This value is optional. You can provide your redirect URL here," with an example default of `/app/index.html`. [VERIFIED — https://docs.catalyst.zoho.com/en/cloud-scale/help/authentication/native-catalyst-authentication/embedded-authentication/scripts-for-embedded/, accessed 2026-09-15]
- For a **Catalyst Web Client** hosted app, the redirect-after-login target is instead configured declaratively via the **`login_redirect`** property in `client-package.json` (e.g. `"login_redirect": "index.html"`), and the client's `homepage` is what is served at `/__catalyst/auth/login`. [VERIFIED — https://docs.catalyst.zoho.com/en/tutorials/hosted-login-app/nodejs/configure-client/, accessed 2026-09-15]
- **UNVERIFIED:** Whether the **hosted login page itself** (`GET /__catalyst/auth/login`) accepts an arbitrary caller-supplied query parameter (e.g. `redirect_uri`, `redirect_url`, or `service_url`) that an external app (such as an AppSail service on a different route/origin) can append to control the post-login destination at request time. The documentation describes `redirect_url` (REST/SDK invite-time field) and `login_redirect`/`homepage` (declarative, Web-Client-only, `client-package.json`) and `service_url` (Embedded-Auth JS config) — three different, non-interchangeable mechanisms — but none of the fetched pages documents a query-string contract for the Hosted Login URL that a non-Client (e.g., AppSail) origin can drive per-request. The `?redirect_uri=<origin>/` pattern your AppSail service currently uses was not found described anywhere in the official docs reviewed; it appears to be an undocumented/inferred behavior rather than a documented API. Treat it as unverified and test it explicitly against the Development environment.
- **UNVERIFIED:** The default redirect target when no redirect parameter is supplied to the Hosted Login page directly (e.g., whether it defaults to the AppSail app root). No page found states this default for a non-Client caller.
- **UNVERIFIED:** Whether the redirect target must be same-origin or listed in **Authorized Domains**. The only documented purpose of Authorized Domains is CORS and iFrame access ("Catalyst Cloud Scale provides you the convenience of easily configuring the following two functionalities... [CORS and iFrame]"), not redirect-target validation. [VERIFIED (for what Authorized Domains actually does) — https://docs.catalyst.zoho.com/en/cloud-scale/help/authentication/whitelisting/authorized-domains/introduction/, accessed 2026-09-15]. Whether some other, undocumented allow-list governs redirect targets is UNVERIFIED.

### 2. Hosted logout

- The documented logout mechanism is the **client-side SDK method** `catalyst.auth.signOut(redirectURL)` (Web SDK v4) — the redirect destination is passed as a JS argument, e.g. `auth.signOut("https://catalyst.zoho.com")`, not as a URL query parameter. The method does not return a promise. [VERIFIED — https://docs.catalyst.zoho.com/en/sdk/web/v4/cloud-scale/authentication/sign-out-user/, accessed 2026-09-15]
- **UNVERIFIED:** A standalone `GET /__catalyst/auth/logout?<param>=<url>` URL pattern (analogous to `/__catalyst/auth/login`) was referenced only informally in one client-side code example (`window.location.href = "/__catalyst/auth/login"` was documented for login; an equivalent documented logout *URL* with a query parameter was not found in the pages reviewed). If your AppSail app relies on hitting `/__catalyst/auth/logout` directly with a query string, that contract is not confirmed by the docs found and should be verified empirically.

---

## C. Zoho-only sign-in, Public Signup, and who can sign in

1. **Zoho as the only enabled Social Login:** Enabling only the Zoho tile under Social Logins means users can click "Sign in with Zoho" and authenticate via their Zoho Accounts identity. [VERIFIED — https://docs.catalyst.zoho.com/en/cloud-scale/help/authentication/social-logins/configuring-social-logins/, accessed 2026-09-15]
   - **UNVERIFIED:** Whether the native email/password sign-in form is always additionally rendered on the hosted Sign-In page alongside the enabled social-login button(s), or whether it is possible to configure the hosted page to show **only** the Zoho button and hide native email/password entirely ("Zoho-only" enforcement). The Social Logins documentation describes social logins as configurable *options* added to the login element but does not state whether they replace or merely supplement the native form. No page found gives a toggle to hide native sign-in.
2. **Public Signup = off:** "The Signup option will not be displayed to your end-users" — self-registration is unavailable. Only users added through the **console Users tab** or the **Add User / registerUser / addUserToOrg APIs** can sign in. [VERIFIED — https://docs.catalyst.zoho.com/en/cloud-scale/help/authentication/public-signup/, accessed 2026-09-15]
   - Public Signup is disabled by default, and toggling it affects **all** authentication types configured on the project at once (not just Hosted). [VERIFIED, same source]
   - Public Signup must be **on** to use Social Logins and to use Custom User Validation. [VERIFIED — same source, and https://docs.catalyst.zoho.com/en/cloud-scale/help/authentication/whitelisting/custom-user-validation/introduction, accessed 2026-09-15]

For EcoGreenMigration's pilot (owner + a small, known team), the documented-safe pattern is: **Public Signup off**, add the owner and pilot-team members individually via the Users tab, and enable Zoho as a convenience sign-in option for those pre-added users. Whether an *added* user can still choose "Sign in with Zoho" vs. must use email/password to set an initial password is UNVERIFIED from docs found — the invitation flow documented always describes the user "setting up a password" via the emailed link, which suggests the first sign-in is via the emailed link/password path regardless of Social Login configuration; subsequent sign-ins could plausibly use Zoho social login if the account's email matches, but this was not documented explicitly and should be verified empirically in Development.

---

## D. Adding users — console flow, invitation, REST/SDK equivalents, status, org

### Console flow
See Section A ("Adding the owner and pilot-team users") — Add User → First Name / Last Name / Email ID / Role / optional Org ID / platform + redirect URL → invitation email → user sets password → redirected. [VERIFIED — sources cited above]

### REST API
`POST {api-domain}/baas/v1/project/{project_id}/project-user/signup` [VERIFIED — https://docs.catalyst.zoho.com/en/api/code-reference/cloud-scale/authentication/add-user-to-existing-org/, accessed 2026-09-15]

Request body (as documented):
```json
{
  "platform_type": "web",
  "redirect_url": "https://.../",
  "user_details": {
    "first_name": "...",
    "last_name": "...",
    "email_id": "..."
  }
}
```
Response body includes, among other fields:
```json
{
  "status": "success",
  "data": {
    "zaid": 0,
    "org_id": 0,
    "redirect_url": "...",
    "platform_type": "web",
    "user_details": {
      "user_id": 0,
      "zuid": 0,
      "status": "ACTIVE",
      "is_confirmed": false,
      "email_id": "...",
      "first_name": "...",
      "last_name": "...",
      "role_details": { "role_id": 0, "role_name": "..." }
    }
  }
}
```
[VERIFIED — same source, accessed 2026-09-15]

**Note on "status" values:** the documented response uses `user_details.status: "ACTIVE"` plus a separate boolean `is_confirmed` (true once the invited user has completed sign-up/password-set) — **not** a `"CONFIRMED"` string enum as the task brief hypothesized. Whether other string values besides `"ACTIVE"` exist for `status` (e.g. an inactive/disabled state) is **UNVERIFIED** from the pages fetched; the console's Users tab separately exposes an Enable/Disable toggle in a "Status" column, which may or may not map 1:1 onto this same API field. [VERIFIED for what was found; UNVERIFIED for the full enum]

### SDK equivalents (Node.js, matching the AppSail service's runtime)
- **`userManagement.registerUser(signupConfig, userConfig)`** — creates/invites a new user; `userConfig` requires `first_name`, `email_id` (optional `last_name`, `role_id`); `signupConfig` carries `platform_type`, `template_details` (email template), and `redirect_url`. Used when you are not necessarily targeting an existing org. [VERIFIED — https://docs.catalyst.zoho.com/en/sdk/nodejs/v2/cloud-scale/authentication/add-new-user/, accessed 2026-09-15]
- **`userManagement.addUserToOrg(signupConfig, userConfig)`** — same shape, but `userConfig.org_id` is **mandatory**, i.e. it adds the new user into a specific, already-existing organization rather than letting Catalyst mint a new org. [VERIFIED — https://docs.catalyst.zoho.com/en/sdk/javascript/v1/cloudscale/authentication/add-user-to-org/, accessed 2026-09-15]
- Both are documented as counting against the same 25-user Development-environment cap. [VERIFIED — https://docs.catalyst.zoho.com/en/sdk/nodejs/v2/cloud-scale/authentication/add-new-user/, accessed 2026-09-15]

### The "org" concept
- An organization is **not** auto-created once for the whole project. Instead, an `org_id` is generated **per user-add call** if you don't supply one explicitly: "This identification is generated when the end-user is added through the Add User API or through the Add User button in the console... If no Org ID is explicitly specified during user addition, Catalyst will automatically assign one." [VERIFIED — https://docs.catalyst.zoho.com/en/cloud-scale/help/authentication/user-management/users/introduction, accessed 2026-09-15]
- Once set, a user's org association **cannot be changed later**. [VERIFIED, same source]
- Practical implication for EcoGreenMigration: if you want the owner and pilot-team users grouped under one logical org, you must explicitly pass/enter the **same Org ID** for every one of them when adding them (via console or API) — otherwise each gets its own auto-generated org.

---

## E. How AppSail consumes the hosted-login session

- **Confirmed pattern:** an AppSail Node.js service initializes the Catalyst SDK per-request from the incoming request object: `let catalystApp = catalyst.initialize(req);` This is the documented pattern for AppSail (and Functions) to get a request-scoped Catalyst app instance. [VERIFIED — https://docs.catalyst.zoho.com/en/serverless/help/appsail/implement-catalyst-sdk/, accessed 2026-09-15]
- **Confirmed pattern (generic, not AppSail-specific in the source found):** `app.userManagement().getCurrentUser()` returns a promise resolving to the current end-user's details (JSON: first name, last name, email, etc.) for "the scope the function is getting executed [in]." [VERIFIED — https://docs.catalyst.zoho.com/en/sdk/nodejs/v2/cloud-scale/authentication/get-user-details/ and related Node.js SDK "get current user"/"get user details" pages, accessed 2026-09-15]
- **UNVERIFIED — the specific mechanism connecting the two:** No page fetched explicitly confirms/documents that calling `catalyst.initialize(req)` followed by `userManagement().getCurrentUser()` **inside an AppSail request handler** will resolve to the same user who signed in via the project's Hosted Login page, when that AppSail service is running on its own domain/origin (e.g. `ecogreenmigrationconsole-....development.catalystappsail.in`) rather than as a Catalyst-hosted **Client**. The SDK docs describe the method generically; the only worked "AppSail + hosted/embedded auth" tutorials found (`leadmanager-appsail` in Flask/Express) describe **Embedded Authentication with a registered OAuth-style client and an explicit `/generateToken` redirect endpoint you must code yourself**, not a Hosted-Authentication session simply "showing up" via `getCurrentUser()` on the AppSail origin. This is a materially different, more manual integration pattern than the one implied by the task's premise. Recommend validating this in the Development environment before relying on it.
- **Cookie name/domain:** **UNVERIFIED.** The only relevant statement found is generic: "The end-users' details along with the token information will also be stored in the browser cookie through the Web SDK, to ensure the session is maintained," with tokens valid "for one hour" before being silently refreshed. No specific cookie name or `Domain=` attribute was documented in the pages fetched. [Partially VERIFIED (existence of a cookie + 1-hour token lifetime) — general Catalyst Authentication overview material found via search; exact cookie name/domain UNVERIFIED]
- **Cross-domain access:** Catalyst does document a **CORS-based** mechanism ("You will need to ensure that the domain of the backend service and the frontend service are whitelisted using the CORS feature present in the Authentication component") for letting a separate backend domain interact with the authentication component, but the full content of the dedicated Cross-Domain Access page could not be retrieved in this research pass, so the precise cookie-sharing/session-propagation mechanics across the AppSail origin and the `/__catalyst/auth/login` origin remain **UNVERIFIED**. [VERIFIED that CORS whitelisting is *a* documented requirement — https://docs.catalyst.zoho.com/en/cloud-scale/help/authentication/native-catalyst-authentication/embedded-authentication/setup-embedded-auth/ (referencing cross-domain-access), accessed 2026-09-15; full mechanics UNVERIFIED]
- **`app-config.json` / `catalyst_auth` / `auth_type`:** **No evidence found.** The documented, exhaustive set of AppSail `app-config.json` fields covers only: startup command, environment variables, memory/disk allocation, and the listen port. [VERIFIED — https://docs.catalyst.zoho.com/en/serverless/help/appsail/key-concepts/catalyst-configurations/, accessed 2026-09-15]. No `catalyst_auth` or `auth_type` key was found in any AppSail configuration page searched. This suggests such keys likely do **not** exist for AppSail (auth type/behavior appears to be entirely a console-level Authentication-component setting, not an app-config.json setting) — but absence of evidence is not proof of absence, so this is reported as **UNVERIFIED (leaning: does not exist)** rather than a confirmed negative.

---

## F. Custom User Validation

- **What it does:** A Catalyst **Basic I/O function** you write and wire in as the validator; during Sign Up, Catalyst calls it with the prospective user's details and it approves or rejects the sign-up (and may customize the resulting name/role/org). [VERIFIED — https://docs.catalyst.zoho.com/en/cloud-scale/help/authentication/whitelisting/custom-user-validation/introduction and .../how-it-works, accessed 2026-09-15]
- **Trigger scope:** Only fires on the **Sign Up** action — i.e., a user's very first access to the app. It does **not** re-run on subsequent logins. [VERIFIED, same source: "Custom User Validation only applies for sign up action, i.e., when the user tries to access your Catalyst application for the very first time."]
- **Function input contract (documented example):**
```json
{
  "request_type": "add_user",
  "request_details": {
    "user_details": {
      "email_id": "user@example.com",
      "first_name": "FirstName",
      "last_name": "LastName",
      "org_id": "...",
      "role_details": { "role_name": "...", "role_id": "..." }
    },
    "auth_type": "web"
  }
}
```
[VERIFIED — https://docs.catalyst.zoho.com/en/cloud-scale/help/authentication/whitelisting/custom-user-validation/how-it-works, accessed 2026-09-15]
- **Relation to Public Signup:** Custom User Validation **requires** Public Signup to already be enabled — "Public Signup must be enabled to use Custom User Validation" / "To enable Custom User Validation, you must first ensure that Public Signup has been enabled." Consequently, **when Public Signup is off** (the likely EcoGreenMigration pilot configuration — console-added users only), Custom User Validation is **not applicable/available**, since there is no self-service sign-up path for it to validate. [VERIFIED — https://docs.catalyst.zoho.com/en/cloud-scale/help/authentication/whitelisting/custom-user-validation/introduction and .../how-it-works, accessed 2026-09-15]

---

## G. What we could not verify

1. **The exact query parameter (if any) the Hosted Login page (`/__catalyst/auth/login`) honors when an external origin (e.g., an AppSail app on its own domain) redirects into it** to control the post-sign-in destination. The docs document three related-but-distinct mechanisms (`redirect_url` on the invite-time REST/SDK calls; `login_redirect`/`homepage` in `client-package.json` for Catalyst Web Clients; `service_url` in the Embedded-Auth JS config) but never a documented query-string contract for the Hosted Login URL itself usable by a non-Client caller. Your app's current `?redirect_uri=<origin>/` usage was not found documented anywhere reviewed.
2. **The default post-login target when no redirect parameter is supplied**, specifically for an AppSail-fronted Hosted Login flow.
3. **Whether the redirect/logout target must be same-origin or on an "Authorized Domain."** Authorized Domains is documented to govern only CORS and iFrame access, not redirect-target validation — so if there is a redirect allow-list, its mechanism is undocumented.
4. **The exact `/__catalyst/auth/logout` URL pattern and its redirect parameter**, if one exists distinct from the client-side `catalyst.auth.signOut(redirectURL)` SDK call.
5. **Whether "Zoho only" as the sole enabled Social Login can suppress/replace the native email+password form** on the hosted Sign In page, or whether native sign-in is always shown alongside any enabled social provider.
6. **Whether a user added via the console/API Add User flow, once confirmed, can subsequently authenticate via "Sign in with Zoho"** (as opposed to only via the emailed password-setup link), when Zoho is the configured Social Login.
7. **The full `user_details.status` enum** for User Management — only `"ACTIVE"` (plus a separate boolean `is_confirmed`) was found in the documented REST API sample response; whether other string values exist (e.g., for disabled/pending users) is unverified, and how this maps to the console Users-tab "Status" Enable/Disable toggle is unverified.
8. **The specific session cookie name and `Domain` attribute** used by Hosted/Native Catalyst Authentication, and the precise mechanics by which an AppSail app's `catalyst.initialize(req)` + `userManagement().getCurrentUser()` would (or would not) resolve the same identity established via the Hosted Login page on a different Catalyst-issued domain. The only concrete AppSail+auth tutorials found (`leadmanager-appsail`) use a manually-coded OAuth-style redirect/token-exchange endpoint (`/generateToken`) rather than an automatic shared-session read via `getCurrentUser()`.
9. **Whether `app-config.json` for AppSail supports any `catalyst_auth` or `auth_type` key.** No such keys were found in the documented AppSail configuration schema (which only covers command, env vars, memory/disk, and port); treated as likely non-existent but not proven absent.

---

## Sources consulted (all accessed 2026-09-15)

- https://docs.catalyst.zoho.com/en/cloud-scale/help/authentication/native-catalyst-authentication/hosted-authentication-type/introduction/
- https://docs.catalyst.zoho.com/en/cloud-scale/help/authentication/native-catalyst-authentication/hosted-authentication-type/edit-hosted-authentication/
- https://docs.catalyst.zoho.com/en/tutorials/hosted-login-app/nodejs/introduction/
- https://docs.catalyst.zoho.com/en/tutorials/hosted-login-app/nodejs/configure-hosted-login/
- https://docs.catalyst.zoho.com/en/tutorials/hosted-login-app/nodejs/configure-client/
- https://docs.catalyst.zoho.com/en/tutorials/hosted-login-app/nodejs/test-app/
- https://docs.catalyst.zoho.com/en/tutorials/hosted-login-app/python/configure-hosted-login/
- https://docs.catalyst.zoho.com/en/cloud-scale/help/authentication/social-logins/configuring-social-logins/
- https://docs.catalyst.zoho.com/en/cloud-scale/help/authentication/public-signup/
- https://docs.catalyst.zoho.com/en/cloud-scale/help/authentication/whitelisting/authorized-domains/introduction/
- https://docs.catalyst.zoho.com/en/cloud-scale/help/authentication/whitelisting/custom-user-validation/introduction
- https://docs.catalyst.zoho.com/en/cloud-scale/help/authentication/whitelisting/custom-user-validation/how-it-works
- https://docs.catalyst.zoho.com/en/cloud-scale/help/authentication/native-catalyst-authentication/embedded-authentication/scripts-for-embedded/
- https://docs.catalyst.zoho.com/en/cloud-scale/help/authentication/user-management/introduction/
- https://docs.catalyst.zoho.com/en/cloud-scale/help/authentication/user-management/users/implementation/
- https://docs.catalyst.zoho.com/en/cloud-scale/help/authentication/user-management/users/introduction
- https://docs.catalyst.zoho.com/en/api/code-reference/cloud-scale/authentication/add-user-to-existing-org/
- https://docs.catalyst.zoho.com/en/sdk/nodejs/v2/cloud-scale/authentication/add-new-user/
- https://docs.catalyst.zoho.com/en/sdk/javascript/v1/cloudscale/authentication/add-user-to-org/
- https://docs.catalyst.zoho.com/en/sdk/web/v4/cloud-scale/authentication/sign-out-user/
- https://docs.catalyst.zoho.com/en/serverless/help/appsail/implement-catalyst-sdk/
- https://docs.catalyst.zoho.com/en/serverless/help/appsail/key-concepts/catalyst-configurations/
- https://docs.catalyst.zoho.com/en/tutorials/leadmanager-appsail/flask/enable-auth/
- https://docs.catalyst.zoho.com/en/tutorials/leadmanager-appsail/express/register-client/
- https://catalyst.zoho.com/cookbook/developer-toolkit/authentication-authorization-with-catalyst
