import fs from 'node:fs';
import path from 'node:path';
import {
  Account,
  JsonRpcProvider,
  KeyPair,
  KeyPairSigner,
  actions,
} from '../frontend/node_modules/near-api-js/lib/index.js';

const envPath = path.resolve('frontend', '.env.local');
const env = Object.fromEntries(fs.readFileSync(envPath, 'utf8').split(/\r?\n/)
  .filter((line) => line.trim() && !line.trim().startsWith('#'))
  .map((line) => {
    const index = line.indexOf('=');
    return [line.slice(0, index).trim(), line.slice(index + 1).trim()];
  }));
const updateLocalEnv = (key, value) => {
  const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/)
    .filter((line) => !line.startsWith(`${key}=`));
  if (value !== null) lines.push(`${key}=${value}`);
  fs.writeFileSync(envPath, `${lines.filter(Boolean).join('\n')}\n`);
  if (value === null) delete env[key];
  else env[key] = value;
};

const contractId = env.FUNDER_ACCOUNT_ID || 'ajopool.testnet';
const tokenId = `ajusd.${contractId}`;
const member1Id = env.TEST_MEMBER_1_ACCOUNT_ID || `member1.${contractId}`;
const member2Id = env.TEST_MEMBER_2_ACCOUNT_ID || `member2.${contractId}`;
const provider = new JsonRpcProvider({ url: env.RPC_URL || 'https://rpc.testnet.near.org' });
const yocto = 10n ** 24n;
const account = (id, key) => new Account(id, provider, new KeyPairSigner(KeyPair.fromString(key)));
const organizer = account(contractId, env.FUNDER_PRIVATE_KEY);
const member1 = account(member1Id, env.TEST_MEMBER_1_PRIVATE_KEY);
const member2 = account(member2Id, env.TEST_MEMBER_2_PRIVATE_KEY);
if (!env.FUNDER_PRIVATE_KEY || !env.TEST_MEMBER_1_PRIVATE_KEY || !env.TEST_MEMBER_2_PRIVATE_KEY) {
  throw new Error('Required testnet signer keys are missing from frontend/.env.local');
}

const tokenWasmPath = path.resolve('contracts', 'circle', 'target', 'near', 'ajocircle_test_token.wasm');
const circleWasmPath = path.resolve('contracts', 'circle', 'target', 'near', 'circle.wasm');
const tokenWasm = fs.readFileSync(tokenWasmPath);
const circleWasm = fs.readFileSync(circleWasmPath);

let tokenExists = true;
let createdTokenAccount = false;
try {
  await provider.viewAccount({ accountId: tokenId });
} catch {
  tokenExists = false;
}
if (!tokenExists) {
  console.log(`Creating ${tokenId} with 2 NEAR for deployment storage and gas.`);
  let created;
  try {
    created = await organizer.createAccount({
      newAccountId: tokenId,
      publicKey: KeyPair.fromString(env.FUNDER_PRIVATE_KEY).getPublicKey().toString(),
      nearToTransfer: 2n * yocto,
    });
  } catch (error) {
    if (!String(error?.message).toLowerCase().includes('lacks balance')) throw error;
    const bridge = yocto / 4n;
    console.log('Shifting 0.25 NEAR from each controlled test member to cover the funder storage reserve.');
    for (const member of [member1, member2]) {
      await member.signAndSendTransaction({ receiverId: contractId, actions: [actions.transfer(bridge)] });
    }
    updateLocalEnv('AJOCIRCLE_TESTNET_MEMBER_REFUND_YOCTO', String(yocto / 5n));
    created = await organizer.createAccount({
      newAccountId: tokenId,
      publicKey: KeyPair.fromString(env.FUNDER_PRIVATE_KEY).getPublicKey().toString(),
      nearToTransfer: 2n * yocto,
    });
  }
  createdTokenAccount = true;
  console.log(`Token account creation tx ${created.transaction.hash}.`);
}

const token = account(tokenId, env.FUNDER_PRIVATE_KEY);
let tokenInitialized = true;
try {
  await provider.callFunction({ contractId: tokenId, method: 'ft_metadata', args: {} });
} catch {
  tokenInitialized = false;
}
console.log(`Deploying ${tokenWasm.length}-byte test token Wasm while preserving token storage.`);
const tokenCodeUpgrade = await token.deployContract(new Uint8Array(tokenWasm));
console.log(`Token deploy/upgrade tx ${tokenCodeUpgrade.transaction.hash}.`);
if (!tokenInitialized) {
  const initialized = await token.callFunctionRaw({
    contractId: tokenId,
    methodName: 'new',
    args: { owner_id: contractId, initial_supply: '100000000000' },
    deposit: 0n,
    gas: 100_000_000_000_000n,
  });
  console.log(`Token initialization tx ${initialized.transaction.hash}.`);
}
if (createdTokenAccount) {
  const reserveReturn = await token.signAndSendTransaction({
    receiverId: contractId,
    actions: [actions.transfer((2n * yocto) / 5n)],
  });
  console.log(`Returned 0.4 NEAR of unused token-account balance; tx ${reserveReturn.transaction.hash}.`);
}

