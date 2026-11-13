# Ajopool — Sputnik DAO, Approvals and Defaults Brief

This is a companion to `AJOPOOL_PROJECT_BRIEF.md`. Read both. If they disagree on Sputnik DAO, payout approvals, defaults or removal, **this file wins**. Everything else in the main brief still applies, including: never simulate a login, wallet, balance or on-chain activity, and keep the README exactly true.

Where this file says **VERIFY**, read the current Sputnik DAO v2 contract source and docs, or run a small test on testnet, and report the result before building on the assumption. Label names, JSON shapes and behaviours below are written from understanding, not from a test. Do not invent contract methods.

## 1. Why Sputnik DAO is here

The NEAR HACKATHON Social Money track is built around Sputnik DAO and Trezu: shared budgets, reputation-based access and collective ownership, with the multisig left alone and the community behavior built on top. Ajopool is a savings circle, so the circle is the shared budget, the record of completed cycles is reputation, and the votes and approvals are collective decisions. Using Sputnik for real, and being honest about what it does, is both the right design and the track fit. Entries are screened by AI tools that check the project runs and matches the README, so every DAO claim must be demonstrable on testnet.

## 2. Who does what

**Sputnik DAO handles (one DAO per circle):**
- The member group (a role) and who may create or vote on each kind of proposal.
- Proposals and voting: creation, votes, thresholds, expiry, execution.
- A permanent on-chain audit trail of every decision, visible in Trezu.
- Optionally (Level 2 below) holding funds and executing approved transfers.

**Our circle contract handles (Sputnik does not know any of this):**
- Circle setup: name, amount, interval, grace period, member slots, payout order.
- Who paid each round, who is late, and whether a payout is ready.
- The reputation record per account (completed cycles, payments on time, late, defaults).
- Validation before anything reaches the DAO (for example, a removal can only be proposed for someone who is actually late).
- Everything user-facing.

Architecture decision: use **one circle contract holding all circles** (state keyed by circle id), not one contract per circle. Reputation is then naturally global across circles. Each circle still gets its own Sputnik DAO.

## 3. Two levels of integration

**Level 1 (build first, must work):**
- The circle contract holds the pot and runs payouts, using the approval rule in section 6.
- The circle's Sputnik DAO handles the votes: remove a defaulter, continue without them, and other group decisions. An approved proposal executes by calling a method on our circle contract, which only accepts calls from that circle's DAO account.
- Trezu shows the DAO and its proposals.

**Level 2 (attempt only after Level 1 passes all tests):**
- The DAO also holds the pot, and payouts are DAO proposals created by the circle contract and approved by members.
- Honest note: each pot is paid out right after the round is funded, so funds sit in the DAO only briefly. Level 2 adds real complexity (forwarding funds, proposal bonds, detecting execution) for modest practical benefit. Its main value is track alignment. Ship it only if it works end to end on testnet, and say in the README which level shipped.

## 4. DAO creation and policy

Create the circle's DAO **when the circle starts** (when it is full), not when it is created. The full member list then goes into the policy from the start, so no add-member votes are needed while people join. Create it as a sub-account through the Sputnik factory or the global contract (see docs.near.org, DAO primitives). VERIFY the factory `create` arguments and that a full custom policy can be passed at creation.

**Principles for the policy:**
1. **Remove the default "Everyone can add proposals" permission.** Only the circle contract's account may create proposals. Members vote. This guarantees every proposal passed the circle contract's checks first, so nobody can write a custom proposal that pays themselves or removes an on-time member.
2. **Lock the rules.** Grant no role permission to change config, change policy, add or update roles, upgrade the contract, or add bounties. The policy then cannot be loosened later. VERIFY the exact proposal kind labels that cover these.
3. **Per-kind vote policy.** Payout approvals need two votes. Removal and continue decisions need a majority of the members.
4. **Members are a Group role** containing every member's account at the start.

**Illustrative policy (labels, shapes and threshold syntax are VERIFY items, not tested):**

