# API error codes

Generated from the source by `npm run docs:errors` on 2026-10-02. 198 codes across 447 throw sites, plus 1 call that passes a computed code and is not listed.

Every error response is `{"error": {"code", "message", "detail"}}`. The code is stable and snake_case; the message says what happened and, where there is something to do, how to fix it. The same list is served at `GET /v1/errors`.

## 400

| Code | Message | What to do | Thrown from |
| --- | --- | --- | --- |
| `bad_origin` | Passkeys for Laissez only work on {origins0}. |  | `api/src/webauthn.ts:18` |
| `bad_passkey` | The passkey response could not be read. |  | `api/src/webauthn.ts:15`, `api/src/webauthn.ts:16`, `api/src/webauthn.ts:17`, `api/src/webauthn.ts:23`, `api/src/webauthn.ts:51`, `api/src/webauthn.ts:53` |
| `challenge_expired` | This sign-up request expired. | Start again. | `api/src/auth.ts:223`, `api/src/auth.ts:259`, `api/src/auth.ts:471` |
| `cloned_passkey` | This passkey looks cloned. | Sign in with another passkey and remove this one. | `api/src/webauthn.ts:55` |
| `http_error` | The request could not be processed. |  | `api/src/index.ts:62` |
| `invalid_confirmation` | A confirmation needs txid, or canceled with a reason. |  | `api/src/routes/travel.ts:246` |
| `invalid_cursor` | The cursor is not valid. | Use the next_cursor value from the previous page. | `api/src/pagination.ts:22`, `api/src/pagination.ts:24`, `api/src/pagination.ts:26` |
| `invalid_filter` | credential_status must be one of {join}. |  | `api/src/routes/core.ts:111`, `api/src/routes/core.ts:668`, `api/src/routes/core.ts:669`, `api/src/routes/core.ts:1030`, `api/src/routes/network.ts:106`, `api/src/routes/workflow.ts:38` and 3 more |
| `invalid_idempotency_key` | Idempotency-Key must be 1 to 255 characters. | A UUID works well. | `api/src/routes/platform.ts:48` |
| `invalid_inquiry` | A TRP inquiry needs asset, amount, callback and IVMS101. |  | `api/src/routes/travel.ts:168` |
| `invalid_request` | The request body is not valid. | Fix the fields listed in detail and retry. | `api/src/index.ts:60` |
| `invalid_resolution` | A resolution needs approved {address, callback} or rejected. |  | `api/src/routes/travel.ts:228`, `api/src/routes/travel.ts:229` |
| `invalid_status` | Status must be one of {join}. | You sent "{s}". | `api/src/routes/compliance.ts:24` |
| `missing_parameter` | Send fund and jurisdiction query parameters. |  | `api/src/routes/compliance2.ts:182` |
| `missing_request_identifier` | Send a request-identifier header. | TRP uses one identifier for the whole transfer. | `api/src/routes/travel.ts:150` |
| `sso_code_expired` | This sign-in link expired. | Start single sign-on again. | `api/src/auth.ts:358` |
| `unsupported_alg` | This passkey uses an algorithm Laissez does not accept. |  | `api/src/webauthn.ts:26` |
| `unsupported_version` | This endpoint speaks TRP {TRP_VERSION}. | Send an api-version header starting with 3. | `api/src/routes/travel.ts:151`, `api/src/version.ts:31` |

## 401

| Code | Message | What to do | Thrown from |
| --- | --- | --- | --- |
| `bad_signature` | The passkey signature did not verify. |  | `api/src/webauthn.ts:68` |
| `portal_link_expired` | This portal link has expired or was withdrawn. | Ask your distributor for a new link. | `api/src/routes/brand.ts:127`, `api/src/routes/portal.ts:35` |
| `portal_unauthorized` | Open the portal from the link your distributor sent you. |  | `api/src/routes/brand.ts:122`, `api/src/routes/portal.ts:30` |
| `recovery_invalid` | That email and recovery code do not match, or the code was already used. |  | `api/src/routes/account2.ts:94` |
| `session_expired` | Your session has ended. | Sign in again. | `api/src/auth.ts:105` |
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
| `unauthorized` | This key is not valid, has expired, or its sandbox has expired. |  | `api/src/auth.ts:118`, `api/src/auth.ts:128` |
| `unknown_passkey` | This passkey is not registered with Laissez. | Create an account first. | `api/src/auth.ts:262` |

