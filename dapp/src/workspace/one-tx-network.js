/** Wallet switching is an explicit Connect action, never a load-time prompt. */
export async function ensureBradbury(provider, { interactive = false } = {}) {
  let id = Number(await provider.request({method:'eth_chainId'}));
  if (id === 4221) return id;
  if (!interactive) throw new Error(`Wallet reports chain ${id}; Bradbury is 4221. Click Connect wallet to request the correct network.`);
  try {
    await provider.request({method:'wallet_switchEthereumChain',params:[{chainId:'0x107d'}]});
  } catch (error) {
    if (Number(error.code) === 4902) throw new Error('Bradbury (chain ID 4221) is not installed in this wallet. Add Bradbury, then reconnect.');
    throw new Error(`Could not switch this wallet from chain ${id} to Bradbury (4221): ${error.message || 'request rejected'}`);
  }
  id = Number(await provider.request({method:'eth_chainId'}));
  if (id !== 4221) throw new Error(`This wallet still reports chain ${id}; expected Bradbury 4221. Nothing was sent.`);
  return id;
}