```json
{
  "roles": [
    {
      "name": "circle",
      "kind": { "Group": ["<circle-contract-account>"] },
      "permissions": ["transfer:AddProposal", "call:AddProposal", "remove_member_from_role:AddProposal"],
      "vote_policy": {}
    },
    {
      "name": "members",
      "kind": { "Group": ["<member1>", "<member2>", "<member3>"] },
      "permissions": [
        "transfer:VoteApprove", "transfer:VoteReject",
        "call:VoteApprove", "call:VoteReject",
        "remove_member_from_role:VoteApprove", "remove_member_from_role:VoteReject",
        "*:Finalize"
      ],
      "vote_policy": {
        "transfer": { "weight_kind": "RoleWeight", "quorum": "0", "threshold": "2" },
        "call": { "weight_kind": "RoleWeight", "quorum": "0", "threshold": [1, 2] }
      }
    }
  ],
  "default_vote_policy": { "weight_kind": "RoleWeight", "quorum": "0", "threshold": [1, 2] },
  "proposal_bond": "1000000000000000000000000",
  "proposal_period": "604800000000000",
  "bounty_bond": "1000000000000000000000000",
  "bounty_forgiveness_period": "86400000000000"
}
```

Verified on testnet (S1): Sputnik v2 expects a fixed `WeightOrRatio` threshold as the decimal string `"2"` (the enum is untagged), not `{ "Weight": "2" }`. The current `Policy` JSON also requires `bounty_bond` and `bounty_forgiveness_period`, even when the app does not use bounties.

Things to settle in testing: whether a two-vote threshold works as intended for a Group role, whether the proposal period and expiry behave as expected, and who pays the proposal bond (the account calling `add_proposal`, so the circle contract must be funded with NEAR for bonds).

## 5. Contributions and bookkeeping

- Members pay the round amount in the NEP-141 test stablecoin with `ft_transfer_call` to the circle contract. `ft_on_transfer` checks the token, the amount, the sender is a member, the round is open, and the member has not already paid this round. Anything else is rejected and refunded.
- Every account that receives the token (members, the circle contract, any DAO) must be registered on the token contract (`storage_deposit`). Handle this in the funder flow and in circle start.
- Level 1: the circle contract keeps the tokens until payout or refund.
- Level 2: decide in the spike whether tokens are forwarded to the DAO per contribution or once per funded round. The circle contract always keeps the per-member record, because the DAO only sees a balance.

## 6. Payout approval rule (decided by the owner)

- A payout becomes available only when the current round is **fully paid**.
- A member starts it. Normally that is the organiser or the scheduled recipient. Recommended: allow **any member** to start it, because starting cannot redirect money and a wider set removes a way to get stuck if the organiser or recipient is unavailable. Flag this choice in the README.
- The start counts as the **first approval**. A **second, different member** gives the **second approval**. Then the pot is paid to the scheduled recipient.
- The scheduled recipient may be the starter or the approver.
- The contract fixes the recipient (the member whose slot matches the current round) and the amount (the full pot). Nobody can supply an address or amount, so approvals cannot route money elsewhere.
- Both people must be members of that circle. Nobody can approve twice. A round cannot pay out twice. A payout cannot start before the round is funded or after it is paid.

**Level 1 implementation:** `request_payout(circle_id)` records the first approval, `approve_payout(circle_id)` records the second and sends the pot with `ft_transfer`, then advances the round.

**Level 2 implementation:** `request_payout` checks the conditions and creates a `transfer` proposal in the circle's DAO with the stablecoin as the token, the scheduled recipient and the exact pot amount. VERIFY that the DAO's transfer proposal supports a NEP-141 token and how it does the call. The DAO's two-vote threshold for transfers is the approval rule. The requesting member's own vote is a separate DAO call. Chain both behind a single "Release payout" tap in the UI, so the member signs two transactions and sees one action. The second member taps "Approve". The circle contract does not vote.

## 7. Missed payments, removal, continue, walk-away

1. **Late:** after the round deadline plus the grace period, any member who has not paid shows as late. This is computed from the clock when the contract is called, and the app reads it as state.
2. **Propose removal:** any member calls `propose_removal(circle_id, member)` on the circle contract. The contract checks that the member really is late, then creates the DAO proposal (Level 1 and 2: a function call to our circle contract's `apply_removal`, so the DAO's approval executes it). Members vote. A majority of members decides.
3. **If removal passes:** the default is recorded on the member's profile and their reputation drops. They are removed from the circle's active members.
   - **Had not collected yet:** refund their paid contributions. The circle continues with fewer members.
   - **Had already collected:** the group has lost money and nothing can be recovered. A second proposal, **continue without them**, decides the outcome: if it passes, the circle continues with the remaining members and smaller pots (one contribution smaller per round). If it fails, the circle ends and there are no refunds, because earlier pots were already paid out.
