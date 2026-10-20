import json
import pytest
from test_project_escrow_automation import T0,DAY,at,_addr,set_time,URL,ALLOWED,EVIDENCE

@pytest.fixture
def client(direct_owner): return direct_owner

@pytest.fixture
def worker(direct_alice): return direct_alice

@pytest.fixture(params=['contracts/project_escrow_one_tx.py','dapp/public/contracts/project_escrow_one_tx.packed.py'])
def single(request): return request.param

def create(direct_vm,direct_deploy,client,worker,single):
    direct_vm.sender=client
    direct_vm.warp(at(T0))
    direct_vm.value=1000
    try:
        c=direct_deploy(single,_addr(worker),json.dumps([{'spec':'Deliver completed implementation.','amount':'1000'}]),ALLOWED,'text',1,False,'',0,T0+30*DAY,'a'*64)
    finally: direct_vm.value=0
    set_time(T0)
    return c

def test_client_one_transaction_funds_and_activates(direct_vm,direct_deploy,client,worker,single):
    c=create(direct_vm,direct_deploy,client,worker,single)
    assert c.parties()['project_status']=='ACTIVE'
    assert c.parties()['total_funded']=='1000'
    assert c.get_accounting()['locked']=='1000'
    assert c.get_one_tx_authorizations()['client']['email_hash']=='a'*64

def test_worker_one_transaction_commits_and_authorizes(direct_vm,direct_deploy,client,worker,single):
    c=create(direct_vm,direct_deploy,client,worker,single)
    direct_vm.sender=worker
    c.submit_once(json.dumps([{'url':URL}]),T0+30*DAY,'b'*64)
    assert c.get_milestone_status(0)=='UNDER_REVIEW'
    assert c.get_automation('worker')['max_amount']=='1000'
    with pytest.raises(Exception): c.submit_once(json.dumps([{'url':URL}]),T0+30*DAY,'b'*64)

def test_third_party_cannot_commit_worker_evidence(direct_vm,direct_deploy,client,worker,single):
    c=create(direct_vm,direct_deploy,client,worker,single)
    direct_vm.sender=client
    with pytest.raises(Exception): c.submit_once(json.dumps([{'url':URL}]),T0+30*DAY,'b'*64)
    assert c.get_one_tx_authorizations()['deliveries_committed']=='0'

def _submit(direct_vm,c,worker):
    direct_vm.sender=worker
    c.submit_once(json.dumps([{'url':URL}]),T0+30*DAY,'b'*64)

def _review(direct_vm,c,approved=True,missing=False):
    direct_vm.clear_mocks()
    direct_vm.mock_web(r'.*raw\.githubusercontent\.com.*',{'method':'GET','status':404 if missing else 200,'body':'' if missing else EVIDENCE})
    direct_vm.mock_llm(r'.*',json.dumps({'criteria':[approved],'reason':'Evidence assessed against agreed requirements.'}))
    c.resolve(0)

def test_two_party_actions_then_operator_completes_payment(direct_vm,direct_deploy,client,worker,direct_charlie,single):
    c=create(direct_vm,direct_deploy,client,worker,single) # client action 1
    _submit(direct_vm,c,worker) # worker action 1
    direct_vm.sender=direct_charlie
    direct_vm.deal(direct_vm._contract_address,1000) # Direct Mode does not actually transfer constructor value
    _review(direct_vm,c)
    assert c.get_milestone_status(0)=='APPROVED'
    c.claim_payment(0)
    assert c.get_outflow_recipient(0).lower()==_addr(worker).lower()
    with pytest.raises(Exception): c.confirm_outflow(0) # transfer has not left
    direct_vm.deal(direct_vm._contract_address,0) # simulate completed native transfer
    c.confirm_outflow(0)
    c.close_project()
    assert c.get_project_status()=='CLOSED'
    assert c.get_milestone_status(0)=='RELEASED'
    assert c.get_total_released()=='1000'

