import fs from 'node:fs';
import path from 'node:path';
import { Account, JsonRpcProvider, KeyPair, KeyPairSigner, actions } from '../frontend/node_modules/near-api-js/lib/index.js';

const envPath = path.resolve('frontend', '.env.local');
const env = Object.fromEntries(fs.readFileSync(envPath, 'utf8').split(/\r?\n/)
  .filter((line) => line.trim() && !line.trim().startsWith('#'))
  .map((line) => { const i = line.indexOf('='); return [line.slice(0, i).trim(), line.slice(i + 1).trim()]; }));
const contractId = env.FUNDER_ACCOUNT_ID || 'ajopool.testnet';
const circleId = 2;
const member1Id = env.TEST_MEMBER_1_ACCOUNT_ID || `member1.${contractId}`;
const member2Id = env.TEST_MEMBER_2_ACCOUNT_ID || `member2.${contractId}`;
const provider = new JsonRpcProvider({ url: env.RPC_URL || 'https://rpc.testnet.near.org' });
const account = (id, key) => new Account(id, provider, new KeyPairSigner(KeyPair.fromString(key)));
const organizer = account(contractId, env.FUNDER_PRIVATE_KEY);
const member1 = account(member1Id, env.TEST_MEMBER_1_PRIVATE_KEY);
const member2 = account(member2Id, env.TEST_MEMBER_2_PRIVATE_KEY);
const yocto = 10n ** 24n;

const circle = await provider.callFunction({ contractId, method: 'get_circle', args: { circle_id: circleId } });
if (!circle || circle.status !== 'Active' || circle.members.length !== 2 || !circle.members.includes(member1Id) || !circle.members.includes(member2Id)) {
  throw new Error(`Circle ${circleId} is not the expected full, active test circle.`);
}
if (await provider.callFunction({ contractId, method: 'get_circle_dao', args: { circle_id: circleId } })) {
  throw new Error(`Circle ${circleId} already has a DAO; refusing to create a duplicate.`);
}

console.log(`Starting circle ${circleId} DAO with 6 NEAR factory deposit plus 1 NEAR reserve.`);
const start = await organizer.callFunctionRaw({
  contractId,
  methodName: 'start_circle',
  args: { circle_id: circleId },
  deposit: 7n * yocto,
  gas: 220_000_000_000_000n,
});
console.log(`DAO creation tx ${start.transaction.hash}.`);

let daoId = null;
for (let i = 0; i < 30 && !daoId; i += 1) {
  await new Promise((resolve) => setTimeout(resolve, 2_000));
  daoId = await provider.callFunction({ contractId, method: 'get_circle_dao', args: { circle_id: circleId } });
}
if (!daoId) throw new Error('Circle DAO association was not recorded.');
const policy = await provider.callFunction({ contractId: daoId, method: 'get_policy', args: {} });
const circleRole = policy.roles.find((role) => role.name === 'circle');
const membersRole = policy.roles.find((role) => role.name === 'members');
const cleanupVote = membersRole?.vote_policy?.remove_member_from_role;
if (!circleRole?.permissions?.includes('remove_member_from_role:AddProposal') ||
    !membersRole?.permissions?.includes('remove_member_from_role:VoteApprove') ||
    membersRole.permissions.includes('remove_member_from_role:VoteReject') ||
    cleanupVote?.threshold !== '1') {
  throw new Error(`New DAO did not receive the expected restricted role-cleanup policy: ${JSON.stringify({ circleRole, membersRole })}`);
}

const member1Balance = await provider.viewAccount({ accountId: member1Id });
if (BigInt(member1Balance.amount) < 1_200_000_000_000_000_000_000_000n) {
  const fund = await organizer.signAndSendTransaction({ receiverId: member1Id, actions: [actions.transfer(1n * yocto)] });
  console.log(`Topped up controlled proposer by 1 NEAR; tx ${fund.transaction.hash}.`);
}

console.log('Submitting removal proposal for the defaulting member.');
const submitted = await member1.callFunctionRaw({
  contractId,
  methodName: 'propose_removal',
  args: { circle_id: circleId, member_to_remove: member2Id },
  deposit: yocto,
  gas: 220_000_000_000_000n,
});
console.log(`Removal submission tx ${submitted.transaction.hash}.`);

