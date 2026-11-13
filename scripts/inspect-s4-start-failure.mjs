import fs from 'node:fs';
import path from 'node:path';
import { JsonRpcProvider } from '../frontend/node_modules/near-api-js/lib/index.js';

const env = Object.fromEntries(fs.readFileSync(path.resolve('frontend', '.env.local'), 'utf8').split(/\r?\n/)
  .filter((line) => line.trim() && !line.trim().startsWith('#'))
  .map((line) => { const i = line.indexOf('='); return [line.slice(0, i).trim(), line.slice(i + 1).trim()]; }));
const provider = new JsonRpcProvider({ url: env.RPC_URL || 'https://rpc.testnet.near.org' });
const result = await provider.viewTransactionStatusWithReceipts({ txHash: '4oBtFz8vZ7uQnZbevh3D71bRVXFGSydCreV8fi13uHCK', accountId: env.FUNDER_ACCOUNT_ID || 'ajopool.testnet' });
console.log(JSON.stringify({
  status: result.status,
  failures: result.receipts_outcome.filter((receipt) => receipt.outcome.status.Failure).map((receipt) => ({
    receiptId: receipt.id,
    executorId: receipt.outcome.executor_id,
    failure: receipt.outcome.status.Failure,
  })),
}, null, 2));
