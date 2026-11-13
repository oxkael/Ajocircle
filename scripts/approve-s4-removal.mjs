import fs from 'node:fs';
import path from 'node:path';
import { Account, JsonRpcProvider, KeyPair, KeyPairSigner } from '../frontend/node_modules/near-api-js/lib/index.js';

const envPath = path.resolve('frontend', '.env.local');
const env = Object.fromEntries(fs.readFileSync(envPath, 'utf8').split(/\r?\n/)
  .filter((line) => line.trim() && !line.trim().startsWith('#'))
  .map((line) => { const i = line.indexOf('='); return [line.slice(0, i).trim(), line.slice(i + 1).trim()]; }));
const contractId = env.FUNDER_ACCOUNT_ID || 'ajopool.testnet';
const circleId = Number(env.AJOCIRCLE_S4_CIRCLE_ID || 4);
const daoId = await new JsonRpcProvider({ url: env.RPC_URL || 'https://rpc.testnet.near.org' })
  .callFunction({ contractId, method: 'get_circle_dao', args: { circle_id: circleId } });
const provider = new JsonRpcProvider({ url: env.RPC_URL || 'https://rpc.testnet.near.org' });
const member = new Account(env.TEST_MEMBER_1_ACCOUNT_ID || `member1.${contractId}`, provider,
  new KeyPairSigner(KeyPair.fromString(env.TEST_MEMBER_1_PRIVATE_KEY)));
const proposalId = 0;
const proposal = await provider.callFunction({ contractId: daoId, method: 'get_proposal', args: { id: proposalId } });
if (!proposal || proposal.status !== 'InProgress') throw new Error(`Expected proposal ${proposalId} to be InProgress.`);
const vote = await member.callFunctionRaw({
  contractId: daoId,
  methodName: 'act_proposal',
  args: { id: proposalId, action: 'VoteApprove', proposal: proposal.kind, memo: null },
  gas: 220_000_000_000_000n,
});
console.log(`Member1 approval tx ${vote.transaction.hash}.`);
let finalProposal = proposal;
for (let i = 0; i < 30; i += 1) {
  await new Promise((resolve) => setTimeout(resolve, 2_000));
  finalProposal = await provider.callFunction({ contractId: daoId, method: 'get_proposal', args: { id: proposalId } });
  if (finalProposal.status !== 'InProgress') break;
}
const circle = await provider.callFunction({ contractId, method: 'get_circle', args: { circle_id: circleId } });
console.log(JSON.stringify({
  circleId, daoId, proposalId, status: finalProposal.status,
  member2StillActive: circle.members.includes('member2.' + contractId),
  member2RecordedAsRemoved: circle.removed_members.includes('member2.' + contractId),
  proposal: finalProposal,
}, null, 2));
