import { Account, JsonRpcProvider, KeyPairSigner, KeyPair } from 'near-api-js';
import * as fs from 'fs';
import * as path from 'path';

async function deploy() {
  const envPath = path.resolve('.env.local');
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
  const nodeUrl = env.RPC_URL || 'https://test.rpc.fastnear.com';

  console.log(`Deploying circle contract to ${accountId}...`);
  const wasmPath = path.resolve('..', 'contracts', 'circle', 'target', 'wasm32-unknown-unknown', 'release', 'circle.wasm');
  if (!fs.existsSync(wasmPath)) {
    throw new Error(`Cannot find wasm binary at ${wasmPath}`);
  }
  const wasmBytes = fs.readFileSync(wasmPath);
  console.log(`Read ${wasmBytes.length} bytes from ${wasmPath}`);

  const keyPair = KeyPair.fromString(privateKey);
  const signer = new KeyPairSigner(keyPair);
  const provider = new JsonRpcProvider({ url: nodeUrl });
  const account = new Account(accountId, provider, signer);

  const balBefore = await account.getBalance();
  console.log(`Current Balance: ${(Number(balBefore) / 1e24).toFixed(3)} NEAR`);

  console.log('Sending deploy transaction to NEAR testnet...');
  const deployTx = await account.deployContract(new Uint8Array(wasmBytes));
  console.log(`Deploy Tx hash: ${deployTx.transaction.hash}`);

  // Initialize the contract state
  console.log('Calling init method `new()`...');
  try {
    const initTx = await account.callFunction({
      contractId: accountId,
      method: 'new',
      args: {},
      gas: 30000000000000n, // 30 TGas
    });
    console.log(`Init Tx hash: ${initTx.transaction.hash}`);
  } catch (err) {
    if (err.message && err.message.includes('Already initialized')) {
      console.log('Contract already initialized.');
    } else {
      console.warn('Init call result/warning:', err.message);
    }
  }

  // Verify view method
  console.log('Testing view call `get_circles()`...');
  const circles = await provider.callFunction({
    account_id: accountId,
    method_name: 'get_circles',
    args_base64: Buffer.from('{}').toString('base64'),
    finality: 'optimistic',
  });
  const decoded = JSON.parse(Buffer.from(circles.result).toString('utf8'));
  console.log('View method returned successfully! Circles in contract:', decoded);

  console.log(`\nDEPLOYMENT SUCCESSFUL! Contract active at: ${accountId}`);
}

deploy().catch(err => {
  console.error('Deployment failed:', err);
  process.exit(1);
});
