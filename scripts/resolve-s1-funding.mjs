import fs from 'node:fs';
import path from 'node:path';
import { Account, JsonRpcProvider, KeyPair, KeyPairSigner, actions } from '../frontend/node_modules/near-api-js/lib/index.js';

const envPath = path.resolve('frontend', '.env.local');
const env = Object.fromEntries(fs.readFileSync(envPath, 'utf8').split(/\r?\n/)
  .filter((line) => line.trim() && !line.trim().startsWith('#'))
  .map((line) => { const i = line.indexOf('='); return [line.slice(0, i).trim(), line.slice(i + 1).trim()]; }));
const organizerId = env.FUNDER_ACCOUNT_ID || 'ajopool.testnet';
const daoId = env.AJOCIRCLE_SPIKE_DAO_ID;
if (!daoId) throw new Error('S1 DAO id is missing from frontend/.env.local.');
const member2Id = env.TEST_MEMBER_2_ACCOUNT_ID || `member2.${organizerId}`;
const provider = new JsonRpcProvider({ url: env.RPC_URL || 'https://rpc.testnet.near.org' });
const organizer = new Account(organizerId, provider, new KeyPairSigner(KeyPair.fromString(env.FUNDER_PRIVATE_KEY)));
const member2 = new Account(member2Id, provider, new KeyPairSigner(KeyPair.fromString(env.TEST_MEMBER_2_PRIVATE_KEY)));
const proposalId = 1;
const expectedAmount = '2300000000000000000000000';

const proposal = await provider.callFunction({ contractId: daoId, method: 'get_proposal', args: { id: proposalId } });
const kind = proposal?.kind?.Transfer;
if (proposal?.status !== 'InProgress' || kind?.receiver_id !== organizerId || kind?.amount !== expectedAmount) {
  throw new Error(`S1 proposal ${proposalId} is not the expected pending 2.3 NEAR transfer; refusing to proceed.`);
}
if (Object.keys(proposal.votes || {}).length !== 1 || proposal.votes['member1.' + organizerId] !== 'Approve') {
  throw new Error(`Unexpected S1 proposal votes: ${JSON.stringify(proposal.votes)}; refusing to proceed.`);
}

const organizerState = await provider.viewAccount({ accountId: organizerId });
const daoState = await provider.viewAccount({ accountId: daoId });
const topUp = 2n * 10n ** 24n;
const organizerSpendable = BigInt(organizerState.amount) - BigInt(organizerState.locked) - BigInt(organizerState.storage_usage) * 10n ** 19n;
if (organizerSpendable < topUp + 50_000_000_000_000_000_000_000n) {
  throw new Error('Organizer account lacks safe spendable balance for the 2 NEAR DAO top-up.');
}
if (BigInt(daoState.amount) < 6n * 10n ** 24n) throw new Error('S1 DAO balance changed unexpectedly; refusing to proceed.');

console.log(`Topping up S1 DAO ${daoId} by 2 NEAR from ${organizerId}.`);
const fundingTx = await organizer.signAndSendTransaction({
  receiverId: daoId,
  actions: [actions.transfer(topUp)],
});
console.log(`Top-up tx ${fundingTx.transaction.hash}.`);

const fundedDaoState = await provider.viewAccount({ accountId: daoId });
const daoStorageReserve = BigInt(fundedDaoState.storage_usage) * 10n ** 19n;
if (BigInt(fundedDaoState.amount) - BigInt(fundedDaoState.locked) < daoStorageReserve + 3_300_000_000_000_000_000_000_000n) {
  throw new Error('S1 DAO still lacks safe headroom for the transfer and bond refund after top-up.');
}

console.log(`Member2 approving S1 proposal ${proposalId}.`);
const voteTx = await member2.callFunctionRaw({
  contractId: daoId,
  methodName: 'act_proposal',
  args: { id: proposalId, action: 'VoteApprove', proposal: proposal.kind, memo: 'Complete S1 testnet funding check' },
  gas: 220_000_000_000_000n,
});
console.log(`Member2 vote tx ${voteTx.transaction.hash}.`);

let finalProposal = null;
for (let attempt = 0; attempt < 30; attempt += 1) {
  await new Promise((resolve) => setTimeout(resolve, 2_000));
  finalProposal = await provider.callFunction({ contractId: daoId, method: 'get_proposal', args: { id: proposalId } });
  if (finalProposal.status !== 'InProgress') break;
}
const [finalOrganizer, finalDao] = await Promise.all([
  provider.viewAccount({ accountId: organizerId }),
  provider.viewAccount({ accountId: daoId }),
]);
console.log(JSON.stringify({
  daoId,
  proposalId,
  status: finalProposal?.status,
  votes: finalProposal?.votes,
  transferAmountNear: '2.3',
  organizerBalanceNear: (Number(BigInt(finalOrganizer.amount)) / 1e24).toFixed(3),
  daoBalanceNear: (Number(BigInt(finalDao.amount)) / 1e24).toFixed(3),
  organizerBalanceAfterTopUpBeforeTransferNear: (Number(BigInt(organizerState.amount) - topUp) / 1e24).toFixed(3),
}, null, 2));
if (finalProposal?.status !== 'Approved') throw new Error(`S1 proposal did not finish as Approved (status=${finalProposal?.status}).`);
