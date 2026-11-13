import fs from 'node:fs';
import path from 'node:path';
import { Account, JsonRpcProvider, KeyPair, KeyPairSigner } from '../frontend/node_modules/near-api-js/lib/index.js';

const envPath = path.resolve('frontend', '.env.local');
if (!fs.existsSync(envPath)) throw new Error('frontend/.env.local is missing.');

function readEnv() {
  return Object.fromEntries(
    fs.readFileSync(envPath, 'utf8')
      .split(/\r?\n/)
      .filter((line) => line.trim() && !line.trim().startsWith('#'))
      .map((line) => {
        const index = line.indexOf('=');
        return [line.slice(0, index).trim(), line.slice(index + 1).trim()];
      }),
  );
}

function setEnvValue(key, value) {
  const contents = fs.readFileSync(envPath, 'utf8');
  const lines = contents.split(/\r?\n/);
  const index = lines.findIndex((line) => line.startsWith(`${key}=`));
  if (index >= 0) lines[index] = `${key}=${value}`;
  else lines.push(`${key}=${value}`);
  fs.writeFileSync(envPath, lines.filter((line, i) => i < lines.length - 1 || line).join('\n'));
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

const env = readEnv();
const funderId = env.FUNDER_ACCOUNT_ID;
const privateKey = env.FUNDER_PRIVATE_KEY;
if (!funderId || !privateKey) throw new Error('Funder account configuration is missing.');

const memberIds = [env.TEST_MEMBER_1_ACCOUNT_ID || `member1.${funderId}`, env.TEST_MEMBER_2_ACCOUNT_ID || `member2.${funderId}`];
if (!env.TEST_MEMBER_1_PRIVATE_KEY || !env.TEST_MEMBER_2_PRIVATE_KEY) {
  throw new Error('The two local test-member signing keys are missing from frontend/.env.local.');
}

const rpcUrl = env.RPC_URL || 'https://rpc.testnet.near.org';
const provider = new JsonRpcProvider({ url: rpcUrl });
const signer = new KeyPairSigner(KeyPair.fromString(privateKey));
const funder = new Account(funderId, provider, signer);
const yocto = 10n ** 24n;
const factoryDeposit = 6n * yocto;

// NEAR requires the sender to retain enough balance to cover its account storage.
const accountState = await provider.viewAccount({ accountId: funderId });
const storageReserve = BigInt(accountState.storage_usage) * 10n ** 19n;
const spendable = BigInt(accountState.amount) - BigInt(accountState.locked) - storageReserve;
const minimumHeadroom = 7n * yocto;
if (spendable < minimumHeadroom) {
  throw new Error(
    `S1 not submitted: spendable testnet balance is ${(Number(spendable) / 1e24).toFixed(3)} NEAR; ` +
      `the factory call needs at least 7 NEAR available for its 6 NEAR deposit and account/storage costs.`,
  );
}

const timestamp = new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14);
const daoName = `ajocircle-s1-${timestamp}`;
const daoId = `${daoName}.sputnikv2.testnet`;
const policy = {
  roles: [
    {
      name: 'circle',
      kind: { Group: [funderId] },
      permissions: ['transfer:AddProposal', 'call:AddProposal', 'remove_member_from_role:AddProposal'],
      vote_policy: {},
    },
    {
      name: 'members',
      kind: { Group: memberIds },
      permissions: [
        'transfer:VoteApprove',
        'transfer:VoteReject',
        'call:VoteApprove',
        'call:VoteReject',
        'remove_member_from_role:VoteApprove',
        'remove_member_from_role:VoteReject',
        '*:Finalize',
      ],
      vote_policy: {
        // Sputnik's current WeightOrRatio uses an untagged JSON enum: a fixed
        // threshold is the decimal string "2", not {"Weight":"2"}.
        transfer: { weight_kind: 'RoleWeight', quorum: '0', threshold: '2' },
        call: { weight_kind: 'RoleWeight', quorum: '0', threshold: [1, 2] },
      },
    },
  ],
  default_vote_policy: { weight_kind: 'RoleWeight', quorum: '0', threshold: [1, 2] },
  proposal_bond: yocto.toString(),
  proposal_period: '604800000000000',
  // Required by Sputnik's current Policy struct, even though these are not
  // relevant to the Level 1 circle flow.
  bounty_bond: yocto.toString(),
  bounty_forgiveness_period: '86400000000000',
};
const config = {
  name: 'Ajocircle S1 Spike',
  purpose: 'Disposable testnet verification of the Ajocircle Sputnik policy',
  metadata: '',
};
const args = Buffer.from(JSON.stringify({ config, policy })).toString('base64');

console.log(`Creating ${daoId} on NEAR testnet...`);
const transaction = await funder.callFunctionRaw({
  contractId: 'sputnikv2.testnet',
  methodName: 'create',
  args: { name: daoName, args },
  deposit: factoryDeposit,
  gas: 150_000_000_000_000n,
});

const actual = await provider.callFunction({ contractId: daoId, method: 'get_policy', args: {} });
if (!actual) throw new Error(`DAO created, but get_policy returned no result for ${daoId}.`);

const actualRoles = actual.roles.map((role) => ({
  ...role,
  permissions: [...role.permissions].sort(),
  kind: role.kind?.Group ? { Group: [...role.kind.Group].sort() } : role.kind,
}));
const expectedRoles = policy.roles.map((role) => ({
  ...role,
  permissions: [...role.permissions].sort(),
  kind: role.kind?.Group ? { Group: [...role.kind.Group].sort() } : role.kind,
}));
const matched =
  JSON.stringify(canonical(actualRoles)) === JSON.stringify(canonical(expectedRoles)) &&
  JSON.stringify(canonical(actual.default_vote_policy)) === JSON.stringify(canonical(policy.default_vote_policy)) &&
  actual.proposal_bond === policy.proposal_bond &&
  actual.proposal_period === policy.proposal_period &&
  actual.bounty_bond === policy.bounty_bond &&
  actual.bounty_forgiveness_period === policy.bounty_forgiveness_period;

setEnvValue('AJOCIRCLE_SPIKE_DAO_ID', daoId);
console.log(JSON.stringify({
  daoId,
  transactionHash: transaction.transaction.hash,
  policyMatchesBrief: matched,
  roles: actual.roles,
  defaultVotePolicy: actual.default_vote_policy,
  proposalBond: actual.proposal_bond,
  proposalPeriod: actual.proposal_period,
  bountyBond: actual.bounty_bond,
  bountyForgivenessPeriod: actual.bounty_forgiveness_period,
}));
if (!matched) process.exitCode = 1;
