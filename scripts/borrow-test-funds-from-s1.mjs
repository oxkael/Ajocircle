import fs from 'node:fs';
import path from 'node:path';
import { Account, JsonRpcProvider, KeyPair, KeyPairSigner } from '../frontend/node_modules/near-api-js/lib/index.js';

const env = Object.fromEntries(fs.readFileSync(path.resolve('frontend', '.env.local'), 'utf8').split(/\r?\n/)
  .filter((line) => line.trim() && !line.trim().startsWith('#'))
  .map((line) => { const i = line.indexOf('='); return [line.slice(0, i).trim(), line.slice(i + 1).trim()]; }));
const accountId = env.FUNDER_ACCOUNT_ID || 'ajopool.testnet';
const daoId = env.AJOCIRCLE_SPIKE_DAO_ID;
const rpc = new JsonRpcProvider({ url: env.RPC_URL || 'https://rpc.testnet.near.org' });
const signer = (id, key) => new Account(id, rpc, new KeyPairSigner(KeyPair.fromString(key)));
const funder = signer(accountId, env.FUNDER_PRIVATE_KEY);
const members = [
  [env.TEST_MEMBER_1_ACCOUNT_ID || `member1.${accountId}`, env.TEST_MEMBER_1_PRIVATE_KEY],
  [env.TEST_MEMBER_2_ACCOUNT_ID || `member2.${accountId}`, env.TEST_MEMBER_2_PRIVATE_KEY],
];
const amount = '2300000000000000000000000';
const beforeState = await rpc.viewAccount({ accountId });
const proposalKind = {
  Transfer: { token_id: '', receiver_id: accountId, amount, msg: null },
};
const nextId = await rpc.callFunction({ contractId: daoId, method: 'get_last_proposal_id', args: {} });
if (Number(nextId) !== 1) {
  throw new Error(`Refusing to create a duplicate funding proposal; expected the fresh S1 DAO state, found next id ${nextId}.`);
}
const add = await funder.callFunctionRaw({
  contractId: daoId,
  methodName: 'add_proposal',
  args: { proposal: { description: 'Temporary testnet funding for S4 circle factory and storage', kind: proposalKind } },
  deposit: 10n ** 24n,
  gas: 100_000_000_000_000n,
});
const proposalId = Number(nextId);
console.log(`Added funding proposal ${proposalId}; tx ${add.transaction.hash}.`);

for (const [account, key] of members) {
  const voter = signer(account, key);
  const vote = await voter.callFunctionRaw({
    contractId: daoId,
    methodName: 'act_proposal',
    args: { id: proposalId, action: 'VoteApprove', proposal: proposalKind, memo: null },
    gas: 80_000_000_000_000n,
  });
  console.log(`${account} voted approve; tx ${vote.transaction.hash}.`);
}

let status;
let accountState;
for (let attempt = 0; attempt < 30; attempt += 1) {
  await new Promise((resolve) => setTimeout(resolve, 2_000));
  const response = await rpc.callFunction({ contractId: daoId, method: 'get_proposal', args: { id: proposalId } });
  status = response?.proposal?.status;
  accountState = await rpc.viewAccount({ accountId });
  if (status === 'Approved' && BigInt(accountState.amount) >= BigInt(beforeState.amount) + 2_200_000_000_000_000_000_000_000n) break;
  if (status === 'Failed' || status === 'Rejected') throw new Error(`S1 funding proposal ended in ${status}.`);
}
if (status !== 'Approved') throw new Error(`Funding proposal did not reach Approved status (status=${JSON.stringify(status)}).`);
if (BigInt(accountState.amount) < BigInt(beforeState.amount) + 2_200_000_000_000_000_000_000_000n) {
  throw new Error('Proposal is approved but the NEAR transfer was not observed on the organizer account.');
}
console.log(JSON.stringify({ daoId, proposalId, status, receivedNear: '2.3', organizerBalanceNear: (Number(BigInt(accountState.amount)) / 1e24).toFixed(3) }, null, 2));
