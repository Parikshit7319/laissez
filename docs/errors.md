# API error codes

Generated from the source by `npm run docs:errors` on 2026-10-07. 252 codes across 620 throw sites, plus 1 call that passes a computed code and is not listed.

Every error response is `{"error": {"code", "message", "detail"}}`. The code is stable and snake_case; the message says what happened and, where there is something to do, how to fix it. The same list is served at `GET /v1/errors`.

## 400

| Code | Message | What to do | Thrown from |
| --- | --- | --- | --- |
| `bad_origin` | Passkeys for Laissez only work on {origins0}. |  | `api/src/webauthn.ts:18` |
| `bad_passkey` | The passkey response could not be read. |  | `api/src/webauthn.ts:15`, `api/src/webauthn.ts:16`, `api/src/webauthn.ts:17`, `api/src/webauthn.ts:23`, `api/src/webauthn.ts:51`, `api/src/webauthn.ts:53` |
| `bot_check_failed` | The security check did not pass. | Reload the page and try again. | `api/src/account-security.ts:32` |
| `bot_check_required` | Complete the security check and try again. |  | `api/src/account-security.ts:24` |
| `challenge_expired` | This sign-up request expired. | Start again. | `api/src/auth.ts:290`, `api/src/auth.ts:336`, `api/src/auth.ts:564`, `api/src/auth.ts:611`, `api/src/routes/portal-auth.ts:85`, `api/src/routes/portal-auth.ts:86` and 2 more |
| `cloned_passkey` | This passkey looks cloned. | Sign in with another passkey and remove this one. | `api/src/webauthn.ts:55` |
| `http_error` | The request could not be processed. |  | `api/src/index.ts:62` |
| `invalid_confirmation` | A confirmation needs txid, or canceled with a reason. |  | `api/src/routes/travel.ts:246` |
| `invalid_cursor` | The cursor is not valid. | Use the next_cursor value from the previous page. | `api/src/pagination.ts:22`, `api/src/pagination.ts:24`, `api/src/pagination.ts:26` |
| `invalid_filter` | credential_status must be one of {join}. |  | `api/src/routes/core.ts:146`, `api/src/routes/core.ts:711`, `api/src/routes/core.ts:712`, `api/src/routes/core.ts:1078`, `api/src/routes/network.ts:106`, `api/src/routes/workflow.ts:38` and 3 more |
| `invalid_idempotency_key` | Idempotency-Key must be 1 to 255 characters. | A UUID works well. | `api/src/routes/platform.ts:50` |
| `invalid_inquiry` | A TRP inquiry needs asset, amount, callback and IVMS101. |  | `api/src/routes/travel.ts:168` |
| `invalid_request` | The body is not JSON. |  | `api/src/routes/billing.ts:193`, `api/src/routes/kyc.ts:70`, `api/src/routes/rules.ts:71` |
| `invalid_resolution` | A resolution needs approved {address, callback} or rejected. |  | `api/src/routes/travel.ts:228`, `api/src/routes/travel.ts:229` |
| `invalid_status` | Status must be one of {join}. | You sent "{s}". | `api/src/routes/compliance.ts:24`, `api/src/routes/rules.ts:224` |
| `missing_parameter` | Send fund and jurisdiction query parameters. |  | `api/src/routes/compliance2.ts:182` |
| `missing_request_identifier` | Send a request-identifier header. | TRP uses one identifier for the whole transfer. | `api/src/routes/travel.ts:150` |
| `sso_code_expired` | This sign-in link expired. | Start single sign-on again. | `api/src/auth.ts:450` |
| `stripe_signature_invalid` | The Stripe signature did not verify. |  | `api/src/routes/billing.ts:190` |
| `totp_invalid` | That code is not right or was already used. | Wait for the next code and try again. | `api/src/routes/security.ts:130`, `api/src/routes/security.ts:211`, `api/src/routes/security.ts:224` |
| `unsupported_alg` | This passkey uses an algorithm Laissez does not accept. |  | `api/src/webauthn.ts:26` |
| `unsupported_version` | This endpoint speaks TRP {TRP_VERSION}. | Send an api-version header starting with 3. | `api/src/routes/travel.ts:151`, `api/src/version.ts:31` |
| `verify_link_invalid` | This confirmation link is invalid, already used or expired. | Sign in and ask for a new one. | `api/src/routes/security.ts:64` |

## 401

