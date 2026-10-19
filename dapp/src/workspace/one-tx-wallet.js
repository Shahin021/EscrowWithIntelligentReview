/** Explicit account selection for the worker step. Never signs or sends. */
export async function selectWorkerAccount(provider) {
  if(!provider?.request) throw new Error('Open this page with MetaMask available.');
  try {
    await provider.request({method:'wallet_requestPermissions',params:[{eth_accounts:{}}]});
  } catch(error) {
    // Wallets without permission selection can still expose the current account.
    if(![4200,-32601].includes(Number(error?.code))) throw error;
  }
  const accounts=await provider.request({method:'eth_requestAccounts'});
  if(!Array.isArray(accounts)||!accounts.length) throw new Error('No account selected. Choose the assigned worker in MetaMask.');
  return accounts;
}

const DISCONNECTED_KEY='escrow-one-tx:explicit-disconnect';
/** One source of truth for explicit disconnect and async wallet responses. */
export function createWalletSession({provider,storage,ensureNetwork,onChange=()=>{}}) {
  let account=null,revision=0;
  let disconnected=storage.readJson(DISCONNECTED_KEY,false)===true;
  const publish=value=>{account=value;onChange(value);return value;};
  return {
    get account(){return account;},
    get revision(){return revision;},
    disconnect(){revision++;disconnected=true;storage.writeJson(DISCONNECTED_KEY,true);publish(null);},
    invalidate(){revision++;publish(null);},
    async connect({passive=false,select=false}={}) {
      if(passive && disconnected)return null;
      if(!provider?.request){if(passive)return null;throw new Error('Open this page with MetaMask available.');}
      const ticket=++revision;
      try {
        const accounts=(select || !passive) ? await selectWorkerAccount(provider) : await provider.request({method:passive?'eth_accounts':'eth_requestAccounts'});
        if(ticket!==revision)return null;
        if(!Array.isArray(accounts)||!accounts.length){publish(null);if(!passive)throw new Error('No account selected in MetaMask.');return null;}
        await ensureNetwork(provider,{interactive:!passive});
        if(ticket!==revision)return null;
        // Re-read after a network switch or account-picker prompt.
        const current=await provider.request({method:'eth_accounts'});
        if(ticket!==revision)return null;
        if(!current?.length){publish(null);return null;}
        await ensureNetwork(provider,{interactive:false});
        if(ticket!==revision)return null;
        if(!passive){storage.writeJson(DISCONNECTED_KEY,false);disconnected=false;}
        return publish(current[0]);
      } catch(error){if(ticket===revision)publish(null);throw error;}
    },
  };
}
