import fs from 'node:fs';
import path from 'node:path';
import { JsonRpcProvider } from '../frontend/node_modules/near-api-js/lib/index.js';

const envPath = path.resolve('frontend', '.env.local');
const env = Object.fromEntries(fs.readFileSync(envPath, 'utf8').split(/\r?\n/)
  .filter((line) => line.trim() && !line.trim().startsWith('#'))
  .map((line) => {
    const index = line.indexOf('=');
    return [line.slice(0, index).trim(), line.slice(index + 1).trim()];
  }));
const accountId = env.FUNDER_ACCOUNT_ID || 'ajopool.testnet';
const provider = new JsonRpcProvider({ url: env.RPC_URL || 'https://rpc.testnet.near.org' });
const accountIds = [accountId, env.TEST_MEMBER_1_ACCOUNT_ID || `member1.${accountId}`, env.TEST_MEMBER_2_ACCOUNT_ID || `member2.${accountId}`];
if (env.AJOCIRCLE_SPIKE_DAO_ID) accountIds.push(env.AJOCIRCLE_SPIKE_DAO_ID);
const balances = await Promise.all(accountIds.map(async (id) => {
  const account = await provider.viewAccount({ accountId: id });
  return { accountId: id, balanceNear: (Number(BigInt(account.amount)) / 1e24).toFixed(3), storageUsage: account.storage_usage };
}));
console.log(JSON.stringify(balances, null, 2));
