"""Read-only recovery of a deployment already broadcast. No private key."""
import argparse
import json
from pathlib import Path
import sys
import time

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from scripts.deployment_receipt import resolve_deployment_transaction


def status_snapshot(client, tx_id):
    """SDK-compatible data decoding without scanning triggered-message logs."""
    from genlayer_py.types import GenLayerRawTransaction
    contract_config = client.chain.consensus_data_contract
    contract = client.w3.eth.contract(address=contract_config["address"], abi=contract_config["abi"])
    data = contract.functions.getTransactionData(tx_id, int(time.time())).call()
    all_data, _ = contract.functions.getTransactionAllData(tx_id).call()
    transaction = GenLayerRawTransaction.from_transaction_data(data)
    transaction.tx_execution_result = all_data[1]
    decoded = transaction.decode()
    fields = ("status", "status_name", "result_name", "tx_execution_result_name", "recipient", "sender", "tx_id")
    return {k: decoded[k] for k in fields if k in decoded}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--evm-hash", required=True)
    args = parser.parse_args()
    from genlayer_py import create_client
    from genlayer_py.chains import testnet_bradbury
    client = create_client(chain=testnet_bradbury)
    client.initialize_consensus_smart_contract()
    tx_id, address, receipt = resolve_deployment_transaction(client, args.evm_hash)
    print(f"EVM receipt succeeded; gas used: {receipt['gasUsed']}", flush=True)
    print(f"GenLayer ID: {tx_id}", flush=True)
    print(f"Escrow address: {address}", flush=True)
    print(json.dumps(status_snapshot(client, tx_id), indent=2, default=str))


if __name__ == "__main__":
    main()
