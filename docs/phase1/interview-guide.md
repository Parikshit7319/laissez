# Discovery interview guide

30 minutes with a head of digital asset distribution, product or platform at a private bank or a licensed digital distributor. The goal is to learn how they sell a tokenized fund today and where it breaks. The demo comes last and only if there is time.

Who runs it: Parikshit, alone. Record only with permission. Take notes in the template at the bottom within an hour of the call.

## Before the call

- Read their last 12 months of tokenized fund announcements. Know which funds they distribute, which booking centres they run, which issuers they work with.
- Know which licence they hold in each centre (CMS licence in Singapore, Type 1 and Type 4 in Hong Kong, bank licence) because the booking centre rule questions depend on it.
- Pick the one question from each block you must get answered if the call runs short. They are marked with a star.
- Open the sandbox in a tab, logged in, on the order ticket. Do not share the screen until minute 25.

## Minute 0 to 2: framing

Say this, more or less:

"Thanks for the time. I am building a compliance and settlement layer for tokenized funds, and I am in the stage where I am trying to understand how distribution actually works at firms like yours before I decide what to build next. This is not a sales call. I will not show you anything until the last five minutes, and only if you want to see it. I would like to spend most of the time on how you onboard a client for a tokenized fund today and what gets in the way. Is it fine if I take notes?"

Then one line about yourself: "My background is transfer agency. I was lead engineer on Franklin Templeton's institutional TA platform at FIS, so the eligibility and register side is where I come from."

Do not say: "disrupt", "revolutionize", "the future of finance", "we are the first to", or anything about the market size. They know the market. They want to know if you understand their job.

## Minute 2 to 17: current workflow and pain

Open with the star question and let them talk. Interrupt only to go deeper.

**Star: "Walk me through the last time you onboarded a client into a tokenized fund. Start from the moment the RM said the client wants in, and end when the units were in the client's account."**

Follow-ups, in the order the story usually surfaces them:

1. "Who did the KYC and the investor classification, and was any of it reused from the client's existing file, or did the issuer need its own pack?"
2. "How many separate forms or portals did the client or the RM touch? Which were the issuer's, which were yours, which were the transfer agent's?"
3. "When the client's residence and your booking centre were different, who decided which rulebook applied? Was it written down anywhere or did someone just know?"
4. "How long did it take, end to end? What was the longest single wait, and who were you waiting on?"
5. "Who owns the whitelist for that fund? You, the issuer, the TA, the token platform? When a client's status changes, who updates it and how long does it take?"
6. "What broke, or nearly broke? A rejected transfer, a client in the wrong share class, a document version mismatch, a wallet not on the registry?"
7. "How did you handle the cash leg? Fiat wire, stablecoin, tokenized deposit? Did settlement wait on anything other than the money?"
8. "What have you tried to fix any of this? Internal build, vendor, asking the issuer to change their process? What happened?"
9. "If you distribute two or more tokenized funds from different issuers, how different are the two onboarding flows? Could the same client file serve both without rework?"

If they have not yet onboarded anyone into a tokenized fund, switch to: "What stopped you?" and then "What would have to be true for you to do the first one?" That is still a useful call.

**Strong signal** sounds like: a specific client story, numbers without being pushed (days, forms, headcount), a named person who owns the whitelist, frustration with a specific issuer or TA process, an internal project that was tried and abandoned, the phrase "every issuer wants their own pack".

**Weak signal** sounds like: "we are exploring", "our innovation team is looking at it", generic talk about blockchain efficiency, no client example, no numbers, the view that tokenized funds are a marketing exercise for now.

Do not: offer a solution mid-story, correct their regulatory understanding, argue about whether a problem is real, or ask leading questions like "so it takes weeks, right?" Ask "how long did it take" and wait.

## Minute 17 to 22: the riskiest assumptions

These are the four things that kill Laissez if the answer is no. Ask them plainly. Pick the two most relevant if time is short.

**Star: "If a client had already been verified and classified by another regulated distributor, and that classification came to you as a signed credential with the citation and evidence reference, would your compliance team accept it as a basis to onboard, or would they insist on redoing it?"**

Follow-up: "What would they need to see? The underlying documents, or the attestation and the right to audit?" and "Has your compliance team ever relied on another firm's KYC? Under what arrangement?"

Strong signal: "we already rely on introducer KYC under a reliance agreement" or "yes, for a regulated bank in an equivalent jurisdiction". Weak signal: "compliance would never accept that" with no nuance. Note that a flat no is still valuable. It tells you the credential network is a later feature, not the wedge.

**"Would your issuers accept a third party as a trusted claim issuer on their token's identity registry, or do they insist on controlling the whitelist themselves?"**

Follow-up: "Who at the issuer makes that call? Product, compliance, the TA?" and "Has any issuer already delegated whitelisting to you?"

