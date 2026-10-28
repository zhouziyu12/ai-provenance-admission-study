"""Read-only public-chain evidence for the October 28 technical handover."""
import concurrent.futures as cf
import datetime as dt
import hashlib
import json
from pathlib import Path
import requests

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'docs/bcra_revision/sepolia_20261027/followup_20261028/evidence'
OUT.mkdir(parents=True, exist_ok=True)
RUN = ROOT / 'docs/bcra_revision/sepolia_20261027/runs/2026-10-26T20-25-47-088Z'
AUG = ROOT / 'docs/bcra_revision/evidence/final_registry_campaign/20260821T135455148Z_event_audited_final_20260904'
RPC = 'https://ethereum-sepolia-rpc.publicnode.com'
def read(p): return json.loads(p.read_text(encoding='utf-8-sig'))
def save(n,d): (OUT/n).write_text(json.dumps(d,indent=2),encoding='utf-8')
def rpc(method,params):
    r=requests.post(RPC,json={'jsonrpc':'2.0','id':1,'method':method,'params':params},timeout=45)
    r.raise_for_status(); d=r.json()
    if 'error' in d: raise RuntimeError(str(d['error']))
    return d['result']
def cached(n,fn):
    p=OUT/n
    if p.exists(): return read(p)
    d=fn();save(n,d);return d
def main():
    aug=read(AUG/'final_registry_campaign.json') if AUG.exists() else read(OUT/'august_final_registry_campaign.json');october=read(RUN/'transactions.json')
    ar=aug['measuredRows']+aug['passiveRows']
    txs={}; receipts={}
    def fetch(r):
        h=r['txHash'];return h,rpc('eth_getTransactionByHash',[h]),rpc('eth_getTransactionReceipt',[h])
    if not (OUT/'august_rpc_transactions.json').exists():
        with cf.ThreadPoolExecutor(max_workers=4) as pool:
            for h,t,r in pool.map(fetch,ar): txs[h]=t;receipts[h]=r
        save('august_rpc_transactions.json',txs);save('august_rpc_receipts.json',receipts)
    print('August transactions fetched',flush=True)
    txs=read(OUT/'august_rpc_transactions.json');receipts=read(OUT/'august_rpc_receipts.json')
    for r in ar:
        rr=receipts[r['txHash']];assert int(rr['gasUsed'],16)==r['gasUsed'];assert int(rr['blockNumber'],16)==r['blockNumber'];assert int(rr['status'],16)==1
    bounds={'august_measured':[min(r['blockNumber'] for r in ar),max(r['blockNumber'] for r in ar)],
            'october_measured':[min(r['receipt']['blockNumber'] for r in october),max(r['receipt']['blockNumber'] for r in october)]}
    blocks=cached('boundary_blocks.json',lambda:{str(b):rpc('eth_getBlockByNumber',[hex(b),False]) for b in sorted({v for pair in bounds.values() for v in pair})})
    save('block_ranges.json',bounds)
    def fork():
        target=1791294816;lo=bounds['august_measured'][1];hi=bounds['october_measured'][0]
        while lo+1<hi:
            mid=(lo+hi)//2;b=rpc('eth_getBlockByNumber',[hex(mid),False])
            if int(b['timestamp'],16)<target:lo=mid
            else:hi=mid
        return {'activationTimestamp':target,'lastPreActivation':rpc('eth_getBlockByNumber',[hex(lo),False]),'firstAtOrAfterActivation':rpc('eth_getBlockByNumber',[hex(hi),False])}
    cached('activation_boundary.json',fork)
    print('Block ranges and fork boundary fetched',flush=True)
    deps=read(RUN/'deployment_addresses.json')
    mapping={'ungated':'ungated','eip712':'sig','groth16':'zk','passive':'passive'}
    def codes():
        ans={}
        for old,new in mapping.items():
            a=aug['contracts'][old];o=deps[new]['address']
            ans[new]={'augustAddress':a,'octoberAddress':o}
            for month,address in [('august',a),('october',o)]:
                tag=hex(bounds[month+'_measured'][1])
                try:code=rpc('eth_getCode',[address,tag])
                except RuntimeError:
                    tag='latest';code=rpc('eth_getCode',[address,tag])
                ans[new][month+'Code']=code;ans[new][month+'CodeBlockTag']=tag
        return ans
    cached('deployed_code.json',codes)
    print('Deployed bytecode fetched',flush=True)
    cases={}
    for op in ['first','append']:
        cases['august_ungated_'+op]=next(r['txHash'] for r in ar if r['variant']=='ungated' and r['operation']==op)
        cases['october_ungated_'+op]=next(r['transaction']['hash'] for r in october if r['group']=='E6' and r['gate']=='ungated' and r['test']==op)
    for name,h in cases.items():
        p=OUT/(name+'_trace.json')
        if p.exists():continue
        try:
            trace=rpc('debug_traceTransaction',[h,{'disableMemory':True,'disableStorage':True,'enableReturnData':False,'timeout':'20s'}])
            save(p.name,{'txHash':h,'available':True,'trace':trace})
            print(name,'trace available',flush=True)
        except Exception as e:
            save(p.name,{'txHash':h,'available':False,'error':str(e)[:500]})
            print(name,'trace unavailable',flush=True)
    save('collection.json',{'retrievedAt':dt.datetime.now(dt.timezone.utc).isoformat(),'endpoint':RPC,'augustReceiptsMatched':len(ar),'chainId':int(rpc('eth_chainId',[]),16),'mode':'read-only; no transaction broadcast'})
if __name__=='__main__':main()
