"""Resolve EVM deployment receipts to their separate GenLayer transaction IDs."""


def resolve_deployment_transaction(client, evm_hash):
    """Read an existing EVM receipt; never submit or sign anything."""
    from web3.logs import DISCARD

    receipt = client.w3.eth.wait_for_transaction_receipt(evm_hash, timeout=120)
    if int(receipt["status"]) != 1:
        raise RuntimeError(f"EVM deployment failed: {evm_hash}; no GenLayer wait performed")
    consensus = client.chain.consensus_main_contract
    contract = client.w3.eth.contract(address=consensus["address"], abi=consensus["abi"])
    events = contract.get_event_by_name("NewTransaction").process_receipt(receipt, DISCARD)
    events = [event for event in events
              if event["address"].lower() == consensus["address"].lower()]
    if len(events) != 1:
        raise RuntimeError(f"Expected one consensus NewTransaction event, got {len(events)}; EVM hash: {evm_hash}")
    args = events[0]["args"]
    return client.w3.to_hex(args["txId"]), args["recipient"], receipt


def wait_for_deployment(client, evm_hash, retries=120, interval=3000):
    """Await the decoded GenLayer ID, preserving both IDs in diagnostics."""
    from genlayer_py.types import TransactionStatus

    print(f"EVM transaction hash: {evm_hash}", flush=True)
    tx_id, address, _ = resolve_deployment_transaction(client, evm_hash)
    print(f"GenLayer transaction ID: {tx_id}", flush=True)
    print(f"Escrow candidate address: {address}", flush=True)
    try:
        receipt = client.wait_for_transaction_receipt(
            transaction_hash=tx_id, status=TransactionStatus.FINALIZED,
            retries=retries, interval=interval)
    except Exception:
        print("Tracking stopped; use recover_deployment.py with the EVM hash above. "
              "This does not establish failure and does not require resubmission.", flush=True)
        raise
    return tx_id, receipt
