import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {ethers} from 'ethers';
import {root,names,methods,TYPES,SIGNED_TYPES,FIELD} from './engine.mjs';
const base=path.join(root,'docs/bcra_revision/sepolia_20261027');
const offline=process.argv.includes('--offline');
const runId=process.argv.slice(2).find(a=>!a.startsWith('--'))||fs.readFileSync(path.join(base,'LATEST.txt'),'utf8').trim();
const out=path.join(base,'runs',runId),read=n=>JSON.parse(fs.readFileSync(path.join(out,n)));
const s=read(fs.existsSync(path.join(out,'state.json'))?'state.json':'public_run.json'),rows=s.rows,compiled=read('compiled.json');
const rpc=process.env.BCRA_SEPOLIA_RPC||'https://ethereum-sepolia-rpc.publicnode.com';
let count=0;const eq=(a,b,label)=>{count++;assert.deepEqual(a,b,label);};
const receipts={},transactions={};
async function batchRpc(calls){
 for(let attempt=0;attempt<4;attempt++){
  try{const res=await fetch(rpc,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(calls),signal:AbortSignal.timeout(30000)});
   assert(res.ok,'RPC HTTP '+res.status);const values=await res.json();assert(Array.isArray(values),'Batch RPC unsupported');
   const index=new Map(values.map(v=>[v.id,v]));return calls.map(q=>{const v=index.get(q.id);assert(v&&!v.error&&v.result,'Missing RPC result '+q.method);return v.result;});
  }catch(e){if(attempt===3)throw e;await new Promise(r=>setTimeout(r,1000*(attempt+1)));}
 }
}
const selectedSetup=Object.values(s.tx).filter(t=>t.receipt?.status===1&&(!t.group||t.group==='SETUP'));
const allHashes=[...new Set([...rows.map(r=>r.transaction.hash),...selectedSetup.map(t=>t.hash)])];
if(offline){Object.assign(receipts,read('rpc_receipts.json'));Object.assign(transactions,read('rpc_transactions.json'));}
else for(let i=0;i<allHashes.length;i+=12){const slice=allHashes.slice(i,i+12),calls=[];
 for(let n=0;n<slice.length;n++){calls.push({jsonrpc:'2.0',id:n*2,method:'eth_getTransactionReceipt',params:[slice[n]]},{jsonrpc:'2.0',id:n*2+1,method:'eth_getTransactionByHash',params:[slice[n]]});}
 const results=await batchRpc(calls);for(let n=0;n<slice.length;n++){receipts[slice[n]]=results[n*2];transactions[slice[n]]=results[n*2+1];}
 if(i%120===0)console.log(new Date().toISOString(),'Re-fetched',Math.min(i+slice.length,allHashes.length),'/',allHashes.length,'Sepolia transaction/receipt pairs');
}
const seen=new Set();
for(const r of rows){
 const h=r.transaction.hash,t=transactions[h],receipt=receipts[h];
 eq(seen.has(h),false,'unique measured hash');seen.add(h);
 eq(Number(BigInt(t.chainId)),11155111,'actual transaction chain ID');
 eq(receipt.transactionHash,h,'receipt association');eq(Number(BigInt(receipt.status)),r.accepted?1:0,'mined status');
 eq(Number(BigInt(receipt.gasUsed)),r.gas,'actual receipt gas');eq(Number(BigInt(receipt.blockNumber)),r.receipt.blockNumber,'block number');
 eq(receipt.blockHash,r.receipt.blockHash,'canonical block hash');eq(t.input.toLowerCase(),r.transaction.data.toLowerCase(),'actual calldata');
 eq(t.from.toLowerCase(),r.transaction.from.toLowerCase(),'actual broadcaster');eq(t.to.toLowerCase(),r.transaction.to.toLowerCase(),'actual target');
 if(r.expectedAccepted!==null)eq(r.accepted,r.expectedAccepted,'expected behavior');
 const name=s.deployments[r.variant].name,iface=new ethers.Interface(compiled[name].abi);
 let call;try{call=iface.parseTransaction({data:t.input});}catch{}
 if(r.kind==='administrative_or_interface'){
  eq(r.after.length-r.before.length,r.expectedRecordDelta,'administrative history effect');
  const writes=receipt.logs.map(l=>{try{return iface.parseLog(l)}catch{return null}}).filter(e=>e?.name==='RecordAdded');
  eq(writes.length,r.expectedRecordDelta,'administrative write events');continue;
 }
 assert(call,'decode measured call');eq(call.name,methods[r.gate],'correct entrypoint');eq(Number(call.args[0]),r.model,'submitted model');
 const a=s.auth[r.auth_id];assert(a,'authorization evidence');
 eq(BigInt(a.statementHash),BigInt(ethers.keccak256(ethers.toUtf8Bytes(a.metadata)))%FIELD,'metadata statement hash');
 const logged=receipt.logs.filter(l=>l.address.toLowerCase()===t.to.toLowerCase()).map(l=>{try{return iface.parseLog(l)}catch{return null}}).filter(e=>e&&['RecordAdded','RecordAnchored'].includes(e.name));
 eq(logged.length,r.accepted?1:0,'write-event count');
 if(r.accepted&&r.gate!=='passive'){
  const rec=r.record;assert(rec,'stored record');eq(rec.modelId,String(r.model),'stored model');eq(rec.ipfsMetadata,call.args[2],'stored submitted metadata');
  eq(rec.eventType,String(call.args[1]),'stored event type');eq(rec.recordId,String(logged[0].args.recordId),'record ID');
  eq(ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(['uint256','uint256','uint8','string','uint256','address','bytes32'],[rec.recordId,rec.modelId,rec.eventType,rec.ipfsMetadata,rec.timestamp,rec.operator,rec.previousHash])),rec.recordHash,'independent record hash');
 }
 if(['sig','signed'].includes(r.gate)){
  const types=r.gate==='signed'?SIGNED_TYPES:TYPES;
  eq(ethers.verifyTypedData(a.domain,types,a.value,a.signature).toLowerCase(),s.environment.addresses[a.ownerRole].toLowerCase(),'persisted authorization signature');
 }
}
for(const [key,d]of Object.entries(s.deployments)){
 const t=transactions[d.transactionHash];assert(t,'successful deployment transaction retrieved');
 eq(t.to,null,'creation transaction');eq(receipts[d.transactionHash].contractAddress.toLowerCase(),d.address.toLowerCase(),'deployed address');
 eq(t.input.slice(2).startsWith(compiled[d.name].evm.bytecode.object),true,'creation code matches compiled source');
}
const pairs=new Map();for(const r of rows.filter(r=>r.test==='concurrent_same_authorized_head')){const k=r.gate+'/'+r.trial;if(!pairs.has(k))pairs.set(k,[]);pairs.get(k).push(r);}
for(const [k,pair]of pairs)eq(pair.filter(r=>r.accepted).length,k.startsWith('signed/')?1:2,'concurrent admission outcome');
eq([...new Set(rows.map(r=>r.group))].sort(),['E1','E2','E3','E4','E5','E6','E7','E8','E9'],'all experiment groups');
const record={pass:true,network:'sepolia',chainId:11155111,measuredRows:rows.length,reFetchedTransactionPairs:allHashes.length,independentAssertions:count,
 observedAt:new Date().toISOString(),mode:offline?'offline validation of supplied receipt re-fetch evidence':'receipt re-fetch audit',scope:(offline?'Supplied RPC evidence validation; ':'Fresh public RPC transaction and receipt retrieval; ')+'calldata, status, gas, signatures, events, deployment code, record hashes and group coverage checked. Performed by the experiment workflow, not an independent external audit.'};
if(offline){delete record.reFetchedTransactionPairs;record.suppliedTransactionPairs=allHashes.length;fs.writeFileSync(path.join(out,'offline_validation.json'),JSON.stringify(record,null,2));}
else {fs.writeFileSync(path.join(out,'independent_audit.json'),JSON.stringify(record,null,2));fs.writeFileSync(path.join(out,'receipt_refetch_audit.json'),JSON.stringify(record,null,2));
fs.writeFileSync(path.join(out,'rpc_receipts.json'),JSON.stringify(receipts));fs.writeFileSync(path.join(out,'rpc_transactions.json'),JSON.stringify(transactions));}
console.log(JSON.stringify(record,null,2));
