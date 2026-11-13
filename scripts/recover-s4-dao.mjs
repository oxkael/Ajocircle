import fs from 'node:fs';
import path from 'node:path';
import { Account, JsonRpcProvider, KeyPair, KeyPairSigner } from '../frontend/node_modules/near-api-js/lib/index.js';

const envPath = path.resolve('frontend', '.env.local');
const env = Object.fromEntries(fs.readFileSync(envPath, 'utf8').split(/\r?\n/)
  .filter((line) => line.trim() && !line.trim().startsWith('#'))
  .map((line) => { const i = line.indexOf('='); return [line.slice(0, i).trim(), line.slice(i + 1).trim()]; }));
const accountId = env.FUNDER_ACCOUNT_ID || 'ajopool.testnet';
const circleId = Number(env.AJOCIRCLE_S4_CIRCLE_ID || 4);
const provider = new JsonRpcProvider({ url: env.RPC_URL || 'https://rpc.testnet.near.org' });
const funder = new Account(accountId, provider, new KeyPairSigner(KeyPair.fromString(env.FUNDER_PRIVATE_KEY)));
const existing = await provider.callFunction({ contractId: accountId, method: 'get_circle_dao', args: { circle_id: circleId } });
if (!existing) {
  const tx = await funder.callFunctionRaw({
    contractId: accountId,
    methodName: 'recover_circle_dao',
    args: { circle_id: circleId },
    gas: 90_000_000_000_000n,
  });
  console.log(`Submitted DAO policy verification for circle ${circleId}; tx ${tx.transaction.hash}.`);
}
let daoId = existing;
for (let attempt = 0; attempt < 20 && !daoId; attempt += 1) {
  await new Promise((resolve) => setTimeout(resolve, 2_000));
  daoId = await provider.callFunction({ contractId: accountId, method: 'get_circle_dao', args: { circle_id: circleId } });
}
if (!daoId) throw new Error('DAO policy verification did not associate the pending DAO with the circle.');
const policy = await provider.callFunction({ contractId: daoId, method: 'get_policy', args: {} });
const memberIds = [env.TEST_MEMBER_1_ACCOUNT_ID || `member1.${accountId}`, env.TEST_MEMBER_2_ACCOUNT_ID || `member2.${accountId}`];
const roles = policy.roles || [];
const circleRole = roles.find((role) => role.name === 'circle');
const membersRole = roles.find((role) => role.name === 'members');
const policyValid = circleRole?.kind?.Group?.includes(accountId) &&
  membersRole?.kind?.Group?.length === 2 && memberIds.every((member) => membersRole.kind.Group.includes(member));
if (!policyValid) throw new Error(`Associated DAO policy did not match expected circle members: ${daoId}`);
console.log(JSON.stringify({ circleId, daoId, policyHasContractAndBothMembers: true }, null, 2));