## 403

| Code | Message | What to do | Thrown from |
| --- | --- | --- | --- |
| `account_required` | Passkeys belong to real accounts. | Create an account to add one. | `api/src/auth.ts:456`, `api/src/auth.ts:459`, `api/src/routes/account2.ts:77` |
| `acting_as` | Switch back to yourself before editing your profile. |  | `api/src/auth.ts:381`, `api/src/routes/account2.ts:19` |
| `forbidden` | Approving {toLowerCase} needs one of these roles: {join}. |  | `api/src/approvals.ts:208`, `api/src/http.ts:68`, `api/src/routes/account2.ts:240` |
| `human_required` | Only a signed-in person can approve or reject. | API keys can request, not approve. | `api/src/approvals.ts:205`, `api/src/auth.ts:380`, `api/src/auth.ts:396`, `api/src/auth.ts:411`, `api/src/auth.ts:427`, `api/src/auth.ts:438` and 3 more |
| `insufficient_scope` | This API key is not allowed to {PERM_TEXTpermperm}. | Add the right scope or use another key. | `api/src/http.ts:67` |
| `ip_not_allowed` | Requests from {ipthisaddress} are not on this key's IP allowlist. |  | `api/src/auth.ts:121` |
| `no_organization` | Your account is not a member of any organization. | Ask an administrator for an invite. | `api/src/auth.ts:267`, `api/src/routes/account2.ts:99` |
| `not_a_member` | You are not a member of that organization. |  | `api/src/auth.ts:414` |
| `recovery_session` | You signed in with a recovery code. | Add a passkey on the Security page, then sign in with it to continue. | `api/src/auth.ts:108` |
| `same_person` | You requested this. | A second person must decide it.{value} | `api/src/approvals.ts:207`, `api/src/routes/core.ts:433` |
| `sandbox_only` | Acting as a teammate exists only in sandboxes. | This deployment runs in production mode. | `api/src/auth.ts:397`, `api/src/auth.ts:398`, `api/src/auth.ts:557`, `api/src/routes/account2.ts:135`, `api/src/routes/account2.ts:178`, `api/src/routes/account2.ts:201` and 2 more |
| `scope_escalation` | This key cannot create a key with scopes it does not have: {join}. |  | `api/src/routes/platform.ts:122`, `api/src/routes/platform.ts:146` |

## 404

| Code | Message | What to do | Thrown from |
| --- | --- | --- | --- |
| `consent_not_found` | This consent link is not valid. | Ask the distributor that sent it for a new one. | `api/src/routes/network.ts:170`, `api/src/routes/network.ts:172` |
| `counterparty_not_found` | No client called "{key}" at your distributor. | Check the passport number or the exact legal name with them. | `api/src/routes/portal.ts:265` |
| `invite_invalid` | This invite link is invalid or has expired. | Ask for a new one. | `api/src/auth.ts:187`, `api/src/auth.ts:276`, `api/src/auth.ts:429` |
| `not_found` | No approval request {reqId} in this organization. |  | `api/src/approvals.ts:191`, `api/src/auth.ts:402`, `api/src/auth.ts:446`, `api/src/auth.ts:481`, `api/src/auth.ts:500`, `api/src/auth.ts:510` and 109 more |
| `passport_not_found` | No active credential with that passport number is available to you. | Check the number with the client or the issuing distributor. | `api/src/routes/network.ts:58` |
| `unknown_beneficiary_vasp` | No VASP is registered at this Travel Address. |  | `api/src/routes/travel.ts:164`, `api/src/routes/travel.ts:177` |
| `unknown_flag` | No feature flag named {key}. | See GET /v1/flags for the list. | `api/src/flags.ts:93` |