**"If this problem were solved, where would the budget come from? Operations, compliance, technology, or the product line's P&L? Who signs?"**

Follow-up: "What do you pay today, per fund or per client, to get a tokenized fund onboarded and settled? Even a rough number." and "Would you pay per settled dollar, per client credential, or a flat platform fee? Which would get through procurement fastest?"

Strong signal: they name a budget line and an owner. Weak signal: "we would have to see".

**"How do you handle the Travel Rule today on transfers of tokenized fund units? Which protocol, which vendor, and does settlement wait on the beneficiary VASP?"**

Follow-up: "Has a transfer ever been held because the counterparty VASP did not respond?"

Do not: defend the product when they say compliance would not accept something. Write it down and ask why.

## Minute 22 to 27: demo and reaction

Only if they want it. Say: "I can show you five minutes of what I have built. It runs on fictional institutions and fictional money. I would rather you tell me what is wrong with it than what is right."

Show three things, in this order, and stop talking after each one:

1. The order ticket decision: an order that is admitted, with the seven layers and the binding rule named. Then one that is refused with the fix.
2. The credential: one investor, stamps per jurisdiction, citation and expiry on each.
3. The settlement receipt: both legs, the re-check, the signed receipt.

Ask after each: "Is this how your team would think about it?" and at the end: "What is missing that would stop you from using this on a real order?"

Strong signal: they ask about integration ("does this read from our OMS", "which custodians"), about a specific rule ("how do you handle the Singapore opt-in"), or about who else is using it. Weak signal: polite nods and "very interesting".

Do not: click through every screen, explain the architecture, or mention ERC-3643 unless they do.

## Minute 27 to 30: close

Two asks, both direct.

"Who are two other people, here or at other firms, who feel this problem more than you do? I would appreciate an introduction, or just the names and I will reach out myself."

"I am looking for one or two design partners to take one fund through one corridor on testnet over 12 weeks, no fee, no client data. Two hours a week from a compliance person and an operations person. Is that something you could sponsor, or is there someone else here who would own it?"

Then: "I will send you a note of what I heard and the sandbox link. If I got anything wrong, tell me."

Strong signal: names given on the call, or "send me the one-pager and I will forward it". Weak signal: "let me think about it" with no next step.

## Note template

Fill this within an hour. One page. Facts first, interpretation second.

```
Call: [firm], [title], [date], [length], [how we got the intro]
Licence and centres: [e.g. CMS SG, Type 1/4 HK, booking in SG and HK]
Tokenized funds distributed today: [names, issuers, since when]

Current workflow (their words):
- Onboarding path:
- Forms and portals touched:
- Who decides which rulebook applies:
- Time end to end, longest wait:
- Whitelist owner and update path:
- What broke:
- What they tried:
- Cash leg and Travel Rule today:

Riskiest assumptions:
- Accept a third-party credential?  [yes / conditional / no]  Condition:
- Issuers accept third-party claim issuer?  [yes / conditional / no / unknown]
- Budget line and owner:
- Pricing shape they prefer:

Demo reaction (verbatim where possible):
- Missing:
- Wrong:
- Asked about:

Close:
- Intros offered: [names or "none"]
- Design partner: [sponsor / refer / no]  Next step and date:

Quotes worth keeping (verbatim, with context):
1.
2.

Score (see rubric): Pain _ Budget _ Authority _ Timing _ Fit _  Total _ / 25
What I would change in the product or the pitch after this call:
```

## Scoring rubric

Score each from 1 to 5 the same day. Total out of 25. Use it to rank the 15 calls, not to flatter any one of them.

| Dimension | 1 | 3 | 5 |
|---|---|---|---|
| Pain | No tokenized fund onboarded, no plan, problem is abstract | Has onboarded clients, describes friction, but has a workaround they tolerate | Specific recent failure or cost, named it as a top-three problem unprompted |
| Budget | No budget line, no idea who would pay | Budget exists for digital assets generally, owner unclear | Named the line, named the signer, gave a rough number they pay today |
| Authority | Individual contributor, cannot sponsor a pilot | Can sponsor a pilot inside their team but needs compliance sign-off from elsewhere | Owns the decision or sits one step from the person who does, and offered to make the case |
| Timing | Tokenized funds are a 2028 question for them | Live product this year, no near-term change planned | Launching or expanding a tokenized fund in the next two quarters, feels the problem now |
| Fit | Retail or crypto-native only, or single-jurisdiction with no cross-border intent | Cross-border on paper, one corridor in practice | Multiple booking centres, several issuers, already struggling with per-issuer onboarding |

Thresholds: 20 and above is a design partner candidate. 15 to 19 is a follow-up in 60 days with something new to show. Below 15 is a thank-you and a quarterly update. Any call where "accept a third-party credential" was a flat no gets a note in the tracker regardless of score, because three of those in a row changes the roadmap.