console.log(`Upgrading the state-preserving circle contract at ${contractId}.`);
const upgraded = await organizer.deployContract(new Uint8Array(circleWasm));
console.log(`Circle contract upgrade tx ${upgraded.transaction.hash}.`);

const bounds = await provider.callFunction({ contractId: tokenId, method: 'storage_balance_bounds', args: {} });
const registrationDeposit = BigInt(bounds.min);
for (const memberId of [member1Id, member2Id]) {
  const balance = await provider.callFunction({
    contractId: tokenId,
    method: 'storage_balance_of',
    args: { account_id: memberId },
  });
  if (!balance) {
    const registered = await organizer.callFunctionRaw({
      contractId: tokenId,
      methodName: 'storage_deposit',
      args: { account_id: memberId, registration_only: true },
      deposit: registrationDeposit,
      gas: 80_000_000_000_000n,
    });
    console.log(`Registered ${memberId} on token; tx ${registered.transaction.hash}.`);
  }
}

for (const [member, memberId] of [[member1, member1Id], [member2, member2Id]]) {
  const mintedBalance = await provider.callFunction({
    contractId: tokenId,
    method: 'ft_balance_of',
    args: { account_id: memberId },
  });
  if (BigInt(mintedBalance) < 10_000_000n) {
    const faucet = await member.callFunctionRaw({
      contractId: tokenId,
      methodName: 'faucet',
      args: { amount: '10000000' },
      deposit: 0n,
      gas: 80_000_000_000_000n,
    });
    console.log(`Faucet funded ${memberId}; tx ${faucet.transaction.hash}.`);
  }
}

const circleName = `AJUSD round ${Date.now()}`;
const existingCircles = await provider.callFunction({ contractId, method: 'get_circles', args: {} });
const circleId = Math.max(0, ...existingCircles.map(({ id }) => Number(id))) + 1;
const created = await organizer.callFunctionRaw({
  contractId,
  methodName: 'create_token_circle',
  args: {
    name: circleName,
    amount_per_round: '1000000',
    interval_seconds: 3600,
    grace_period_seconds: 600,
    max_members: 2,
    token_id: tokenId,
  },
  deposit: 0n,
  gas: 100_000_000_000_000n,
});
console.log(`Created token circle ${circleId}; tx ${created.transaction.hash}.`);

for (const [member, memberId, slot] of [[member1, member1Id, 0], [member2, member2Id, 1]]) {
  const joined = await member.callFunctionRaw({
    contractId,
    methodName: 'join',
    args: { circle_id: circleId, slot },
    deposit: 0n,
    gas: 60_000_000_000_000n,
  });
  console.log(`${memberId} joined slot ${slot}; tx ${joined.transaction.hash}.`);
}

const balancesBefore = {};
for (const memberId of [member1Id, member2Id]) {
  const balance = await provider.callFunction({
    contractId: tokenId,
    method: 'ft_balance_of',
    args: { account_id: memberId },
  });
  balancesBefore[memberId] = BigInt(balance);
}

for (const [member, memberId] of [[member1, member1Id], [member2, member2Id]]) {
  const paid = await member.callFunctionRaw({
    contractId: tokenId,
    methodName: 'ft_transfer_call',
    args: { receiver_id: contractId, amount: '1000000', memo: null, msg: String(circleId) },
    deposit: 1n,
    gas: 200_000_000_000_000n,
  });
  console.log(`${memberId} contributed 1 AJUSD; tx ${paid.transaction.hash}.`);
}

const roundReady = await provider.callFunction({ contractId, method: 'get_round_status', args: { circle_id: circleId } });
if (!roundReady?.is_round_fully_paid || roundReady.paid_members.length !== 2) {
  throw new Error(`Round was not fully funded after both NEP-141 transfers: ${JSON.stringify(roundReady)}`);
}