| Code | Message | What to do | Thrown from |
| --- | --- | --- | --- |
| `bad_code` | That code is not right, or was already used. | Open your authenticator app and try the current one. | `api/src/routes/portal-auth.ts:130`, `api/src/routes/portal-auth.ts:172`, `api/src/routes/portal-auth.ts:184` |
| `bad_signature` | The webhook digest did not verify. |  | `api/src/routes/kyc.ts:69`, `api/src/webauthn.ts:68` |
| `portal_link_expired` | This portal link has expired or was withdrawn. | Ask your distributor for a new link. | `api/src/routes/brand.ts:127`, `api/src/routes/portal-auth.ts:38`, `api/src/routes/portal.ts:48` |
| `portal_unauthorized` | Open the portal from the link your distributor sent you. |  | `api/src/routes/brand.ts:122`, `api/src/routes/portal-auth.ts:35`, `api/src/routes/portal-auth.ts:126`, `api/src/routes/portal-auth.ts:139`, `api/src/routes/portal-auth.ts:146`, `api/src/routes/portal.ts:34` and 1 more |
| `recovery_invalid` | That email and recovery code do not match, or the code was already used. |  | `api/src/routes/account2.ts:94` |
| `session_expired` | Your session has ended. | Sign in again. | `api/src/auth.ts:145` |
| `session_idle` | You were signed out after {idle_minutes} minutes without activity, as your organization requires. | Sign in again. | `api/src/auth.ts:157` |
| `sso_bad_alg` | ID tokens signed with {alg} are not accepted. |  | `api/src/oidc.ts:64` |
| `sso_bad_audience` | The ID token was issued for a different application. |  | `api/src/oidc.ts:69` |
| `sso_bad_issuer` | The ID token came from a different issuer. |  | `api/src/oidc.ts:68` |
| `sso_bad_nonce` | The sign-in response does not match this request. |  | `api/src/oidc.ts:71` |
| `sso_bad_signature` | The ID token signature did not verify. |  | `api/src/oidc.ts:65` |
| `sso_bad_token` | The identity provider returned a malformed ID token. |  | `api/src/oidc.ts:50` |
| `sso_expired` | The ID token has expired. | Sign in again. | `api/src/oidc.ts:70` |
| `sso_no_email` | The identity provider did not share an email address. |  | `api/src/oidc.ts:72` |
| `sso_token_failed` | The identity provider refused the sign-in${j.error ?  |  | `api/src/oidc.ts:83` |
| `sso_unknown_key` | The ID token was signed with a key the provider does not publish. |  | `api/src/oidc.ts:55` |
| `sso_unverified` | The identity provider says this email is not verified. |  | `api/src/oidc.ts:73` |
| `unauthorized` | This key is not valid, has expired, or its sandbox has expired. |  | `api/src/auth.ts:169`, `api/src/auth.ts:179`, `api/src/internal.ts:26` |
| `unknown_passkey` | This passkey is not registered with Laissez. | Create an account first. | `api/src/auth.ts:339`, `api/src/auth.ts:567`, `api/src/routes/portal-auth.ts:113` |

## 402

| Code | Message | What to do | Thrown from |
| --- | --- | --- | --- |
| `billing_suspended` | This organization is suspended for an unpaid invoice. | Reads and redemptions still work. Pay the open invoice under Settings, Billing, or contact billing to restore write access. | `api/src/auth.ts:186`, `api/src/routes/core.ts:699`, `api/src/routes/core.ts:1066` |

## 403

| Code | Message | What to do | Thrown from |
| --- | --- | --- | --- |
| `account_disabled` | This portal account was disabled by your distributor. |  | `api/src/routes/portal-auth.ts:114` |
| `account_required` | Passkeys belong to real accounts. | Create an account to add one. | `api/src/auth.ts:596`, `api/src/auth.ts:599`, `api/src/routes/account2.ts:77`, `api/src/routes/security.ts:196` |
| `acting_as` | Switch back to yourself before editing your profile. |  | `api/src/auth.ts:475`, `api/src/routes/account2.ts:19` |
| `decide_only_mode` | This organization runs in decide-only mode: Laissez returns decisions and evidence, and settlement happens on your own rails. | An administrator can change the mode under Settings, Organization. | `api/src/auth.ts:188` |
| `email_domain_not_allowed` | This organization only accepts people with a company email address. | Use the address your administrator allows. | `api/src/auth.ts:254`, `api/src/auth.ts:307`, `api/src/auth.ts:536` |
| `email_not_verified` | Confirm your email address first. | We sent a link; you can ask for another from the sign-in screen. | `api/src/auth.ts:160` |
| `forbidden` | Approving {toLowerCase} needs one of these roles: {join}. |  | `api/src/approvals.ts:208`, `api/src/http.ts:81`, `api/src/routes/account2.ts:240` |
| `human_required` | Only a signed-in person can approve or reject. | API keys can request, not approve. | `api/src/approvals.ts:205`, `api/src/auth.ts:474`, `api/src/auth.ts:501`, `api/src/auth.ts:516`, `api/src/auth.ts:532`, `api/src/auth.ts:549` and 15 more |
| `insufficient_scope` | This API key is not allowed to {PERM_TEXTpermperm}. | Add the right scope or use another key. | `api/src/http.ts:80` |
| `ip_not_allowed` | Requests from {ipthisaddress} are not on this key's IP allowlist. |  | `api/src/auth.ts:172` |
| `mfa_required` | Enter the code from your authenticator app to finish signing in. |  | `api/src/routes/portal-auth.ts:140`, `api/src/routes/portal.ts:35` |
| `network_not_allowed` | This organization only allows sign-in from approved networks, and {ipthisaddress} is not one of them. |  | `api/src/auth.ts:50`, `api/src/auth.ts:159` |
| `no_organization` | Your account is not a member of any organization. | Ask an administrator for an invite. | `api/src/auth.ts:344`, `api/src/routes/account2.ts:99`, `api/src/routes/security.ts:133` |
| `not_a_member` | You are not a member of that organization. |  | `api/src/auth.ts:519` |
| `org_not_verified` | Your organization is not verified yet, so settlements, API keys and chain actions are closed. | Submit the verification form under Settings, Verification. | `api/src/auth.ts:189`, `api/src/routes/billing.ts:116` |
| `recovery_session` | You signed in with a recovery code. | Add a passkey on the Security page, then sign in with it to continue. | `api/src/auth.ts:148` |
| `recovery_waiting` | The waiting period is not over. | This link opens at {toISOString}. | `api/src/routes/security.ts:125` |
| `same_person` | You requested this. | A second person must decide it.{value} | `api/src/approvals.ts:207`, `api/src/routes/core.ts:470`, `api/src/routes/rules.ts:348` |
| `sandbox_only` | Acting as a teammate exists only in sandboxes. | This deployment runs in production mode. | `api/src/auth.ts:502`, `api/src/auth.ts:503`, `api/src/auth.ts:705`, `api/src/routes/account2.ts:135`, `api/src/routes/account2.ts:178`, `api/src/routes/account2.ts:201` and 8 more |
| `scope_escalation` | This key cannot create a key with scopes it does not have: {join}. |  | `api/src/routes/platform.ts:125`, `api/src/routes/platform.ts:150` |
| `sso_sign_in_required` | This organization requires single sign-on. | Use the company sign-in instead of a passkey. | `api/src/auth.ts:51` |
| `step_up_required` | Confirm it is you with your passkey to {what}. | The confirmation lasts ten minutes. | `api/src/http.ts:96` |
| `user_verification_required` | This organization requires a passkey that confirms it is you with a PIN, fingerprint or face. | Unlock the passkey with one of those and try again. | `api/src/auth.ts:52` |

## 404

| Code | Message | What to do | Thrown from |
| --- | --- | --- | --- |
| `consent_not_found` | This consent link is not valid. | Ask the distributor that sent it for a new one. | `api/src/routes/network.ts:204`, `api/src/routes/network.ts:206` |
| `counterparty_not_found` | No client called "{key}" at your distributor. | Check the passport number or the exact legal name with them. | `api/src/routes/portal.ts:286` |
| `invite_invalid` | This invite link is invalid or has expired. | Ask for a new one. | `api/src/auth.ts:252`, `api/src/auth.ts:360`, `api/src/auth.ts:539` |
| `no_evidence` | No result has been stored for this check yet. | Refresh it, or wait for the provider webhook. | `api/src/kyc.ts:154` |
| `not_found` | No approval request {reqId} in this organization. |  | `api/src/approvals.ts:191`, `api/src/auth.ts:507`, `api/src/auth.ts:586`, `api/src/auth.ts:622`, `api/src/auth.ts:643`, `api/src/auth.ts:655` and 135 more |
| `passport_not_found` | No active credential with that passport number is available to you. | Check the number with the client or the issuing distributor. | `api/src/routes/network.ts:58` |
| `recovery_link_invalid` | This recovery link is not valid. | Ask for a new one from the sign-in screen. | `api/src/routes/security.ts:103` |
| `unknown_beneficiary_vasp` | No VASP is registered at this Travel Address. |  | `api/src/routes/travel.ts:164`, `api/src/routes/travel.ts:177` |
| `unknown_flag` | No feature flag named {key}. | See GET /v1/flags for the list. | `api/src/flags.ts:93` |

## 409

| Code | Message | What to do | Thrown from |
| --- | --- | --- | --- |
| `account_exists` | An account with this email already exists. | Sign in with your passkey instead. | `api/src/auth.ts:248`, `api/src/auth.ts:294`, `api/src/routes/portal-auth.ts:69`, `api/src/routes/portal-auth.ts:89` |
| `already_applied` | This import was already applied. | Upload the file again to import it a second time. | `api/src/routes/import.ts:248` |
| `already_approved` | You already approved this request. | Another approver has to add theirs. | `api/src/approvals.ts:209` |
| `already_called` | {currency} has already been called against this commitment. | Reduce it to the called amount instead of removing it. | `api/src/routes/fundops2.ts:83` |
| `already_decided` | This hit was already marked {status} by {decided_byanotherreviewer}. | Decisions are kept for the audit trail; screen the name again if the facts changed. | `api/src/routes/compliance.ts:175`, `api/src/routes/compliance.ts:415`, `api/src/routes/network.ts:229`, `api/src/routes/network.ts:233`, `api/src/routes/network.ts:243`, `api/src/routes/portal.ts:494` and 1 more |
| `already_resolved` | Break {breakId} is already resolved ({resolution}). |  | `api/src/chain.ts:990`, `api/src/routes/compliance.ts:224` |
| `already_retired` | Version {version} is already retired. |  | `api/src/routes/rules.ts:402` |
| `already_rotated` | This key was already rotated. | Rotate its replacement instead. | `api/src/routes/platform.ts:149` |
| `already_sent` | A transaction for this job is already on chain, so it cannot be cancelled. | Wait for the receipt. | `api/src/chain.ts:921`, `api/src/routes/core.ts:1183`, `api/src/routes/core.ts:1195` |
| `already_settled` | This decision already settled as {id} ({status}). |  | `api/src/routes/core.ts:994`, `api/src/routes/core.ts:1018`, `api/src/routes/core.ts:1045` |
| `already_verified` | This organization is verified. | Contact support to change its legal details. | `api/src/routes/security.ts:270` |
| `already_waiting` | {name} is already on the {ticker} waitlist as {id}. |  | `api/src/routes/workflow.ts:297` |
| `approval_pending` | This order is waiting for approval, so it cannot join the waitlist yet. |  | `api/src/routes/workflow.ts:300` |
| `before_cutoff` | The cut-off for dealing {dealing_date} is {toISOString}. | Orders can still arrive until then. Send force: true to close it early. | `api/src/routes/workflow.ts:461` |
| `call_open` | Capital call {call_number} ({id}) is still open. | Settle or cancel it before issuing another. | `api/src/routes/fundops2.ts:134` |
| `cancelled` | This job was cancelled. | Request a new decision to settle again. | `api/src/chain.ts:901`, `api/src/routes/core.ts:993` |
| `chain_not_configured` | On-chain settlement is not configured, so there is nothing to reconcile. |  | `api/src/chain.ts:884`, `api/src/chain.ts:932`, `api/src/chain.ts:996` |
| `confirm_large_move` | This NAV is {toFixed2}% away from the {date} strike of {toFixed4}. | Check it, then send confirm: true to strike it. | `api/src/routes/fundops.ts:139` |
| `confirmed` | This job already confirmed on chain. | There is nothing to retry. | `api/src/chain.ts:900` |
| `counterparty_ambiguous` | More than one client has that name. | Use their passport number instead. | `api/src/routes/portal.ts:287` |
| `credential_expired` | This credential expired on {expires_on}. | Ask the issuing distributor to renew it before you rely on it. | `api/src/routes/network.ts:63` |
| `credential_not_active` | Your credential with {from_name} is no longer active, so it cannot be shared. | Ask {from_name} to renew it. | `api/src/routes/network.ts:240` |
| `domain_taken` | Another organization already uses single sign-on for {email_domain}. |  | `api/src/auth.ts:713` |
| `draft_exists` | Draft {id} for this publication is already waiting for review. | Approve or reject it before drafting again. | `api/src/routes/compliance.ts:354` |
| `email_taken` | An account with this email already exists. | Sign in with it instead. | `api/src/auth.ts:480`, `api/src/routes/account2.ts:216` |
| `exists` | A fund with ticker {ticker} already exists. | Pick another ticker. | `api/src/routes/core.ts:359`, `api/src/routes/travel.ts:308` |
| `expired` | Settlement instructions expire 15 minutes after the decision. | Request a new decision. | `api/src/routes/core.ts:989` |
| `fully_called` | Every commitment to {t} has been called in full. | Record new commitments before issuing another call. | `api/src/routes/fundops2.ts:140` |
| `hypothetical` | This decision used what-if scenarios, so it is hypothetical and cannot settle. | Request a decision without what_ifs. | `api/src/routes/core.ts:988` |
| `idempotency_in_progress` | A request with this Idempotency-Key is still running. | Retry in a few seconds. | `api/src/routes/platform.ts:61` |
| `import_busy` | Another request is applying this import. | Wait for it to finish, then continue. | `api/src/routes/import.ts:252` |
| `in_batch` | This decision deals on {batch_dealing_date} in batch {batch_id}, which is still open. | Close and settle the batch, or send force: true to settle this order alone. | `api/src/routes/core.ts:1068` |
| `in_progress` | Someone else is deciding this request right now. | Reload in a moment. | `api/src/approvals.ts:230` |
| `in_review` | This version is with a reviewer. | Ask them to request changes, then edit it. | `api/src/routes/rules.ts:272` |
| `kyc_not_started` | This check has no applicant at the provider yet. |  | `api/src/kyc.ts:104` |
| `no_account` | The beneficiary account behind this inquiry no longer exists, so it cannot be approved. | Reject it instead. | `api/src/routes/compliance2.ts:97` |
| `no_commitments` | No commitments recorded for {t}. | Record commitments before issuing a capital call. | `api/src/routes/fundops2.ts:132` |
| `no_nav` | Strike a NAV for {ticker} before paying a distribution. |  | `api/src/fundops-core.ts:314` |
| `no_snapshot` | This decision was made before Laissez stored decision snapshots, so it cannot be replayed. | Decisions made from now on can. | `api/src/routes/core.ts:775` |
| `no_yield` | Set a yield for {t} in its terms before running accruals. |  | `api/src/routes/fundops.ts:154` |
| `not_active` | This share is already {status}. |  | `api/src/routes/network.ts:128`, `api/src/routes/network.ts:298`, `api/src/routes/network.ts:301` |
| `not_allowed` | Only allowed decisions can settle. | Fix the refusal and request a new decision. | `api/src/routes/core.ts:987`, `api/src/routes/core.ts:1121`, `api/src/routes/travel.ts:306` |
| `not_approved` | This transfer was not approved, so it cannot be confirmed. |  | `api/src/routes/travel.ts:244`, `api/src/routes/travel.ts:338` |
| `not_cancellable` | This job is {status} and cannot be cancelled. |  | `api/src/chain.ts:922`, `api/src/routes/core.ts:1182` |
| `not_closed` | Close the batch first. | Settlement runs on a closed batch. | `api/src/routes/workflow.ts:477` |
| `not_closed_end` | {short} is an open-ended fund. | Commitments and capital calls apply to closed-end funds only. Create the fund with fund_type "closed_end". | `api/src/routes/fundops2.ts:23` |
| `not_distributing` | {short} is an accumulating class. | Income stays in the NAV, so there is nothing to distribute. | `api/src/fundops-core.ts:309`, `api/src/routes/fundops.ts:153` |
| `not_draft` | This change is already {status}. | Propose a new change to make further edits. | `api/src/routes/core.ts:467`, `api/src/routes/core.ts:497`, `api/src/routes/core.ts:512`, `api/src/routes/rules.ts:322`, `api/src/routes/rules.ts:330` |
| `not_eligible` | The waitlist is for orders refused only by a holder limit. {headline} |  | `api/src/routes/workflow.ts:303` |
| `not_in_review` | This inquiry is {status}, not waiting for review. |  | `api/src/routes/compliance2.ts:96`, `api/src/routes/compliance2.ts:110`, `api/src/routes/rules.ts:347`, `api/src/routes/rules.ts:364`, `api/src/routes/rules.ts:380`, `api/src/routes/rules.ts:386` |
| `not_needed` | This order is allowed right now. | Place it instead of waiting. | `api/src/routes/workflow.ts:302` |
| `not_onboarded` | {investorId} is not on-chain yet. | Settle a trade for this investor first, then simulate a break. | `api/src/chain.ts:888` |
| `not_open` | That invoice is not open, so it cannot be marked paid. |  | `api/src/internal.ts:102`, `api/src/internal.ts:109`, `api/src/routes/fundops2.ts:163`, `api/src/routes/fundops2.ts:185`, `api/src/routes/workflow.ts:460`, `api/src/routes/workflow.ts:467` |
| `not_pending` | This request is already {status}. |  | `api/src/approvals.ts:220`, `api/src/approvals.ts:266`, `api/src/approvals.ts:274`, `api/src/internal.ts:46`, `api/src/routes/fundops.ts:256` |
| `not_retryable` | This message is {status}. | Only failed, rejected or unanswered messages can be retried. | `api/src/routes/travel.ts:318` |
| `not_tested` | Run Test after the last edit, then send the rule for review. | Reviewers see the test results with the rule. | `api/src/routes/rules.ts:325` |
| `nothing_paid_in` | No capital has been paid in to {t} yet, so there is nothing to distribute against. |  | `api/src/routes/fundops2.ts:239` |
| `nothing_pending` | No {retry_failedissuedorfailedissued} notices left on this call{investor_idsfortheinvestorsnamed}. |  | `api/src/routes/fundops2.ts:190` |
| `nothing_to_pay` | No unpaid accruals for {ticker} between {periodStart} and {periodEnd}. | Run accruals first, or check whether the period was already paid. | `api/src/fundops-core.ts:341` |
| `notice_not_required` | {short} redeems without notice. | Place a redemption order instead. | `api/src/routes/fundops.ts:198` |
| `regression_failed` | {failed} of {total} regression cases for {pack} fail, so the draft was not approved. | Fix the engine or send force: true to approve anyway. | `api/src/routes/compliance.ts:405` |
| `rejected` | This submission was rejected. | Ask the client to submit again. | `api/src/routes/compliance2.ts:246` |
| `reverted` | The settlement of this decision ({id}) reverted. | Retry it from the settlement page, or request a new decision and settle that one. | `api/src/routes/core.ts:992`, `api/src/routes/core.ts:1051` |
| `running` | This job is running right now. | Wait for it to finish. | `api/src/chain.ts:899` |
| `settlement_not_pending` | The settlement is {status}. | Retry it from the settlement page (POST /v1/settlements/{ref}/retry), which re-checks the decision first. | `api/src/chain.ts:904` |
| `share_exists` | You already have a {status} share for this client ({id}). | Revoke it before you request a new one. | `api/src/routes/network.ts:65` |
| `sole_admin` | You are the only administrator of {join}. | Make someone else an administrator, or delete the organization, first. | `api/src/routes/security.ts:310` |
| `sso_not_configured` | Single sign-on is not configured yet. | Configure it with PUT /v1/sso first. | `api/src/routes/workflow.ts:175` |
| `sso_required` | Connect an identity provider first. | Group mapping applies to people who sign in through it. | `api/src/routes/account2.ts:118` |
| `state_changed` | The investor, counterparty or fund on this decision no longer exists. |  | `api/src/routes/core.ts:1000`, `api/src/routes/core.ts:1003`, `api/src/routes/core.ts:1125`, `api/src/routes/core.ts:1128` |
| `superseded` | Version {version} was replaced${cur ?  |  | `api/src/routes/fundops.ts:352`, `api/src/routes/portal.ts:193` |
| `terms_changed` | The text of this order form changed after it was issued. | Ask for a new one. | `api/src/routes/billing.ts:120` |
| `totp_already_enabled` | An authenticator app is already set up. | Turn it off first to set up a new one. | `api/src/routes/security.ts:197`, `api/src/routes/security.ts:208` |
| `totp_not_enabled` | No authenticator app is set up. |  | `api/src/routes/security.ts:222` |
| `totp_not_set_up` | Set up the authenticator app first. |  | `api/src/routes/portal-auth.ts:170` |
| `totp_not_started` | Start setup first to get a key. |  | `api/src/routes/security.ts:209` |
| `travel_rule_pending` | Waiting for the beneficiary institution to approve the Travel Rule message. | Try again in a few seconds. | `api/src/routes/core.ts:1005`, `api/src/routes/core.ts:1129` |
| `unchanged` | This content is identical to version {version}. | Nothing was published. | `api/src/routes/fundops.ts:301` |
| `unpaid_accruals` | {t} has {toFixed2} {currency} of accrued income not yet paid ({from} to {to}). | Pay the distribution before switching to an accumulating class. | `api/src/routes/fundops.ts:104` |
| `verify_email_changed` | The address on the account changed after this link was sent. | Use the newest link. | `api/src/routes/security.ts:66` |
| `webhook_deleted` | The webhook for this delivery was deleted, so there is nowhere to send it. | Create the webhook again. | `api/src/routes/platform.ts:234` |

## 410

| Code | Message | What to do | Thrown from |
| --- | --- | --- | --- |
| `consent_expired` | This consent request expired. | Ask the distributor to send a new one. | `api/src/routes/network.ts:228` |
| `invite_used` | This invite was already used or expired. | Your account exists; ask for a new invite. | `api/src/auth.ts:304` |
| `recovery_cancelled` | This recovery request was cancelled. | Ask for a new one if you still need it. | `api/src/routes/security.ts:122` |
| `recovery_expired` | This recovery link expired. | Ask for a new one from the sign-in screen. | `api/src/routes/security.ts:124` |
| `recovery_used` | This recovery link was already used. | Ask for a new one if you still need it. | `api/src/routes/security.ts:123`, `api/src/routes/security.ts:141` |

## 422

| Code | Message | What to do | Thrown from |
| --- | --- | --- | --- |
| `admin_required` | Settings changes must keep administrators among the approvers. |  | `api/src/routes/workflow.ts:102` |
| `bad_asset` | {short_name} settles only in {joinor}. |  | `api/src/routes/workflow.ts:296` |
| `below_called` | {name} has already been called for {currency} of {t}. | A commitment cannot be reduced below the amount called. | `api/src/routes/fundops2.ts:63` |
| `below_minimum` | The minimum subscription is {currency} {toLocaleStringenUS}. | Increase the amount. | `api/src/routes/portal.ts:270` |
| `channel_url_mismatch` | A Slack channel needs an incoming webhook URL on hooks.slack.com. | Create one under Slack apps, Incoming Webhooks. | `api/src/routes/integrations.ts:130`, `api/src/routes/integrations.ts:131` |
| `confirmation_mismatch` | Type your account email exactly to confirm. |  | `api/src/routes/security.ts:306` |
| `conflict` | A Regulation S fund cannot be offered to U.S. investors. | Remove US or turn off Regulation S. | `api/src/routes/core.ts:350`, `api/src/routes/core.ts:408` |
| `counterparty_required` | A transfer needs counterparty_id, the investor receiving the units. |  | `api/src/routes/core.ts:611`, `api/src/routes/core.ts:818`, `api/src/routes/portal.ts:281`, `api/src/routes/portal.ts:495`, `api/src/routes/rules.ts:195` |
| `documents_outstanding` | Read and acknowledge {length1thisdocumentthesedocuments} first. |  | `api/src/routes/portal.ts:300` |
| `duplicate_document` | Each document type can appear once per jurisdiction at creation. | Publish later versions from the fund page. | `api/src/routes/core.ts:356` |
| `duplicate_group` | {group} is listed twice. | Each group maps to one role. | `api/src/routes/account2.ts:120` |
| `duplicate_jurisdiction` | Each jurisdiction can appear once in the distribution list. |  | `api/src/routes/core.ts:411` |
| `empty` | Send at least one branding field to change. |  | `api/src/routes/brand.ts:84`, `api/src/routes/fundops.ts:101` |
| `exceeds_holding` | That is about {toLocaleStringenUSmaximumFractionDigits2})} units at today's price, but you hold {toLocaleStringenUS}. | Lower the amount. | `api/src/routes/portal.ts:276` |
| `exceeds_paid_in` | {currency} plus {currency} already returned exceeds the {currency} paid in. | Return at most {currency}, or record the excess as income. | `api/src/routes/fundops2.ts:242` |
| `future_date` | as_of cannot be in the future. | Use POST /v1/decisions with persist: false to evaluate today. | `api/src/routes/core.ts:817`, `api/src/routes/fundops.ts:27` |
| `idempotency_mismatch` | This Idempotency-Key was already used for a different request. | Use a new key for a new request. | `api/src/routes/platform.ts:62` |
| `import_invalid` | The file could not be read. {errors0} |  | `api/src/routes/import.ts:90` |
| `in_use` | You cannot revoke the key making this request. | Use another key or sign in. | `api/src/routes/platform.ts:165` |
| `inbound` | Only messages this organization sent can be retried. | The originator retries inbound messages. | `api/src/routes/travel.ts:317` |
| `incomplete` | Answer every question. | Missing: {join}. | `api/src/routes/workflow.ts:628` |
| `insufficient_units` | {name} holds {toLocaleStringenUS} units of {t}, and {toLocaleStringenUS} are already under notice. | At most {toLocaleStringenUS} more units can be noticed. | `api/src/routes/fundops.ts:208` |
| `invalid_cidr` | Not a valid IP address or CIDR range: {join}. | Use forms like 203.0.113.7 or 203.0.113.0/24. | `api/src/routes/platform.ts:128`, `api/src/routes/workflow.ts:161` |
| `invalid_date` | {as_of} is not a calendar date. |  | `api/src/routes/core.ts:816`, `api/src/routes/rules.ts:352` |
| `invalid_domain` | {portal_domain} is not a valid host name. | Use something like invest.yourbank.com, without https:// or a path. | `api/src/routes/brand.ts:93`, `api/src/routes/brand.ts:94` |
| `invalid_footer` | The email footer is plain text. | Remove the HTML tags. | `api/src/routes/brand.ts:96` |
| `invalid_name` | That name has no letters or digits left after removing company suffixes such as Ltd or LLC. | Enter the full legal name. | `api/src/routes/compliance.ts:55` |
| `invalid_nav` | NAV must be a positive number. |  | `api/src/fundops-core.ts:227` |
| `invalid_period` | The period must start on or before the day it ends. |  | `api/src/fundops-core.ts:310`, `api/src/fundops-core.ts:312` |
| `invalid_range` | The end date must be after the start date. |  | `api/src/internal.ts:73`, `api/src/routes/billing.ts:137` |
| `invalid_rule` | The rule does not make sense as written. | Fix the problems listed in detail. | `api/src/routes/rules.ts:74`, `api/src/routes/rules.ts:301`, `api/src/routes/rules.ts:324` |
| `invalid_threshold` | amount.{ccy} must be a positive number. |  | `api/src/routes/workflow.ts:114`, `api/src/routes/workflow.ts:120` |
| `invalid_time_zone` | {cutoff_tz} is not an IANA time zone. | Use a name like America/New_York. | `api/src/routes/core.ts:351` |
| `invalid_value` | {label} needs a number, got {stringifyx}. |  | `api/src/routes/reports2.ts:133`, `api/src/routes/reports2.ts:134`, `api/src/routes/reports2.ts:146`, `api/src/routes/reports2.ts:151` |
| `invite_domain_not_allowed` | Your security policy only allows invitations to the email domains it lists. | Add the domain under Settings, Security, or invite a company address. | `api/src/auth.ts:668` |
| `last_admin` | An organization needs at least one administrator. |  | `api/src/auth.ts:640`, `api/src/auth.ts:653`, `api/src/routes/workflow.ts:149` |
| `last_passkey` | This is your only passkey. | Add another before removing it. | `api/src/auth.ts:620` |
| `limit` | An organization can have up to {MAX_CHANNELS} notification channels. | Remove one first. | `api/src/routes/integrations.ts:133`, `api/src/routes/platform.ts:130`, `api/src/routes/platform.ts:185`, `api/src/routes/portal.ts:221`, `api/src/routes/portal.ts:271`, `api/src/routes/workflow.ts:163` |
| `name_mismatch` | Type the organization name exactly as it appears: {name}. |  | `api/src/routes/account2.ts:241` |
| `no_change` | Nothing differs from the current record. |  | `api/src/routes/workflow.ts:251`, `api/src/routes/workflow.ts:552` |
| `no_holding` | {name} holds no {t}. |  | `api/src/routes/fundops.ts:204`, `api/src/routes/portal.ts:274` |
| `no_policy_in_force` | No published policy of {fund} was in force on {as_of}. |  | `api/src/routes/core.ts:843` |
| `no_test` | {class_code} has no threshold test for a {toLowerCase}, so it cannot be issued from evidence. |  | `api/src/routes/compliance2.ts:248` |
| `no_text` | Laissez has not read the text of this publication yet. | The feed job fetches it every six hours; try again after the next run, or paste the text into a new draft. | `api/src/routes/compliance.ts:356` |
| `not_required` | The Travel Rule applies to transfers of USD or EUR 1,000 and above. | This decision does not need a message. | `api/src/routes/travel.ts:305` |
| `note_required` | Say why the organization was rejected; the customer sees it. |  | `api/src/internal.ts:42`, `api/src/routes/chain.ts:96` |
| `org_required` | Name your organization, or use an invite link to join one. |  | `api/src/auth.ts:255` |
| `passkey_required` | Add a passkey first. | Without one there is no way back into the organization after this browser session ends. | `api/src/routes/account2.ts:214` |
| `past_date` | effective_from cannot be in the past. | Today is {t}. | `api/src/routes/rules.ts:351`, `api/src/routes/rules.ts:405` |
| `past_due_date` | The due date {due_on} is in the past. | Give investors a date on or after today. | `api/src/routes/fundops2.ts:130` |
| `policy_locks_you_out` | This allowlist does not include your own address ({ipunknown}), so saving it would lock you out. | Add your network first. | `api/src/routes/security.ts:246`, `api/src/routes/security.ts:248` |
| `profile_required` | Set your real name and email first (PATCH /v1/me), so the organization has an owner who can sign back in. |  | `api/src/routes/account2.ts:213` |
| `purpose_required` | Say why you are opening the evidence (?purpose=...). | It is written to the access log. | `api/src/routes/kyc.ts:52` |
| `real_email_required` | Use a real email address you can receive mail at. |  | `api/src/auth.ts:478`, `api/src/routes/billing.ts:176`, `api/src/routes/security.ts:169` |
| `recipients_required` | A scheduled report needs at least one recipient email address. |  | `api/src/routes/reports2.ts:211` |
| `same_party` | The sender and the receiver are the same investor. | Pick a different counterparty. | `api/src/routes/core.ts:612` |
| `secret_required` | Add the client secret from your identity provider. |  | `api/src/auth.ts:710` |
| `sso_not_enabled` | Turn on single sign-on for this organization before requiring it. |  | `api/src/routes/security.ts:249` |
| `terms_required` | Accept the Terms of Service and the Privacy Policy to create an account. |  | `api/src/auth.ts:243` |
| `threshold_not_met` | The figures do not meet the threshold, so nothing was issued. {reason} |  | `api/src/routes/compliance2.ts:251`, `api/src/routes/core.ts:235` |
| `too_many_destinations` | An organization can have five audit export destinations. | Remove one first. | `api/src/siem.ts:40` |
| `too_old` | NAVs older than 400 days cannot be restruck here. |  | `api/src/routes/fundops.ts:135` |
| `totp_required` | Enter the six-digit code from your authenticator app. |  | `api/src/routes/security.ts:128` |
| `unknown_booking_center` | Booking center {booking_center} does not exist. | See GET /v1/booking-centers. | `api/src/routes/core.ts:180`, `api/src/routes/network.ts:53`, `api/src/routes/workflow.ts:244` |
| `unknown_class` | Unknown investor class {x}. | See GET /v1/investor-classes. | `api/src/routes/core.ts:348`, `api/src/routes/core.ts:409`, `api/src/routes/portal.ts:220` |
| `unknown_column` | {what} {k} is not a column of {label}. | See GET /v1/reports/catalog. | `api/src/routes/reports2.ts:123`, `api/src/routes/reports2.ts:175` |
| `unknown_event` | Event {event} is not recorded. | Allowed: {join}. | `api/src/routes/platform.ts:326` |
| `unknown_jurisdiction` | Residence {residence} is not a supported jurisdiction. | See GET /v1/jurisdictions. | `api/src/routes/core.ts:179`, `api/src/routes/core.ts:353`, `api/src/routes/fundops.ts:296`, `api/src/routes/workflow.ts:243` |
| `unknown_operator` | Operator {op} does not apply to {label} ({type}). | Allowed: {join}. | `api/src/routes/reports2.ts:131` |
| `unknown_scope` | Unknown scope {join}. | Use {join}. | `api/src/routes/workflow.ts:159` |
| `unknown_source` | Unknown report source {source}. |  | `api/src/routes/reports2.ts:120` |
| `unsupported_asset` | {name} settles only in {joinor}. | Choose one of those. | `api/src/routes/portal.ts:269` |
| `unsupported_jurisdiction` | No launch rule pack covers {jurisdiction} yet. | Remove it from the distribution list. | `api/src/routes/core.ts:347`, `api/src/routes/core.ts:407` |
| `wrong_form` | A U.S. person certifies on Form W-9, not a W-8. |  | `api/src/routes/workflow.ts:691`, `api/src/routes/workflow.ts:692` |