4. **Walk-away:** a member who already collected and stops paying is treated exactly like a default.
5. **Removed member's vote:** after removal, the member must stop being able to vote in the DAO. Handle this with a `remove_member_from_role` proposal created by the circle contract right after `apply_removal`, or an equivalent. VERIFY and report what works.

## 8. Reputation

- Stored by the circle contract per account: cycles completed, payments on time, payments late, defaults.
- Updated only by the contract at real events (payment recorded, round closed, removal applied, cycle completed). Every count must be traceable to those events. No manual edits and no seeded fake data.
- Shown as plain counts. Never one blended score. A new account shows "No history".
- Say plainly in the README that a new account resets the record, so reputation is a signal inside the app, not enforcement.

## 9. Circle contract methods (Sputnik-related)

- `start_circle(circle_id)`: requires the circle to be full, creates the DAO with the policy in section 4, registers storage where needed, sets status to Active.
- `request_payout`, `approve_payout` (section 6).
- `propose_removal(circle_id, member)`, `propose_continue(circle_id)`: validate, then create the DAO proposal.
- `apply_removal(circle_id, member)`, `apply_continue(circle_id)`: **callable only by that circle's DAO account.** Reject every other caller.
- Views: circle state, round status (who paid, who is late, payout ready), proposals for the circle, `get_profile(account)`.
- Access rules enforced inside the contract, never only in the frontend.

## 10. Trezu

Add a "View treasury" link in the circle's Details tab pointing to the circle's DAO in Trezu. It is proof for judges that the DAO is real. It is never part of the main user flow. VERIFY that a DAO created by our flow shows up in Trezu with its proposals.

## 11. Spikes, in this order (report each result before building on it)

- **S1:** Create a Sputnik DAO on testnet from the factory or global contract with the custom policy in section 4. Confirm `get_policy` returns it exactly.
- **S2:** Confirm that a non-circle account **cannot** add a proposal, and that the circle contract account **can**.
- **S3:** Confirm a two-vote threshold approves a proposal on the second vote and not the first, for the payout proposal kind.
- **S4:** Create a function-call proposal that calls our circle contract's `apply_removal`, approve it by majority, and confirm the circle contract accepts only the DAO as caller.
- **S5 (Level 2 only):** Create a DAO `transfer` proposal for the NEP-141 test token, approve it with two votes, confirm the recipient receives the exact amount, and confirm how our contract can detect that it executed.
- **S6:** Confirm the circle's DAO appears in Trezu with its proposals.

If S1 to S4 pass, Level 1 is on. If S5 fails or is unclear, stay at Level 1 and say so in the README.

## 12. Tests to write

- Full cycle: contributions, payout with first and second approval, every member collects once.
- A payout cannot be started before the round is funded.
- The same member cannot give both approvals. A non-member cannot approve.
- The recipient and amount cannot be changed by any caller.
- A late member shows as late only after the deadline plus the grace period.
- A removal can only be proposed for a member who is actually late.
- Removal before collection refunds the member's paid contributions.
- Removal after collection followed by a "continue" vote continues with smaller pots. A failed "continue" vote ends the circle with no refunds.
- `apply_removal` and `apply_continue` reject every caller except the circle's DAO.
- Reputation counts match the event history exactly.
- A circle with the minimum three members completes a cycle.

## 13. Edge cases and risks to handle or document

- Proposals expire. An expired payout or removal proposal must be re-creatable without breaking circle state.
- The proposal bond must be paid by whoever calls `add_proposal`. Decide how the circle contract is funded, and keep that amount small and explicit.
- Cross-contract calls are asynchronous. Handle failures and callbacks so a failed call cannot leave the round half-done.
- Storage registration on the token for every account involved, or transfers fail.
- A colluding majority of members can still vote to do harmful things the policy allows. Keep the allowed proposal kinds minimal, and say so honestly.
- Test accounts on testnet only. No mainnet funds.

## 14. README honesty

State exactly: which level shipped, what the DAO handles, what the circle contract handles, that money is test money, and that naira on and off ramps are not built. Include the deployed testnet addresses, the DAO addresses, and one example proposal link in Trezu or a block explorer for each of: payout, removal, continue.

## 15. Do not

- Do not fake proposals, votes, approvals or balances to make a demo look complete.
- Do not write a custom multisig.
- Do not give any account permissions beyond what section 4 lists.
- Do not build Level 2 before Level 1 passes its tests.
- Do not change the approval rule or removal rules in this file without asking the owner first.