## 409

| Code | Message | What to do | Thrown from |
| --- | --- | --- | --- |
| `account_exists` | An account with this email already exists. | Sign in with your passkey instead. | `api/src/auth.ts:183`, `api/src/auth.ts:227` |
| `already_approved` | You already approved this request. | Another approver has to add theirs. | `api/src/approvals.ts:209` |
| `already_called` | {currency} has already been called against this commitment. | Reduce it to the called amount instead of removing it. | `api/src/routes/fundops2.ts:83` |
| `already_decided` | This hit was already marked {status} by {decided_byanotherreviewer}. | Decisions are kept for the audit trail; screen the name again if the facts changed. | `api/src/routes/compliance.ts:175`, `api/src/routes/compliance.ts:415`, `api/src/routes/network.ts:195`, `api/src/routes/network.ts:199`, `api/src/routes/network.ts:209`, `api/src/routes/portal.ts:454` and 1 more |
| `already_resolved` | Break {breakId} is already resolved ({resolution}). |  | `api/src/chain.ts:980`, `api/src/routes/compliance.ts:224` |
| `already_rotated` | This key was already rotated. | Rotate its replacement instead. | `api/src/routes/platform.ts:145` |
| `already_sent` | A transaction for this job is already on chain, so it cannot be cancelled. | Wait for the receipt. | `api/src/chain.ts:911`, `api/src/routes/core.ts:1135`, `api/src/routes/core.ts:1147` |
| `already_settled` | This decision already settled as {id} ({status}). |  | `api/src/routes/core.ts:947`, `api/src/routes/core.ts:971`, `api/src/routes/core.ts:998` |
| `already_waiting` | {name} is already on the {ticker} waitlist as {id}. |  | `api/src/routes/workflow.ts:295` |
| `approval_pending` | This order is waiting for approval, so it cannot join the waitlist yet. |  | `api/src/routes/workflow.ts:298` |
| `before_cutoff` | The cut-off for dealing {dealing_date} is {toISOString}. | Orders can still arrive until then. Send force: true to close it early. | `api/src/routes/workflow.ts:459` |
| `call_open` | Capital call {call_number} ({id}) is still open. | Settle or cancel it before issuing another. | `api/src/routes/fundops2.ts:134` |
| `cancelled` | This job was cancelled. | Request a new decision to settle again. | `api/src/chain.ts:891`, `api/src/routes/core.ts:946` |
| `chain_not_configured` | On-chain settlement is not configured, so there is nothing to reconcile. |  | `api/src/chain.ts:874`, `api/src/chain.ts:922`, `api/src/chain.ts:986` |
| `confirm_large_move` | This NAV is {toFixed2}% away from the {date} strike of {toFixed4}. | Check it, then send confirm: true to strike it. | `api/src/routes/fundops.ts:139` |
| `confirmed` | This job already confirmed on chain. | There is nothing to retry. | `api/src/chain.ts:890` |
| `counterparty_ambiguous` | More than one client has that name. | Use their passport number instead. | `api/src/routes/portal.ts:266` |
| `credential_expired` | This credential expired on {expires_on}. | Ask the issuing distributor to renew it before you rely on it. | `api/src/routes/network.ts:63` |
| `credential_not_active` | Your credential with {from_name} is no longer active, so it cannot be shared. | Ask {from_name} to renew it. | `api/src/routes/network.ts:206` |
| `domain_taken` | Another organization already uses single sign-on for {email_domain}. |  | `api/src/auth.ts:565` |
| `draft_exists` | Draft {id} for this publication is already waiting for review. | Approve or reject it before drafting again. | `api/src/routes/compliance.ts:354` |
| `email_taken` | An account with this email already exists. | Sign in with it instead. | `api/src/auth.ts:386`, `api/src/routes/account2.ts:216` |
| `exists` | A fund with ticker {ticker} already exists. | Pick another ticker. | `api/src/routes/core.ts:322`, `api/src/routes/travel.ts:308` |
| `expired` | Settlement instructions expire 15 minutes after the decision. | Request a new decision. | `api/src/routes/core.ts:942` |
| `fully_called` | Every commitment to {t} has been called in full. | Record new commitments before issuing another call. | `api/src/routes/fundops2.ts:140` |
| `hypothetical` | This decision used what-if scenarios, so it is hypothetical and cannot settle. | Request a decision without what_ifs. | `api/src/routes/core.ts:941` |
| `idempotency_in_progress` | A request with this Idempotency-Key is still running. | Retry in a few seconds. | `api/src/routes/platform.ts:59` |
| `in_batch` | This decision deals on {batch_dealing_date} in batch {batch_id}, which is still open. | Close and settle the batch, or send force: true to settle this order alone. | `api/src/routes/core.ts:1020` |
| `in_progress` | Someone else is deciding this request right now. | Reload in a moment. | `api/src/approvals.ts:230` |
| `no_account` | The beneficiary account behind this inquiry no longer exists, so it cannot be approved. | Reject it instead. | `api/src/routes/compliance2.ts:97` |
| `no_commitments` | No commitments recorded for {t}. | Record commitments before issuing a capital call. | `api/src/routes/fundops2.ts:132` |
| `no_nav` | Strike a NAV for {ticker} before paying a distribution. |  | `api/src/fundops-core.ts:314` |
| `no_snapshot` | This decision was made before Laissez stored decision snapshots, so it cannot be replayed. | Decisions made from now on can. | `api/src/routes/core.ts:732` |
| `no_yield` | Set a yield for {t} in its terms before running accruals. |  | `api/src/routes/fundops.ts:154` |
| `not_active` | This share is already {status}. |  | `api/src/routes/network.ts:128`, `api/src/routes/network.ts:264`, `api/src/routes/network.ts:267` |
| `not_allowed` | Only allowed decisions can settle. | Fix the refusal and request a new decision. | `api/src/routes/core.ts:940`, `api/src/routes/core.ts:1073`, `api/src/routes/travel.ts:306` |
| `not_approved` | This transfer was not approved, so it cannot be confirmed. |  | `api/src/routes/travel.ts:244`, `api/src/routes/travel.ts:338` |
| `not_cancellable` | This job is {status} and cannot be cancelled. |  | `api/src/chain.ts:912`, `api/src/routes/core.ts:1134` |
| `not_closed` | Close the batch first. | Settlement runs on a closed batch. | `api/src/routes/workflow.ts:475` |
| `not_closed_end` | {short} is an open-ended fund. | Commitments and capital calls apply to closed-end funds only. Create the fund with fund_type "closed_end". | `api/src/routes/fundops2.ts:23` |
| `not_distributing` | {short} is an accumulating class. | Income stays in the NAV, so there is nothing to distribute. | `api/src/fundops-core.ts:309`, `api/src/routes/fundops.ts:153` |
| `not_draft` | This change is already {status}. | Propose a new change to make further edits. | `api/src/routes/core.ts:430`, `api/src/routes/core.ts:459`, `api/src/routes/core.ts:474` |
| `not_eligible` | The waitlist is for orders refused only by a holder limit. {headline} |  | `api/src/routes/workflow.ts:301` |
| `not_in_review` | This inquiry is {status}, not waiting for review. |  | `api/src/routes/compliance2.ts:96`, `api/src/routes/compliance2.ts:110` |
| `not_needed` | This order is allowed right now. | Place it instead of waiting. | `api/src/routes/workflow.ts:300` |
| `not_onboarded` | {investorId} is not on-chain yet. | Settle a trade for this investor first, then simulate a break. | `api/src/chain.ts:878` |
| `not_open` | This call is already {status}. |  | `api/src/routes/fundops2.ts:163`, `api/src/routes/fundops2.ts:185`, `api/src/routes/workflow.ts:458`, `api/src/routes/workflow.ts:465` |
| `not_pending` | This request is already {status}. |  | `api/src/approvals.ts:220`, `api/src/approvals.ts:266`, `api/src/approvals.ts:274`, `api/src/routes/fundops.ts:256` |
| `not_retryable` | This message is {status}. | Only failed, rejected or unanswered messages can be retried. | `api/src/routes/travel.ts:318` |
| `nothing_paid_in` | No capital has been paid in to {t} yet, so there is nothing to distribute against. |  | `api/src/routes/fundops2.ts:239` |
| `nothing_pending` | No {retry_failedissuedorfailedissued} notices left on this call{investor_idsfortheinvestorsnamed}. |  | `api/src/routes/fundops2.ts:190` |
| `nothing_to_pay` | No unpaid accruals for {ticker} between {periodStart} and {periodEnd}. | Run accruals first, or check whether the period was already paid. | `api/src/fundops-core.ts:341` |
| `notice_not_required` | {short} redeems without notice. | Place a redemption order instead. | `api/src/routes/fundops.ts:198` |
| `regression_failed` | {failed} of {total} regression cases for {pack} fail, so the draft was not approved. | Fix the engine or send force: true to approve anyway. | `api/src/routes/compliance.ts:405` |
| `rejected` | This submission was rejected. | Ask the client to submit again. | `api/src/routes/compliance2.ts:246` |
| `reverted` | The settlement of this decision ({id}) reverted. | Retry it from the settlement page, or request a new decision and settle that one. | `api/src/routes/core.ts:945`, `api/src/routes/core.ts:1004` |
| `running` | This job is running right now. | Wait for it to finish. | `api/src/chain.ts:889` |
| `settlement_not_pending` | The settlement is {status}. | Retry it from the settlement page (POST /v1/settlements/{ref}/retry), which re-checks the decision first. | `api/src/chain.ts:894` |
| `share_exists` | You already have a {status} share for this client ({id}). | Revoke it before you request a new one. | `api/src/routes/network.ts:65` |
| `sso_not_configured` | Single sign-on is not configured yet. | Configure it with PUT /v1/sso first. | `api/src/routes/workflow.ts:173` |
| `sso_required` | Connect an identity provider first. | Group mapping applies to people who sign in through it. | `api/src/routes/account2.ts:118` |
| `state_changed` | The investor, counterparty or fund on this decision no longer exists. |  | `api/src/routes/core.ts:953`, `api/src/routes/core.ts:956`, `api/src/routes/core.ts:1077`, `api/src/routes/core.ts:1080` |
| `superseded` | Version {version} was replaced${cur ?  |  | `api/src/routes/fundops.ts:352`, `api/src/routes/portal.ts:172` |
| `travel_rule_pending` | Waiting for the beneficiary institution to approve the Travel Rule message. | Try again in a few seconds. | `api/src/routes/core.ts:958`, `api/src/routes/core.ts:1081` |
| `unchanged` | This content is identical to version {version}. | Nothing was published. | `api/src/routes/fundops.ts:301` |
| `unpaid_accruals` | {t} has {toFixed2} {currency} of accrued income not yet paid ({from} to {to}). | Pay the distribution before switching to an accumulating class. | `api/src/routes/fundops.ts:104` |
| `webhook_deleted` | The webhook for this delivery was deleted, so there is nowhere to send it. | Create the webhook again. | `api/src/routes/platform.ts:229` |

## 410

| Code | Message | What to do | Thrown from |
| --- | --- | --- | --- |
| `consent_expired` | This consent request expired. | Ask the distributor to send a new one. | `api/src/routes/network.ts:194` |
| `invite_used` | This invite was already used or expired. | Your account exists; ask for a new invite. | `api/src/auth.ts:235` |

## 422

| Code | Message | What to do | Thrown from |
| --- | --- | --- | --- |
| `admin_required` | Settings changes must keep administrators among the approvers. |  | `api/src/routes/workflow.ts:100` |
| `bad_asset` | {short_name} settles only in {joinor}. |  | `api/src/routes/workflow.ts:294` |
| `below_called` | {name} has already been called for {currency} of {t}. | A commitment cannot be reduced below the amount called. | `api/src/routes/fundops2.ts:63` |
| `below_minimum` | The minimum subscription is {currency} {toLocaleStringenUS}. | Increase the amount. | `api/src/routes/portal.ts:249` |
| `channel_url_mismatch` | A Slack channel needs an incoming webhook URL on hooks.slack.com. | Create one under Slack apps, Incoming Webhooks. | `api/src/routes/integrations.ts:130`, `api/src/routes/integrations.ts:131` |
| `conflict` | A Regulation S fund cannot be offered to U.S. investors. | Remove US or turn off Regulation S. | `api/src/routes/core.ts:313`, `api/src/routes/core.ts:371` |
| `counterparty_required` | A transfer needs counterparty_id, the investor receiving the units. |  | `api/src/routes/core.ts:570`, `api/src/routes/core.ts:771`, `api/src/routes/portal.ts:260`, `api/src/routes/portal.ts:455` |
| `documents_outstanding` | Read and acknowledge {length1thisdocumentthesedocuments} first. |  | `api/src/routes/portal.ts:279` |
| `duplicate_document` | Each document type can appear once per jurisdiction at creation. | Publish later versions from the fund page. | `api/src/routes/core.ts:319` |
| `duplicate_group` | {group} is listed twice. | Each group maps to one role. | `api/src/routes/account2.ts:120` |
| `duplicate_jurisdiction` | Each jurisdiction can appear once in the distribution list. |  | `api/src/routes/core.ts:374` |
| `empty` | Send at least one branding field to change. |  | `api/src/routes/brand.ts:84`, `api/src/routes/fundops.ts:101` |
| `exceeds_holding` | That is about {toLocaleStringenUSmaximumFractionDigits2})} units at today's price, but you hold {toLocaleStringenUS}. | Lower the amount. | `api/src/routes/portal.ts:255` |
| `exceeds_paid_in` | {currency} plus {currency} already returned exceeds the {currency} paid in. | Return at most {currency}, or record the excess as income. | `api/src/routes/fundops2.ts:242` |
| `future_date` | as_of cannot be in the future. | Use POST /v1/decisions with persist: false to evaluate today. | `api/src/routes/core.ts:770`, `api/src/routes/fundops.ts:27` |
| `idempotency_mismatch` | This Idempotency-Key was already used for a different request. | Use a new key for a new request. | `api/src/routes/platform.ts:60` |
| `in_use` | You cannot revoke the key making this request. | Use another key or sign in. | `api/src/routes/platform.ts:160` |
| `inbound` | Only messages this organization sent can be retried. | The originator retries inbound messages. | `api/src/routes/travel.ts:317` |
| `incomplete` | Answer every question. | Missing: {join}. | `api/src/routes/workflow.ts:626` |
| `insufficient_units` | {name} holds {toLocaleStringenUS} units of {t}, and {toLocaleStringenUS} are already under notice. | At most {toLocaleStringenUS} more units can be noticed. | `api/src/routes/fundops.ts:208` |
| `invalid_cidr` | Not a valid IP address or CIDR range: {join}. | Use forms like 203.0.113.7 or 203.0.113.0/24. | `api/src/routes/platform.ts:125`, `api/src/routes/workflow.ts:159` |
| `invalid_date` | {as_of} is not a calendar date. |  | `api/src/routes/core.ts:769` |
| `invalid_domain` | {portal_domain} is not a valid host name. | Use something like invest.yourbank.com, without https:// or a path. | `api/src/routes/brand.ts:93`, `api/src/routes/brand.ts:94` |
| `invalid_footer` | The email footer is plain text. | Remove the HTML tags. | `api/src/routes/brand.ts:96` |
| `invalid_name` | That name has no letters or digits left after removing company suffixes such as Ltd or LLC. | Enter the full legal name. | `api/src/routes/compliance.ts:55` |
| `invalid_nav` | NAV must be a positive number. |  | `api/src/fundops-core.ts:227` |
| `invalid_period` | The period must start on or before the day it ends. |  | `api/src/fundops-core.ts:310`, `api/src/fundops-core.ts:312` |
| `invalid_threshold` | amount.{ccy} must be a positive number. |  | `api/src/routes/workflow.ts:112`, `api/src/routes/workflow.ts:118` |
| `invalid_time_zone` | {cutoff_tz} is not an IANA time zone. | Use a name like America/New_York. | `api/src/routes/core.ts:314` |
| `invalid_value` | {label} needs a number, got {stringifyx}. |  | `api/src/routes/reports2.ts:132`, `api/src/routes/reports2.ts:133`, `api/src/routes/reports2.ts:145`, `api/src/routes/reports2.ts:150` |
| `last_admin` | An organization needs at least one administrator. |  | `api/src/auth.ts:497`, `api/src/auth.ts:508`, `api/src/routes/workflow.ts:147` |
| `last_passkey` | This is your only passkey. | Add another before removing it. | `api/src/auth.ts:479` |
| `limit` | An organization can have up to {MAX_CHANNELS} notification channels. | Remove one first. | `api/src/routes/integrations.ts:133`, `api/src/routes/platform.ts:127`, `api/src/routes/platform.ts:180`, `api/src/routes/portal.ts:200`, `api/src/routes/portal.ts:250`, `api/src/routes/workflow.ts:161` |
| `name_mismatch` | Type the organization name exactly as it appears: {name}. |  | `api/src/routes/account2.ts:241` |
| `no_change` | Nothing differs from the current record. |  | `api/src/routes/workflow.ts:249`, `api/src/routes/workflow.ts:550` |
| `no_holding` | {name} holds no {t}. |  | `api/src/routes/fundops.ts:204`, `api/src/routes/portal.ts:253` |
| `no_policy_in_force` | No published policy of {fund} was in force on {as_of}. |  | `api/src/routes/core.ts:796` |
| `no_test` | {class_code} has no threshold test for a {toLowerCase}, so it cannot be issued from evidence. |  | `api/src/routes/compliance2.ts:248` |
| `no_text` | Laissez has not read the text of this publication yet. | The feed job fetches it every six hours; try again after the next run, or paste the text into a new draft. | `api/src/routes/compliance.ts:356` |
| `not_required` | The Travel Rule applies to transfers of USD or EUR 1,000 and above. | This decision does not need a message. | `api/src/routes/travel.ts:305` |
| `note_required` | Write a short note on what you found before resolving the break. | It goes in the audit log with your name. | `api/src/routes/chain.ts:80` |
| `org_required` | Name your organization, or use an invite link to join one. |  | `api/src/auth.ts:188` |
| `passkey_required` | Add a passkey first. | Without one there is no way back into the organization after this browser session ends. | `api/src/routes/account2.ts:214` |
| `past_due_date` | The due date {due_on} is in the past. | Give investors a date on or after today. | `api/src/routes/fundops2.ts:130` |
| `profile_required` | Set your real name and email first (PATCH /v1/me), so the organization has an owner who can sign back in. |  | `api/src/routes/account2.ts:213` |
| `real_email_required` | Use a real email address you can receive mail at. |  | `api/src/auth.ts:384` |
| `recipients_required` | A scheduled report needs at least one recipient email address. |  | `api/src/routes/reports2.ts:214` |
| `same_party` | The sender and the receiver are the same investor. | Pick a different counterparty. | `api/src/routes/core.ts:571` |
| `secret_required` | Add the client secret from your identity provider. |  | `api/src/auth.ts:562` |
| `threshold_not_met` | The figures do not meet the threshold, so nothing was issued. {reason} |  | `api/src/routes/compliance2.ts:251`, `api/src/routes/core.ts:200` |
| `too_old` | NAVs older than 400 days cannot be restruck here. |  | `api/src/routes/fundops.ts:135` |
| `unknown_booking_center` | Booking center {booking_center} does not exist. | See GET /v1/booking-centers. | `api/src/routes/core.ts:145`, `api/src/routes/network.ts:53`, `api/src/routes/workflow.ts:242` |
| `unknown_class` | Unknown investor class {x}. | See GET /v1/investor-classes. | `api/src/routes/core.ts:311`, `api/src/routes/core.ts:372`, `api/src/routes/portal.ts:199` |
| `unknown_column` | {what} {k} is not a column of {label}. | See GET /v1/reports/catalog. | `api/src/routes/reports2.ts:122`, `api/src/routes/reports2.ts:174` |
| `unknown_event` | Event {event} is not recorded. | Allowed: {join}. | `api/src/routes/platform.ts:322` |
| `unknown_jurisdiction` | Residence {residence} is not a supported jurisdiction. | See GET /v1/jurisdictions. | `api/src/routes/core.ts:144`, `api/src/routes/core.ts:316`, `api/src/routes/fundops.ts:296`, `api/src/routes/workflow.ts:241` |
| `unknown_operator` | Operator {op} does not apply to {label} ({type}). | Allowed: {join}. | `api/src/routes/reports2.ts:130` |
| `unknown_scope` | Unknown scope {join}. | Use {join}. | `api/src/routes/workflow.ts:157` |
| `unknown_source` | Unknown report source {source}. |  | `api/src/routes/reports2.ts:119` |
| `unsupported_asset` | {name} settles only in {joinor}. | Choose one of those. | `api/src/routes/portal.ts:248` |
| `unsupported_jurisdiction` | No launch rule pack covers {jurisdiction} yet. | Remove it from the distribution list. | `api/src/routes/core.ts:310`, `api/src/routes/core.ts:370` |
| `wrong_form` | A U.S. person certifies on Form W-9, not a W-8. |  | `api/src/routes/workflow.ts:689`, `api/src/routes/workflow.ts:690` |

