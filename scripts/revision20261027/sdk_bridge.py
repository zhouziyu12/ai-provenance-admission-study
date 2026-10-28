"""Sepolia SDK bridge: account key arrives on stdin and is never saved or printed."""
import json
import hashlib
import sys
import tempfile
import time
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[2]))
from eth_account import Account
from sdk.python.provenance_sdk import ProvenanceSDK
from sdk.python.typed_data_signer import EthAccountSigner
data=json.load(sys.stdin)
if data.pop('mode',None)=='upload':
    sdk=ProvenanceSDK(project_root=tempfile.gettempdir(),pinata_api_key=data.pop('pinataApiKey'),
                      pinata_secret_api_key=data.pop('pinataSecret'))
    model_path=data['modelPath']
    started=time.perf_counter()
    model_hash=hashlib.sha256(Path(model_path).read_bytes()).hexdigest()
    hash_ms=(time.perf_counter()-started)*1000
    started=time.perf_counter()
    uploaded=sdk._upload_model_to_ipfs(model_path)
    print(json.dumps({'modelHash':model_hash,'artifactCid':uploaded['ipfsCid'],'provider':uploaded['provider'],
                     'hash_ms':hash_ms,'upload_ms':(time.perf_counter()-started)*1000}))
    sys.exit(0)
account=Account.from_key(data.pop('privateKey'))
if 'nonce' in data:data['nonce']=int(data['nonce'])
class TimedSigner(EthAccountSigner):
    elapsed_ms=0
    signature=None
    def sign_typed_data(self,domain,types,message):
        started=time.perf_counter()
        self.signature=super().sign_typed_data(domain,types,message)
        self.elapsed_ms=(time.perf_counter()-started)*1000
        return self.signature
signer=TimedSigner(account)
sdk=ProvenanceSDK(base_url=data.pop('baseUrl'),project_root=tempfile.gettempdir(),access_token=data.pop('accessToken'),timeout=300)
sdk.current_user={'walletAddress':account.address}
started=time.perf_counter()
result=sdk.submit_signed_zk_record(signer=signer,**data)
for field in ('modelId','eventType','nullifier','nonce','deadline'):
    result['typedData']['message'][field]=str(result['typedData']['message'][field])
print(json.dumps({'relayer':result['relayer'],'typedData':result['typedData'],'signature':signer.signature,
                 'python_sign_ms':signer.elapsed_ms,'sdk_http_chain_ms':(time.perf_counter()-started)*1000}))