const requested = await member1.callFunctionRaw({
  contractId,
  methodName: 'request_payout',
  args: { circle_id: circleId },
  deposit: 0n,
  gas: 60_000_000_000_000n,
});
console.log(`Member1 requested payout; tx ${requested.transaction.hash}.`);
const approved = await member2.callFunctionRaw({
  contractId,
  methodName: 'confirm_payout',
  args: { circle_id: circleId },
  deposit: 0n,
  gas: 100_000_000_000_000n,
});
console.log(`Member2 confirmed payout; tx ${approved.transaction.hash}.`);

let finalRound;
for (let attempt = 0; attempt < 30; attempt += 1) {
  await new Promise((resolve) => setTimeout(resolve, 2_000));
  finalRound = await provider.callFunction({ contractId, method: 'get_round_status', args: { circle_id: circleId } });
  if (finalRound.current_round === 1) break;
}
if (finalRound?.current_round !== 1) {
  throw new Error(`Token payout callback did not advance the round: ${JSON.stringify(finalRound)}`);
}

const balancesAfter = {};
for (const memberId of [member1Id, member2Id]) {
  const balance = await provider.callFunction({ contractId: tokenId, method: 'ft_balance_of', args: { account_id: memberId } });
  balancesAfter[memberId] = BigInt(balance);
}
if (balancesAfter[member1Id] !== balancesBefore[member1Id] + 1_000_000n
  || balancesAfter[member2Id] !== balancesBefore[member2Id] - 1_000_000n) {
  throw new Error(`Unexpected token balances after payout: ${JSON.stringify(Object.fromEntries(Object.entries(balancesAfter).map(([id, value]) => [id, value.toString()])))}`);
}

for (const [member, memberId] of [[member1, member1Id], [member2, member2Id]]) {
  const paid = await member.callFunctionRaw({
    contractId: tokenId,
    methodName: 'ft_transfer_call',
    args: { receiver_id: contractId, amount: '1000000', memo: null, msg: String(circleId) },
    deposit: 1n,
    gas: 200_000_000_000_000n,
  });
  console.log(`${memberId} contributed 1 AJUSD to round 2; tx ${paid.transaction.hash}.`);
}
const secondRequest = await member2.callFunctionRaw({
  contractId,
  methodName: 'request_payout',
  args: { circle_id: circleId },
  deposit: 0n,
  gas: 60_000_000_000_000n,
});
console.log(`Member2 requested round 2 payout; tx ${secondRequest.transaction.hash}.`);
const secondApproval = await member1.callFunctionRaw({
  contractId,
  methodName: 'confirm_payout',
  args: { circle_id: circleId },
  deposit: 0n,
  gas: 100_000_000_000_000n,
});
console.log(`Member1 confirmed round 2 payout; tx ${secondApproval.transaction.hash}.`);

let completedCircle;
for (let attempt = 0; attempt < 30; attempt += 1) {
  await new Promise((resolve) => setTimeout(resolve, 2_000));
  completedCircle = await provider.callFunction({ contractId, method: 'get_circle', args: { circle_id: circleId } });
  if (completedCircle.status === 'Ended') break;
}
if (completedCircle?.status !== 'Ended' || completedCircle.collected_members.length !== 2) {
  throw new Error(`Circle did not finish after the two scheduled payouts: ${JSON.stringify(completedCircle)}`);
}
for (const memberId of [member1Id, member2Id]) {
  const finalBalance = await provider.callFunction({
    contractId: tokenId,
    method: 'ft_balance_of',
    args: { account_id: memberId },
  });
  if (BigInt(finalBalance) !== balancesBefore[memberId]) {
    throw new Error(`Full-cycle balance mismatch for ${memberId}: before ${balancesBefore[memberId]}, after ${finalBalance}`);
  }
}

console.log(JSON.stringify({
  result: 'PASS',
  token: tokenId,
  tokenMetadata: await provider.callFunction({ contractId: tokenId, method: 'ft_metadata', args: {} }),
  circleId,
  firstPayoutRecipient: member1Id,
  secondPayoutRecipient: member2Id,
  completedRounds: completedCircle.collected_members.length,
  finalStatus: completedCircle.status,
  finalBalancesMatchStartingBalances: true,
}, null, 2));
const bridgeRefundPerMember = BigInt(env.AJOCIRCLE_TESTNET_MEMBER_REFUND_YOCTO || '0');
if (bridgeRefundPerMember > 0n) {
  for (const member of [member1, member2]) {
    const refund = await organizer.signAndSendTransaction({
      receiverId: member.accountId,
      actions: [actions.transfer(bridgeRefundPerMember)],
    });
    console.log(`Reimbursed ${member.accountId}; tx ${refund.transaction.hash}.`);
  }
  updateLocalEnv('AJOCIRCLE_TESTNET_MEMBER_REFUND_YOCTO', null);
}