let sync = null;
for (let i = 0; i < 20; i += 1) {
  await new Promise((resolve) => setTimeout(resolve, 2_000));
  sync = await provider.callFunction({ contractId, method: 'get_removal_sync', args: { circle_id: circleId } });
  if (sync?.removal_proposal_id !== null && sync?.removal_proposal_id !== undefined) break;
}
if (sync?.removal_proposal_id == null) throw new Error(`The DAO removal proposal was not recorded: ${JSON.stringify(sync)}`);
const removalProposalId = sync.removal_proposal_id;
const removalProposal = await provider.callFunction({ contractId: daoId, method: 'get_proposal', args: { id: removalProposalId } });
for (const [voter, id] of [[member1, member1Id], [member2, member2Id]]) {
  const current = await provider.callFunction({ contractId: daoId, method: 'get_proposal', args: { id: removalProposalId } });
  if (!current.votes?.[id]) {
    const vote = await voter.callFunctionRaw({
      contractId: daoId,
      methodName: 'act_proposal',
      args: { id: removalProposalId, action: 'VoteApprove', proposal: removalProposal.kind, memo: null },
      gas: 220_000_000_000_000n,
    });
    console.log(`${id} approved removal; tx ${vote.transaction.hash}.`);
  }
}

let roleSync = null;
for (let i = 0; i < 30; i += 1) {
  await new Promise((resolve) => setTimeout(resolve, 2_000));
  roleSync = await provider.callFunction({ contractId, method: 'get_removal_sync', args: { circle_id: circleId } });
  if (roleSync?.stage === 'RoleRemovalVoting') break;
}
if (roleSync?.stage !== 'RoleRemovalVoting' || roleSync.role_removal_proposal_id == null) {
  throw new Error(`Circle removal did not create its follow-up DAO role proposal: ${JSON.stringify(roleSync)}`);
}
const roleProposalId = roleSync.role_removal_proposal_id;
const roleProposal = await provider.callFunction({ contractId: daoId, method: 'get_proposal', args: { id: roleProposalId } });
console.log(`Removal applied; follow-up DAO roster proposal ${roleProposalId} awaits member1 approval.`);

const roleVote = await member1.callFunctionRaw({
  contractId: daoId,
  methodName: 'act_proposal',
  args: { id: roleProposalId, action: 'VoteApprove', proposal: roleProposal.kind, memo: null },
  gas: 100_000_000_000_000n,
});
console.log(`Remaining active member approved DAO roster cleanup; tx ${roleVote.transaction.hash}.`);

const confirmed = await member1.callFunctionRaw({
  contractId,
  methodName: 'confirm_removal_dao_sync',
  args: { circle_id: circleId },
  gas: 60_000_000_000_000n,
});
console.log(`DAO roster verification tx ${confirmed.transaction.hash}.`);

let finalSync = null;
for (let i = 0; i < 20; i += 1) {
  await new Promise((resolve) => setTimeout(resolve, 2_000));
  finalSync = await provider.callFunction({ contractId, method: 'get_removal_sync', args: { circle_id: circleId } });
  if (finalSync?.stage === 'Synced') break;
}
if (finalSync?.stage !== 'Synced') throw new Error(`DAO role removal was not verified: ${JSON.stringify(finalSync)}`);

const refund = await member1.callFunctionRaw({
  contractId,
  methodName: 'claim_removal_bond',
  args: { circle_id: circleId },
  gas: 40_000_000_000_000n,
});
console.log(`Refunded the original 1 NEAR removal bond; tx ${refund.transaction.hash}.`);

const [finalCircle, finalPolicy, finalProposal] = await Promise.all([
  provider.callFunction({ contractId, method: 'get_circle', args: { circle_id: circleId } }),
  provider.callFunction({ contractId: daoId, method: 'get_policy', args: {} }),
  provider.callFunction({ contractId: daoId, method: 'get_proposal', args: { id: roleProposalId } }),
]);
const finalMembersRole = finalPolicy.roles.find((role) => role.name === 'members');
const result = {
  circleId,
  daoId,
  removalProposalId,
  removalStatus: (await provider.callFunction({ contractId: daoId, method: 'get_proposal', args: { id: removalProposalId } })).status,
  roleRemovalProposalId: roleProposalId,
  roleRemovalStatus: finalProposal.status,
  member2ActiveInCircle: finalCircle.members.includes(member2Id),
  member2RecordedRemoved: finalCircle.removed_members.includes(member2Id),
  member2InDaoMembersRole: finalMembersRole.kind.Group.includes(member2Id),
  member1BalanceNear: (Number(BigInt((await provider.viewAccount({ accountId: member1Id })).amount)) / 1e24).toFixed(3),
};
console.log(JSON.stringify(result, null, 2));
if (result.member2ActiveInCircle || !result.member2RecordedRemoved || result.member2InDaoMembersRole) {
  throw new Error('Removal did not complete across circle and DAO membership state.');
}
