import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {ethers} from 'ethers';
const here=path.dirname(fileURLToPath(import.meta.url)),root=path.resolve(here,'../..');
const require=createRequire(import.meta.url);process.env.HARDHAT_CONFIG=path.join(here,'replay_gas.config.cjs');
const hre=require('hardhat'),rpc=(m,p=[])=>hre.network.provider.send(m,p);
const out=path.join(root,'docs/bcra_revision/sepolia_20261027/followup_20261028/evidence');
const read=p=>JSON.parse(fs.readFileSync(p,'utf8').replace(/^\uFEFF/,''));
const aug=read(path.join(out,'august_final_registry_campaign.json'));
const run=path.join(root,'docs/bcra_revision/sepolia_20261027/runs/2026-10-26T20-25-47-088Z');
const oct=read(path.join(run,'transactions.json')),atx=read(path.join(out,'august_rpc_transactions.json')),otx=read(path.join(run,'rpc_transactions.json'));
const codes=read(path.join(out,'deployed_code.json')),results=[];
const word=n=>ethers.toBeHex(n,32),num=s=>BigInt(s.startsWith('0x')?s:'0x'+s);
const iface=new ethers.Interface(read(path.join(run,'compiled.json')).UngatedProvenanceTracker.abi);
for(const campaign of ['august','october']){
 await rpc('hardhat_reset');
 const from=(await rpc('eth_accounts'))[0],to=codes.ungated[campaign+'Address'];
 await rpc('hardhat_setCode',[to,codes.ungated[campaign+'Code']]);
 await rpc('hardhat_setStorageAt',[to,word(0),word(1)]); // excluded warm-up has initialized global record counter
 for(const operation of ['first','append']){
  const row=campaign==='august'?aug.measuredRows.find(r=>r.variant==='ungated'&&r.operation===operation):oct.find(r=>r.group==='E6'&&r.gate==='ungated'&&r.test===operation);
  const hash=campaign==='august'?row.txHash:row.transaction.hash,tx=(campaign==='august'?atx:otx)[hash];
  const previousBlock=await rpc('eth_blockNumber');
  const localHash=await rpc('eth_sendTransaction',[{from,to,data:tx.input,gas:'0x989680',value:'0x0'}]);
  const receipt=await rpc('eth_getTransactionReceipt',[localHash]);
  const trace=await rpc('debug_traceTransaction',[localHash,{disableMemory:true,disableStorage:true}]);
  assert(!trace.failed);assert(!trace.structLogs.some(l=>['CALL','STATICCALL','DELEGATECALL','CALLCODE','CREATE','CREATE2','SELFDESTRUCT','GAS'].includes(l.op)));
  const warm=new Set(),original=new Map(),current=new Map(),stores=[];
  for(const l of trace.structLogs){
   if(!['SLOAD','SSTORE'].includes(l.op))continue;
   const slot=word(num(l.stack.at(-1))),isWarm=warm.has(slot);warm.add(slot);
   if(l.op!=='SSTORE')continue;
   if(!original.has(slot)){const v=BigInt(await rpc('eth_getStorageAt',[to,slot,previousBlock]));original.set(slot,v);current.set(slot,v);}
   const o=original.get(slot),c=current.get(slot),n=num(l.stack.at(-2));
   // This diagnostic intentionally handles only monotone, no-refund writes exercised here.
   assert(!(c!==n&&n===0n));assert(!(c!==n&&n===o));
   const state=(o===0n&&c===0n&&n!==0n)?97920:0;
   const write=(n!==c&&c===o)?10000:0;
   const next=(isWarm?100:2100)+write+state;
   stores.push({pc:l.pc,slot,original:o.toString(),current:c.toString(),next:n.toString(),warm:isWarm,oldGas:l.gasCost,modeledGas:next,delta:next-l.gasCost,newSlot:state>0});current.set(slot,n);
  }
  const raw=ethers.getBytes(tx.input),zeros=raw.filter(x=>x===0).length,calldataGas=zeros*4+(raw.length-zeros)*16;
  const localGas=Number(BigInt(receipt.gasUsed)),opcodeGas=trace.structLogs.reduce((s,l)=>s+l.gasCost,0);
  assert.equal(localGas,21000+calldataGas+opcodeGas,'no refunds or calldata floor in replay');
  const storageDelta=stores.reduce((s,l)=>s+l.delta,0),intrinsicDelta=-6000;
  const modeledGas=localGas+storageDelta+intrinsicDelta;
  const chainGas=campaign==='august'?row.gasUsed:row.gas;
  const decoded=iface.decodeFunctionData('addRecord',tx.input);
  results.push({campaign,operation,transactionHash:hash,onChainGas:chainGas,localLegacyGas:localGas,modeledGlamsterdamGas:modeledGas,storageDelta,intrinsicDelta,newStorageSlots:stores.filter(s=>s.newSlot).length,sstoreCount:stores.length,calldataBytes:raw.length,calldataGas,eventType:Number(decoded[1]),metadataBytes:ethers.toUtf8Bytes(decoded[2]).length,calldataFloor:15000+64*raw.length,gasReconciled:campaign==='august'?localGas===chainGas:modeledGas===chainGas,stores});
 }
}
fs.writeFileSync(path.join(out,'controlled_replay.json'),JSON.stringify({method:'Exact deployed ungated runtime bytecode and recorded calldata; isolated Shanghai EVM execution; trace-based SSTORE and intrinsic repricing under published EIP-2780/8037/8038 parameters. Not an Amsterdam client execution or public-chain trace.',node:process.version,hardhat:require('hardhat/package.json').version,results},null,2));
console.log(JSON.stringify(results.map(({stores,...r})=>r),null,2));