## 429

| Code | Message | What to do | Thrown from |
| --- | --- | --- | --- |
| `quota_exceeded` | This organization has used its {toLocaleStringenUS} requests for the month. | The quota resets on {slice010}. | `api/src/auth.ts:67` |
| `rate_limited` | More than 600 requests in a minute. | Wait a moment and retry. | `api/src/auth.ts:113`, `api/src/auth.ts:123`, `api/src/auth.ts:151`, `api/src/auth.ts:181`, `api/src/auth.ts:257`, `api/src/routes/account2.ts:91` and 6 more |

## 500

| Code | Message | What to do | Thrown from |
| --- | --- | --- | --- |
| `internal_error` | Something went wrong on our side. | The request was not applied. Retry, and contact us if it keeps failing. | `api/src/index.ts:65` |

## 501

| Code | Message | What to do | Thrown from |
| --- | --- | --- | --- |
| `no_executor` | Approval kind {kind} has no executor registered on this deployment. |  | `api/src/approvals.ts:157`, `api/src/approvals.ts:239` |
| `not_configured` | The demo identity provider is not configured. |  | `api/src/oidc.ts:99`, `api/src/routes/compliance.ts:325`, `api/src/routes/core.ts:44`, `api/src/util.ts:104` |

## 502

| Code | Message | What to do | Thrown from |
| --- | --- | --- | --- |
| `agent_failed` | The drafting agent could not be reached. | Nothing was saved; try again in a minute. | `api/src/routes/compliance.ts:306`, `api/src/routes/compliance.ts:308` |
| `agent_unparseable` | The draft could not be read as structured data. | Nothing was saved; try again. | `api/src/routes/compliance.ts:316` |
| `chain_unavailable` | The settlement could not be queued on chain. | Nothing moved. Request a new decision and try again. | `api/src/routes/core.ts:982`, `api/src/routes/core.ts:1101` |
| `sso_discovery_failed` | Could not read the identity provider configuration from {issuer}. |  | `api/src/oidc.ts:24` |
| `sso_issuer_mismatch` | The identity provider reported a different issuer. |  | `api/src/oidc.ts:26` |
| `sso_jwks_failed` | Could not read the identity provider signing keys. |  | `api/src/oidc.ts:42` |

## 503

| Code | Message | What to do | Thrown from |
| --- | --- | --- | --- |
| `capacity` | All sandboxes are in use right now. | Try again tomorrow. | `api/src/auth.ts:153` |