## 429

| Code | Message | What to do | Thrown from |
| --- | --- | --- | --- |
| `quota_exceeded` | This organization has used its {toLocaleStringenUS} requests for the month. | The quota resets on {slice010}. | `api/src/auth.ts:105` |
| `rate_limited` | More than 600 requests in a minute. | Wait a moment and retry. | `api/src/auth.ts:164`, `api/src/auth.ts:174`, `api/src/auth.ts:212`, `api/src/auth.ts:242`, `api/src/auth.ts:334`, `api/src/auth.ts:562` and 21 more |

## 500

| Code | Message | What to do | Thrown from |
| --- | --- | --- | --- |
| `internal_error` | Something went wrong on our side. | The request was not applied. Retry, and contact us if it keeps failing. | `api/src/index.ts:65` |

## 501

| Code | Message | What to do | Thrown from |
| --- | --- | --- | --- |
| `no_executor` | Approval kind {kind} has no executor registered on this deployment. |  | `api/src/approvals.ts:157`, `api/src/approvals.ts:239` |
| `not_configured` | Staff routes are off: INTERNAL_TOKEN is not set on this deployment. |  | `api/src/internal.ts:22`, `api/src/kyc.ts:25`, `api/src/kyc.ts:31`, `api/src/oidc.ts:99`, `api/src/routes/billing.ts:188`, `api/src/routes/compliance.ts:325` and 2 more |

