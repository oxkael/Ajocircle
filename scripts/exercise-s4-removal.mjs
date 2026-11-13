import fs from 'node:fs';
import path from 'node:path';
import { Account, JsonRpcProvider, KeyPair, KeyPairSigner, actions } from '../frontend/node_modules/near-api-js/lib/index.js';

const envPath = path.resolve('frontend', '.env.local');
const env = Object.fromEntries(fs.readFileSync(envPath, 'utf8').split(/\r?\n/)
  .filter((line) => line.trim() && !line.trim().startsWith('#'))
  .map((line) => { const i = line.indexOf('='); return [line.slice(0, i).trim(), line.slice(i + 1).trim()]; }));
const contractId = env.FUNDER_ACCOUNT_ID || 'ajopool.testnet';
const circleId = Number(env.AJOCIRCLE_S4_CIRCLE_ID || 4);
const members = [env.TEST_MEMBER_1_ACCOUNT_ID || `member1.${contractId}`, env.TEST_MEMBER_2_ACCOUNT_ID || `member2.${contractId}`];
const provider = new JsonRpcProvider({ url: env.RPC_URL || 'https://rpc.testnet.near.org' });
const member1 = new Account(members[0], provider, new KeyPairSigner(KeyPair.fromString(env.TEST_MEMBER_1_PRIVATE_KEY)));
const member2 = new Account(members[1], provider, new KeyPairSigner(KeyPair.fromString(env.TEST_MEMBER_2_PRIVATE_KEY)));
const funder = new Account(contractId, provider, new KeyPairSigner(KeyPair.fromString(env.FUNDER_PRIVATE_KEY)));

const member1Balance = await provider.viewAccount({ accountId: members[0] });
if (BigInt(member1Balance.amount) < 1_150_000_000_000_000_000_000_000n) {
  const topUp = await funder.signAndSendTransaction({
    receiverId: members[0],
    actions: [actions.transfer(150_000_000_000_000_000_000_000n)],
  });
  console.log(`Topped up controlled proposer account with 0.15 NEAR; tx ${topUp.transaction.hash}.`);
}

const circle = await provider.callFunction({ contractId, method: 'get_circle', args: { circle_id: circleId } });
if (!circle || circle.status !== 'Active' || !circle.members.includes(members[0]) || !circle.members.includes(members[1])) {
  throw new Error(`Circle ${circleId} is not the expected active two-member test circle.`);
}
const daoId = await provider.callFunction({ contractId, method: 'get_circle_dao', args: { circle_id: circleId } });
if (!daoId) throw new Error(`Circle ${circleId} has no verified DAO association.`);
const daoBalance = await provider.viewAccount({ accountId: daoId });
if (BigInt(daoBalance.amount) < 500_000_000_000_000_000_000_000n) throw new Error('DAO balance is too low to safely exercise this proposal.');
const lastBefore = Number(await provider.callFunction({ contractId: daoId, method: 'get_last_proposal_id', args: {} }));
const proposalId = lastBefore;

console.log(`Submitting removal proposal for ${members[1]} in circle ${circleId} to ${daoId}.`);
const submitted = await member1.callFunctionRaw({
  contractId,
  methodName: 'propose_removal',
  args: { circle_id: circleId, member_to_remove: members[1] },
  deposit: 1_000_000_000_000_000_000_000_000n,
  gas: 220_000_000_000_000n,
});
console.log(`Proposal submission tx ${submitted.transaction.hash}.`);

let proposal = null;
for (let attempt = 0; attempt < 20; attempt += 1) {
  await new Promise((resolve) => setTimeout(resolve, 2_000));
  const next = Number(await provider.callFunction({ contractId: daoId, method: 'get_last_proposal_id', args: {} }));
  if (next > proposalId) {
    proposal = await provider.callFunction({ contractId: daoId, method: 'get_proposal', args: { id: proposalId } });
    break;
  }
}
if (!proposal) throw new Error('Removal proposal was not added to Sputnik DAO.');
console.log(`Removal proposal ${proposalId} is ${proposal.status}; member2 will cast the second vote.`);

const voted = await member2.callFunctionRaw({
  contractId: daoId,
  methodName: 'act_proposal',
  args: { id: proposalId, action: 'VoteApprove', proposal: proposal.kind, memo: null },
  gas: 100_000_000_000_000n,
});
console.log(`Approval vote tx ${voted.transaction.hash}.`);

let finalProposal = null;
for (let attempt = 0; attempt < 25; attempt += 1) {
  await new Promise((resolve) => setTimeout(resolve, 2_000));
  finalProposal = await provider.callFunction({ contractId: daoId, method: 'get_proposal', args: { id: proposalId } });
  if (finalProposal.status === 'Approved' || finalProposal.status === 'Rejected' || finalProposal.status === 'Removed') break;
}
const finalCircle = await provider.callFunction({ contractId, method: 'get_circle', args: { circle_id: circleId } });
const result = {
  circleId,
  daoId,
  proposalId,
  proposalStatus: finalProposal?.status,
  member2StillActive: finalCircle.members.includes(members[1]),
  member2RecordedAsRemoved: finalCircle.removed_members.includes(members[1]),
  proposal,
  finalProposal,
};
console.log(JSON.stringify(result, null, 2));
