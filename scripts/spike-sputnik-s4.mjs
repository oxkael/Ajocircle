import fs from 'node:fs';
import path from 'node:path';
import { Account, JsonRpcProvider, KeyPair, KeyPairSigner, actions } from '../frontend/node_modules/near-api-js/lib/index.js';

const envPath = path.resolve('frontend', '.env.local');
const env = Object.fromEntries(fs.readFileSync(envPath, 'utf8').split(/\r?\n/)
  .filter((line) => line.trim() && !line.trim().startsWith('#'))
  .map((line) => {
    const index = line.indexOf('=');
    return [line.slice(0, index).trim(), line.slice(index + 1).trim()];
  }));
const funderId = env.FUNDER_ACCOUNT_ID || 'ajopool.testnet';
const contractId = funderId;
const provider = new JsonRpcProvider({ url: env.RPC_URL || 'https://rpc.testnet.near.org' });
const funder = new Account(funderId, provider, new KeyPairSigner(KeyPair.fromString(env.FUNDER_PRIVATE_KEY)));
const members = [
  env.TEST_MEMBER_1_ACCOUNT_ID || `member1.${funderId}`,
  env.TEST_MEMBER_2_ACCOUNT_ID || `member2.${funderId}`,
];

let circleId = Number(env.AJOCIRCLE_S4_CIRCLE_ID || 0);
if (circleId) {
  const existingCircle = await provider.callFunction({ contractId, method: 'get_circle', args: { circle_id: circleId } });
  if (existingCircle?.status !== 'Active' || existingCircle.members?.length !== 2) {
    throw new Error(`Configured S4 circle ${circleId} is not full and active; refusing to reuse it.`);
  }
  console.log(`Reusing full S4 test circle ${circleId}.`);
} else {
  const createdId = await funder.callFunction({
    contractId,
    methodName: 'create_circle',
    args: {
      name: `S4 DAO removal ${Date.now()}`,
      amount_per_round: '1000000000000000000000000',
      interval_seconds: 60,
      grace_period_seconds: 0,
      max_members: 2,
    },
    gas: 80_000_000_000_000n,
  });
  circleId = Number(createdId);
  if (!Number.isSafeInteger(circleId) || circleId < 1) throw new Error(`Unexpected create_circle result: ${JSON.stringify(createdId)}`);
  console.log(`Created disposable S4 circle ${circleId}.`);
  for (const [slot, memberId] of members.entries()) {
    const memberEnv = slot === 0 ? 'TEST_MEMBER_1_PRIVATE_KEY' : 'TEST_MEMBER_2_PRIVATE_KEY';
    if (!env[memberEnv]) throw new Error(`Missing local signing key for ${memberId}.`);
    const member = new Account(memberId, provider, new KeyPairSigner(KeyPair.fromString(env[memberEnv])));
    const tx = await member.callFunctionRaw({
      contractId,
      methodName: 'join',
      args: { circle_id: circleId, slot },
      gas: 40_000_000_000_000n,
    });
    console.log(`${memberId} joined slot ${slot}; tx ${tx.transaction.hash}.`);
  }
  const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
  const configLine = `AJOCIRCLE_S4_CIRCLE_ID=${circleId}`;
  const existingLine = lines.findIndex((line) => line.startsWith('AJOCIRCLE_S4_CIRCLE_ID='));
  if (existingLine >= 0) lines[existingLine] = configLine;
  else lines.push(configLine);
  fs.writeFileSync(envPath, `${lines.filter((line, index) => index < lines.length - 1 || line).join('\n')}\n`);
}

const deposit = 7n * 10n ** 24n;
const funderState = await provider.viewAccount({ accountId: funderId });
const fundingNeeded = 7_300_000_000_000_000_000_000_000n;
if (BigInt(funderState.amount) < fundingNeeded) {
  const proposerId = members[0];
  const proposerKey = env.TEST_MEMBER_1_PRIVATE_KEY;
  const proposer = new Account(proposerId, provider, new KeyPairSigner(KeyPair.fromString(proposerKey)));
  const proposerState = await provider.viewAccount({ accountId: proposerId });
  if (BigInt(proposerState.amount) < 1_200_000_000_000_000_000_000_000n) {
    throw new Error('Insufficient testnet balance to safely fund DAO creation and keep the proposal bond reserve.');
  }
  const fundingTx = await proposer.signAndSendTransaction({
    receiverId: funderId,
    actions: [actions.transfer(250_000_000_000_000_000_000_000n)],
  });
  console.log(`Moved 0.25 testnet NEAR from the controlled proposer account to cover factory deposit and gas; tx ${fundingTx.transaction.hash}.`);
}
console.log('Starting circle: 6 NEAR factory deposit plus a 1 NEAR reusable proposal reserve...');
const start = await funder.callFunctionRaw({
  contractId,
  methodName: 'start_circle',
  args: { circle_id: circleId },
  deposit,
  gas: 220_000_000_000_000n,
});
console.log(`start_circle tx ${start.transaction.hash}.`);

let daoId = null;
for (let attempt = 0; attempt < 20 && !daoId; attempt += 1) {
  await new Promise((resolve) => setTimeout(resolve, 2_000));
  daoId = await provider.callFunction({ contractId, method: 'get_circle_dao', args: { circle_id: circleId } });
}
if (!daoId) throw new Error(`Circle ${circleId} has no DAO association after callback polling.`);
const policy = await provider.callFunction({ contractId: daoId, method: 'get_policy', args: {} });
const circleRole = policy.roles.find((role) => role.name === 'circle');
const membersRole = policy.roles.find((role) => role.name === 'members');
const correctMembers = membersRole?.kind?.Group?.length === 2 && members.every((id) => membersRole.kind.Group.includes(id));
if (!correctMembers || !circleRole?.kind?.Group?.includes(contractId)) {
  throw new Error('Created DAO policy does not contain this circle contract and both test members.');
}
console.log(JSON.stringify({ circleId, daoId, policyHasContractAndMembers: true, nextCheck: 'Wait past the 60-second round deadline, then propose and vote on apply_removal.' }, null, 2));
