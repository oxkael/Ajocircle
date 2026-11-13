import { KeyPair, connect, keyStores } from 'near-api-js';
import * as fs from 'fs';
import * as path from 'path';

function loadEnv() {
  const envPath = path.resolve('frontend', '.env.local');
  if (!fs.existsSync(envPath)) {
    throw new Error(`Cannot find .env.local at ${envPath}`);
  }
  const lines = fs.readFileSync(envPath, 'utf8').split('\n');
  const env = {};
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const [key, ...rest] = trimmed.split('=');
    env[key.trim()] = rest.join('=').trim();
  }
  return env;
}

export async function fundAccount(receiverId, amountNear = '0.25') {
  const env = loadEnv();
  const funderId = env.FUNDER_ACCOUNT_ID;
  const funderKey = env.FUNDER_PRIVATE_KEY;
  const networkId = env.NETWORK_ID || 'testnet';
  const nodeUrl = env.RPC_URL || 'https://test.rpc.fastnear.com';

  if (!funderId || !funderKey) {
    throw new Error('FUNDER_ACCOUNT_ID or FUNDER_PRIVATE_KEY missing in .env.local');
  }

  const keyStore = new keyStores.InMemoryKeyStore();
  const keyPair = KeyPair.fromString(funderKey);
  await keyStore.setKey(networkId, funderId, keyPair);

  const near = await connect({
    networkId,
    nodeUrl,
    keyStore,
  });

  const account = await near.account(funderId);
  const yoctoAmount = (BigInt(Math.floor(parseFloat(amountNear) * 1e6)) * 10n ** 18n).toString();

  console.log(`Sending ${amountNear} NEAR (${yoctoAmount} yoctoNEAR) from ${funderId} to ${receiverId}...`);
  const result = await account.sendMoney(receiverId, yoctoAmount);
  console.log(`Funding transaction confirmed: ${result.transaction.hash}`);
  return result.transaction.hash;
}

const targetReceiver = process.argv[2];
if (targetReceiver) {
  fundAccount(targetReceiver)
    .then((hash) => {
      console.log(`Success! Tx: https://testnet.nearblocks.io/txns/${hash}`);
      process.exit(0);
    })
    .catch((err) => {
      console.error('Funding failed:', err);
      process.exit(1);
    });
}
