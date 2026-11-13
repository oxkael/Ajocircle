import { Account, JsonRpcProvider, KeyPairSigner, KeyPair } from '../frontend/node_modules/near-api-js/lib/index.js';
import * as fs from 'fs';
import * as path from 'path';

async function deploy() {
  const envPath = path.resolve('frontend', '.env.local');
  if (!fs.existsSync(envPath)) {
    throw new Error(`Cannot find .env.local at ${envPath}`);
  }
  const lines = fs.readFileSync(envPath, 'utf8').split('\n');
  const env = {};
  for (const l of lines) {
    const trimmed = l.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const [k, ...v] = trimmed.split('=');
    env[k.trim()] = v.join('=').trim();
  }

  const accountId = env.FUNDER_ACCOUNT_ID || 'ajopool.testnet';
  const privateKey = env.FUNDER_PRIVATE_KEY;
  const nodeUrl = env.RPC_URL || 'https://rpc.testnet.near.org';
  if (!privateKey) throw new Error('FUNDER_PRIVATE_KEY is missing from frontend/.env.local');

  console.log(`Deploying circle contract to ${accountId}...`);
  const wasmPath = path.resolve('contracts', 'circle', 'target', 'near', 'circle.wasm');
  if (!fs.existsSync(wasmPath)) {
    throw new Error(`Cannot find wasm binary at ${wasmPath}`);
  }
  const wasmBytes = fs.readFileSync(wasmPath);
  console.log(`Read ${wasmBytes.length} bytes from ${wasmPath}`);

  const keyPair = KeyPair.fromString(privateKey);
  const signer = new KeyPairSigner(keyPair);
  const provider = new JsonRpcProvider({ url: nodeUrl });
  const account = new Account(accountId, provider, signer);

  const balBefore = await provider.viewAccount({ accountId });
  console.log(`Current account balance: ${(Number(BigInt(balBefore.amount)) / 1e24).toFixed(3)} NEAR`);

  console.log('Sending deploy transaction to NEAR testnet...');
  const deployTx = await account.deployContract(new Uint8Array(wasmBytes));
  console.log(`Deploy Tx hash: ${deployTx.transaction.hash}`);

  // This account is already initialized. Never call `new()` during an upgrade.

  // Verify view method
  console.log('Testing view call `get_circles()`...');
  const decoded = await provider.callFunction({ contractId: accountId, method: 'get_circles', args: {} });
  console.log('View method returned successfully! Circles in contract:', decoded);

  const daoView = await provider.callFunction({ contractId: accountId, method: 'get_circle_dao', args: { circle_id: 0 } });
  console.log('DAO view method returned successfully:', daoView);

  console.log(`\nWASM DEPLOYMENT SUCCESSFUL! Existing contract state was preserved at: ${accountId}`);
}

deploy().catch(err => {
  console.error('Deployment failed:', err);
  process.exit(1);
});