def test_operator_refunds_unavailable_evidence_only_after_original_window(direct_vm,direct_deploy,client,worker,direct_charlie,single):
    c=create(direct_vm,direct_deploy,client,worker,single)
    _submit(direct_vm,c,worker)
    direct_vm.sender=direct_charlie
    direct_vm.deal(direct_vm._contract_address,1000)
    _review(direct_vm,c,missing=True)
    assert c.get_milestone_status(0)=='EVIDENCE_UNAVAILABLE'
    with pytest.raises(Exception): c.recover_unavailable_evidence(0)
    set_time(T0+3*DAY)
    c.recover_unavailable_evidence(0)
    assert c.get_outflow_recipient(0).lower()==_addr(client).lower()
    direct_vm.deal(direct_vm._contract_address,0)
    c.confirm_outflow(0)
    c.close_project()
    assert c.get_project_status()=='CLOSED'
    assert c.get_total_refunded()=='1000'

def test_worker_can_revoke_before_automated_claim(direct_vm,direct_deploy,client,worker,direct_charlie,single):
    c=create(direct_vm,direct_deploy,client,worker,single)
    _submit(direct_vm,c,worker)
    c.set_automation('0',0)
    direct_vm.sender=direct_charlie
    _review(direct_vm,c)
    with pytest.raises(Exception): c.claim_payment(0)

def test_commitment_cannot_change_recipient_or_increase_amount(direct_vm,direct_deploy,client,worker,single):
    c=create(direct_vm,direct_deploy,client,worker,single)
    _submit(direct_vm,c,worker)
    assert c.get_one_tx_authorizations()['worker']['max_amount']=='1000'
    assert c.parties()['worker'].lower()==_addr(worker).lower()
    assert c.get_milestone_amount(0)=='1000'

def test_rejection_refunds_after_appeal_window_without_new_party_action(direct_vm,direct_deploy,client,worker,direct_charlie,single):
    c=create(direct_vm,direct_deploy,client,worker,single)
    _submit(direct_vm,c,worker)
    direct_vm.sender=direct_charlie
    direct_vm.deal(direct_vm._contract_address,1000)
    _review(direct_vm,c,approved=False)
    assert c.get_milestone_status(0)=='REJECTED_FINAL'
    with pytest.raises(Exception): c.finalize_rejection(0)
    set_time(T0+4*DAY)
    c.finalize_rejection(0)
    direct_vm.deal(direct_vm._contract_address,0)
    c.confirm_outflow(0)
    c.close_project()
    assert c.get_total_refunded()=='1000'

def test_invalid_worker_bundle_does_not_save_a_partial_commitment(direct_vm,direct_deploy,client,worker,single):
    c=create(direct_vm,direct_deploy,client,worker,single)
    direct_vm.sender=worker
    with pytest.raises(Exception): c.submit_once(json.dumps([{'url':URL,'notes':123}]),T0+DAY,'b'*64)
    assert c.get_one_tx_authorizations()['deliveries_committed']=='0'
    assert c.get_automation('worker')['max_amount']=='0'

def test_two_milestones_need_no_second_worker_submission(direct_vm,direct_deploy,client,worker,direct_charlie,single):
    direct_vm.sender=client
    direct_vm.warp(at(T0));direct_vm.value=2000
    try:
        c=direct_deploy(single,_addr(worker),json.dumps([{'spec':'Deliver completed implementation.','amount':'1000'}]*2),ALLOWED,'text',1,False,'',0,T0+30*DAY,'a'*64)
    finally: direct_vm.value=0
    set_time(T0)
    direct_vm.sender=worker
    c.submit_once(json.dumps([{'url':URL}]*2),T0+30*DAY,'b'*64)
    direct_vm.sender=direct_charlie
    direct_vm.deal(direct_vm._contract_address,2000)
    for i in range(2):
        if i: c.submit_precommitted(i)
        direct_vm.clear_mocks()
        direct_vm.mock_web(r'.*raw\.githubusercontent\.com.*',{'method':'GET','status':200,'body':EVIDENCE})
        direct_vm.mock_llm(r'.*',json.dumps({'criteria':[True],'reason':'All requirements met.'}))
        c.resolve(i)
        c.claim_payment(i)
        direct_vm.deal(direct_vm._contract_address,1000*(1-i))
        c.confirm_outflow(i)
    c.close_project()
    assert c.get_total_released()=='2000'
    assert c.get_project_status()=='CLOSED'
