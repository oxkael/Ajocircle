const contractPerNetwork = {
  mainnet: 'hello.near-examples.near',
  testnet: 'hello.near-examples.testnet',
} as const;

export const NetworkId: 'mainnet' | 'testnet' = 'testnet';
export const providerUrl = 'https://test.rpc.fastnear.com';
export const HelloNearContract = contractPerNetwork[NetworkId];
export const PRIVY_APP_ID = 'cmw8wnoi102nl0gkw6n2vrwf0';
