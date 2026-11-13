import { connect, keyStores, KeyPair } from 'near-api-js';
import * as dotenv from 'dotenv';
dotenv.config();

async function testFunder() {
  const accountId = process.env.FUNDER_ACCOUNT_ID || 'ajopool.testnet';
  const privateKey = process.env.FUNDER_PRIVATE_KEY;

  if (!privateKey) {
    throw new Error('FUNDER_PRIVATE_KEY is missing from .env');
  }

  const keyStore = new keyStores.InMemoryKeyStore();
  const keyPair = KeyPair.fromString(privateKey);
  await keyStore.setKey('testnet', accountId, keyPair);

  const near = await connect({
    networkId: 'testnet',
    keyStore,
    nodeUrl: 'https://test.rpc.fastnear.com',
  });

  const account = await near.account(accountId);
  const balance = await account.getAccountBalance();
  console.log('Funder Account Connected:', accountId);
  console.log('Available Balance (yoctoNEAR):', balance.available);
  console.log('Balance in NEAR:', (BigInt(balance.available) / 10n ** 24n).toString());
}

testFunder().catch(console.error);