## 502

| Code | Message | What to do | Thrown from |
| --- | --- | --- | --- |
| `agent_failed` | The drafting agent could not be reached. | Nothing was saved; try again in a minute. | `api/src/routes/compliance.ts:306`, `api/src/routes/compliance.ts:308` |
| `agent_unparseable` | The draft could not be read as structured data. | Nothing was saved; try again. | `api/src/routes/compliance.ts:316` |
| `chain_unavailable` | The settlement could not be queued on chain. | Nothing moved. Request a new decision and try again. | `api/src/routes/core.ts:1029`, `api/src/routes/core.ts:1149` |
| `import_chunk_failed` | The chunk starting at row {cursor1} could not be applied: {msg} Nothing from that chunk was written. | Apply again to retry it. | `api/src/routes/import.ts:272` |
| `kyc_provider_error` | The identity provider answered {status}. {message} |  | `api/src/kyc.ts:64` |
| `sso_discovery_failed` | Could not read the identity provider configuration from {issuer}. |  | `api/src/oidc.ts:24` |
| `sso_issuer_mismatch` | The identity provider reported a different issuer. |  | `api/src/oidc.ts:26` |
| `sso_jwks_failed` | Could not read the identity provider signing keys. |  | `api/src/oidc.ts:42` |

## 503

| Code | Message | What to do | Thrown from |
| --- | --- | --- | --- |
| `bot_check_unavailable` | The security check could not be reached. | Try again in a minute. | `api/src/account-security.ts:35` |
| `capacity` | All sandboxes are in use right now. | Try again tomorrow. | `api/src/auth.ts:214` |
| `email_not_configured` | Sign-up is closed until outgoing email is configured on this deployment. | Contact the operator. | `api/src/auth.ts:246` |
