# Ajocircle — Project Brief

Ajocircle is the product name. It is a savings circle (Ajo) app built on NEAR, with Africa as the long-term target market.

Read this whole file before writing code. Where it says VERIFY, check current docs or run a small test and report back before building on the assumption. Do not invent API names, contract methods or library features. Never simulate a login, wallet, balance or on-chain activity. If something cannot work for real, stop and report it instead of faking it.

## 1. What we are building

A savings circle (Ajo / esusu) app for groups of people who already know each other. Members contribute a fixed amount every round, and each round the whole pot goes to one member, in a fixed order, until everyone has collected once.

The problem it solves: in a normal Ajo one organizer holds everyone's money and keeps the notebook. If they vanish, get hacked or make mistakes, the group has no recourse. In this app **nobody holds the money**: a contract does, payouts follow the schedule, and everyone sees the same ledger.

One-line pitch: **"Ajo where the organizer can't run away with the money."**

Target users: people in Nigeria and across Africa who already run circles over WhatsApp and cash. They must never see crypto jargon.

This is a hackathon prototype for the NEAR HACKATHON **Social Money** track. A working, honest, well-designed prototype matters more than breadth.

## 2. Scope

### In scope (build these)
1. Sign-up and sign-in with Google or email through a third-party embedded wallet service (Privy, using NEAR's documented integration). No wallet language anywhere in the UI. Real authentication only.
2. Create a circle (name, contribution amount, interval, number of members, grace period) and share an invite link.
3. Join a circle through the link, claiming a payout slot so each member sees what they are agreeing to.
4. Contribute each round with one tap, using a NEP-141 test stablecoin.
5. Payout flow: one member triggers, a different member confirms, the contract pays the scheduled recipient the full pot.
6. Missed payments: a member shows as late after the grace period. Members can vote to remove a defaulter. A second vote decides whether to continue with smaller pots.
7. Reputation profile per account: completed cycles, on-time rounds, late rounds, defaults.
8. A polished mobile-first UI (section 7).
9. A demo mode with short intervals (minutes) so a full cycle can run in a live demo.

### Out of scope (do not build)
- Naira on-ramp or off-ramp (simulate with a test token faucet; say so in the README).
- Staking, yield, church or community pools, credit or lending.
- Deposits or collateral (leave an optional config field at most, off by default).
- Push notifications, chat, multi-language support.
- Mainnet deployment.

## 3. Rules that are already decided

- The organizer has **no special power over funds**. Creating a circle gives no control over the pot.
- Payout order: each member claims a slot when joining. The order is visible to everyone before the circle starts. The circle starts when it is full.
- **Payout rule:** a payout is available only when the current round is fully paid. One member triggers it and a **different** member confirms. The scheduled recipient is allowed to be either one. The contract pays the **scheduled recipient the full pot**, and nobody can change the address or amount. This means a missing organizer or lost login cannot block a payout.
- **Default handling:** after the round deadline plus grace period, a missing payer is marked late. Any member can propose removing them, and a majority of members decides. If removal passes, the default is recorded and their reputation drops.
- **After a removal:**
  - If the removed member had not collected yet, their paid contributions are refunded and the circle continues with fewer members.
  - If they had already collected, the group takes the loss. A second proposal, "continue without them", decides it. If it passes, the circle continues with remaining members and smaller pots. If it fails, the circle ends. There are no refunds then, because earlier pots were already paid out. The default still counts against the member either way.
- A member who walks away after collecting is treated the same as a default.
- Reputation is shown as plain counts, never one blended score. A new account shows "No history". Reputation only matters inside this app, and a new account resets it. Say this honestly in the README.

## 4. Technical plan

### Chain and stack
- NEAR, **testnet** for the prototype. VERIFY in the official hackathon FAQ that testnet-only projects qualify.
- Contract: Rust with the current `near-sdk`. VERIFY the current SDK version and patterns from docs.near.org.
- Frontend: Next.js or Vite with React and TypeScript, mobile-first.
- Token: a NEP-141 test stablecoin you deploy, with a faucet method for demo users. Contributions use `ft_transfer_call` into the circle contract.

### Protocol integration
Use these where they genuinely help, but none is forced:
- **Login and accounts:** use Privy social login through NEAR's documented integration (docs.near.org, "Social Login (Privy)", the `hello-privy` example and the `privy-near-connect` plugin). Google or email login creates a NEAR account for the user, and transactions are signed by the embedded wallet. VERIFY first by running the official example on a deployed HTTPS domain: login, account creation, one signed testnet transaction. If Privy fails, use Web3Auth (also documented, with an example). Last-resort fallback: real wallet login through `@hot-labs/near-connect`. Never fake a login, and do not write custom WebAuthn or key-generation code. Passkey-native accounts (NEP-591 and NEP-616) are a possible later upgrade, not part of this prototype.
- **Fees for new users:** a small backend funder account sends a little testnet NEAR to each new account on first login. Rate-limit it, keep its key in server environment variables only, and state it in the README. A meta-transaction relayer is a later improvement.
- **Sputnik DAO:** the hackathon track is built around Sputnik DAO and Trezu. Preferred use: members run the removal and continue votes as DAO proposals. VERIFY whether a Sputnik DAO can (a) hold a pot and (b) allow a routine payout without a per-round vote while paying only the scheduled recipient. Sputnik roles are defined by proposal type and action, so this may not be possible.
- **Decision rule:** if Sputnik cannot enforce the payout rule, hold the pot in our own circle contract and implement the votes inside it. Explain the reason in the README. Do not force Sputnik in if it weakens the product.
- **Trezu:** optional, only as a read-only "admin view" of a circle. Never in the main user flow.

### Spikes to run first (report results before building)
1. Run NEAR's official Privy example on a deployed HTTPS domain: Google or email login, a NEAR testnet account created, one signed transaction. Report the result.
2. Funding a brand-new account with testnet NEAR so its first transaction works.
3. Sputnik DAO holding funds and enforcing the payout rule (or confirming it cannot).

### Development environment (login)
- Privy and Google login need the app's domain registered in the provider's dashboard. Deploy early to one stable HTTPS domain and use it for all testing, including on phones, because changing domains later can orphan test accounts. `http://localhost` can be added for local development.
- A phone cannot reach the dev machine at `http://192.168.x.x`. Test on the deployed HTTPS URL.
- Never put provider secrets (the Privy app secret, the funder account key) in frontend code or in the repository.

## 5. Contract design (own circle contract)

State per circle: id, name, token account, amount per round, interval, grace period, max members, member list with claimed slots, status (`Open`, `Active`, `Ended`), current round, round deadline, contributions per round, collected set, removed set, payout request (requester, round), open proposals with votes.

Methods (names are suggestions):
- `create_circle(...)`, `join(circle_id, slot)`, `ft_on_transfer(...)` for contributions (reject wrong token, wrong amount, double payment for a round).
- `request_payout(circle_id)` and `confirm_payout(circle_id)`. Both require the round to be fully paid. Confirmer must differ from requester. Both must be circle members. The payout sends the full pot to the member whose slot matches the current round, then advances the round.
- `propose_removal(circle_id, member)`, `propose_continue(circle_id)`, `vote(circle_id, proposal_id, approve)`. A proposal passes at a strict majority of eligible members.
- Views: `get_circle`, `get_round_status` (who paid, who is late, payout ready), `get_profile(account)` with completed cycles, on-time rounds, late rounds, defaults.

Rules the contract must enforce itself, never the frontend:
- The recipient and amount of a payout cannot be chosen by the caller.
- Only members act. A member cannot vote twice. A round cannot pay out twice.
- Use block timestamp for deadlines. Demo mode allows intervals as short as a couple of minutes.
- Write tests for: full cycle, payout without confirmation, same person triggering and confirming, wrong recipient attempts, late payer, removal before and after collecting, continue and end paths.

## 6. User flows

1. **Create:** sign in with Google or email, fill the form, get an invite link.
2. **Join:** open the link, sign in with Google or email, see the circle details and the list of open slots with plain-language meaning ("You collect 4th of 5, so three people collect before you"), claim a slot.
3. **Round:** the circle page shows the current round, who has paid, who is late and when the next payout is due. One button: **Pay ₦X**.
4. **Payout:** when the round is fully paid, every member sees "Payout ready for [name]". One member taps **Release payout**, another taps **Confirm**. The pot moves.
5. **Default:** a late member is marked clearly but calmly. Any member can **Propose removal**, and members vote. After removal, the continue-or-end vote appears.
6. **Profile:** completed cycles, on-time and late counts, defaults. "No history" for new accounts.

## 6A. App structure and navigation

```
Public
  Landing (short)
  Join page  /join/:code    circle details, open slots, sign in
  Sign in / Sign up

App (signed in)
  Home          what I owe, payouts ready, my next collection
  My circles    list (active, open, ended) -> Circle detail
                  tabs: Overview, Members, Activity, Votes, Details
  Create        steps: basics, amount and schedule, slots, review, invite
  Activity      things needing me: pay, confirm payout, vote
  Profile       my record: cycles, on-time, late, defaults
  Settings      account, security, display, help
```

- **Navigation:** on desktop, a left sidebar with Home, My circles, Create circle, Activity (with a count badge), Profile, Settings and Help. On phones, a bottom bar with Home, Circles, Create (center), Activity and Profile, with Settings reachable from Profile. Same items and routes at every size.
- **Roles:** there is no special organizer account. Anyone signed in can create a circle, and the creator is labelled "Organiser" on it. The organiser can edit details and manage invites until the circle starts, after which everything locks. The organiser never has power over the money. A person can organise one circle and be a plain member of another.
- **Settings:** display name, sign-in method, display options, a "technical details" toggle, a note that the prototype uses test money, help, and sign out. Account recovery relies on the login provider (Google or email), so do not invent a separate recovery system. State this limit in the README.

## 7. UI requirements (a top priority)

If designer-made screens or Figma frames are supplied, they override the visual direction below (palette, type, layout details). The responsive, performance, plain-language, accessibility and state requirements still apply.

The UI must feel designed, calm and trustworthy, not like a generic AI-generated crypto template. Before building screens, write a short design direction (palette, type, spacing, tone) and keep to it.

- **Phone first, browser ready.** Design for a 360 to 430px phone first, and make the same app fit tablets and desktop browsers properly. Concretely:
  - One responsive codebase, no separate mobile site. Breakpoints around 640px and 1024px.
  - On desktop, never stretch phone screens across the window. Either center a single column (about 480px wide) or, from 1024px, use two panes: circle list on the left, selected circle on the right.
  - Primary actions (Pay, Release payout, Confirm, Vote) sit in a bottom action bar within thumb reach on phones. Respect safe-area insets (`env(safe-area-inset-*)`), use `dvh` units, set the viewport meta tag correctly, and make sure the on-screen keyboard never covers the field or the submit button.
  - No horizontal scrolling at any width. Text stays readable without zooming. Tap targets are at least 44px.
  - Performance matters on mid-range Android phones and slow networks: keep the first load light (aim for roughly 200 KB of JavaScript, gzipped, or less), code-split by route, use system fonts or one subsetted variable font, and avoid heavy libraries and large images.
  - Blockchain actions are slow, so show pending, success and retry states for every one, and never leave a button silent. Handle a dropped connection with a clear message and a retry.
  - Make it installable as a PWA (manifest and icons) so people can add it to their home screen.
  - Test on Android Chrome, iPhone Safari, and desktop Chrome and Firefox. Aim for Lighthouse mobile scores of 90 or higher for performance and accessibility.
- **Plain language only.** Never show "wallet", "gas", "NEP", "contract" or raw addresses in the main flow. Use "your account", "circle", "round", "payout". Put technical detail (account IDs, transaction links) in a collapsed "Details" area.
- **Money in naira** with proper formatting (₦20,000), tabular numerals, and a small note that the prototype uses test money.
- **Visual direction:** warm, human, grounded. A warm off-white background, strong readable ink-colored text, one considered accent color, and one typeface family with a clear size scale. Generous whitespace, 8px spacing rhythm, consistent radius.
- **Avoid the usual AI look:** no purple or blue gradients, no glow effects, no glassmorphism, no emoji used as icons, no identical rounded-card grids, no stock hero section, no "Web3" illustrations. Use a proper icon set (e.g. Lucide) at consistent weight.
- **Make the state obvious.** Each circle screen answers three questions at a glance: What do I owe? Who is next? What happens next? Show round progress as a simple timeline of members with clear paid, late and collected states.
- **Real states everywhere:** loading skeletons, empty states with helpful copy, error messages that say what to do, success confirmations, disabled buttons with reasons.
- **Real copy, no lorem ipsum.** Short, kind, direct sentences. Use example names that feel local and real.
- **Accessibility:** large tap targets (44px minimum), color contrast that passes WCAG AA, visible focus states, never color alone to signal late or paid.
- **Motion:** minimal and purposeful (a payout confirmation, a progress change). Respect reduced motion.
- Test the whole flow at 375px width before calling any screen done.

## 8. Build order

1. Spikes (section 4). Report findings and the chosen custody approach.
2. Test token and circle contract skeleton with tests for the happy path.
3. Social login (Privy), circle creation and join in the UI.
4. Contribute, round status, payout request and confirm.
5. Late status, removal vote, continue vote.
6. Profile and reputation.
7. UI polish pass at phone width, empty and error states, demo mode.
8. README, demo script, deployed testnet contract addresses.

## 9. Hackathon submission needs

- Public GitHub repository and a public demo post on X with a video or screenshots, mentioning NEAR HACKATHON. VERIFY current requirements at nearhackathon.com and in its HACKATHON.md and SUBMITTING.md.
- Entries are first screened by AI tools that check the project runs and matches the README, so **the README must be accurate**: what works, what is simulated (funding, naira), how to run it, how to deploy it, how the contract enforces the rules, and known limits.
- Never fake activity or on-chain data. Report limits honestly, including that reputation resets with a new account.

## 10. Definition of done

A 3-member circle on testnet completes a full cycle in the demo: create, invite, join, contribute, payout with trigger plus confirm, and every member collects once. A second scripted run shows a late payer, a removal vote and a continue vote. The profile page shows the resulting records. All of it works on a phone with Google or email login, in the designed UI, with the README matching reality.
