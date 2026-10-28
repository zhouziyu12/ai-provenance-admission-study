import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import solc from 'solc';
import { ethers } from 'ethers';
import * as snarkjs from 'snarkjs';
export const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
export const FIELD=21888242871839275222246405745257275088548364400416034343698204186575808495617n;
export const TYPES={ProvenanceSubmission:[{name:'modelId',type:'uint256'},{name:'eventType',type:'uint8'},{name:'statementHash',type:'uint256'},{name:'nonce',type:'uint256'}]};
export const SIGNED_TYPES={SignedZKSubmission:[{name:'modelId',type:'uint256'},{name:'eventType',type:'uint8'},{name:'metadataHash',type:'bytes32'},{name:'nullifier',type:'uint256'},{name:'nonce',type:'uint256'},{name:'expectedHead',type:'bytes32'},{name:'deadline',type:'uint256'}]};
export const canonical=v=>v&&typeof v==='object'?Array.isArray(v)?'['+v.map(canonical).join(',')+']':'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}':JSON.stringify(v);
const json=v=>JSON.stringify(v,(_,x)=>typeof x==='bigint'?x.toString():x,2);
const sha=v=>crypto.createHash('sha256').update(v).digest('hex');
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function limited(items,fn,n=6){const result=new Array(items.length);let next=0;await Promise.all(Array.from({length:Math.min(n,items.length)},async()=>{while(next<items.length){const i=next++;result[i]=await fn(items[i],i);}}));return result;}
export const names={zk:'ZKProvenanceTracker',sig:'SignatureGatedProvenanceTracker',signed:'SignedZKProvenanceTracker',ungated:'UngatedProvenanceTracker',passive:'PassiveAnchoringTracker'};
export const methods={zk:'addVerifiedRecord',sig:'addSignedRecord',signed:'addSignedVerifiedRecord',ungated:'addRecord',passive:'anchorRecord'};
const sourceNames=['ModelAccessControl','ModelRegistry','Verifier',...Object.values(names)];
export const specs=[
 ['zkReplay','zk','if (nullifierUsed[nullifier]) revert NullifierAlreadyUsed();','// replay guard removed'],
 ['zkMetadata','zk','if (_pubSignals[2] != statementHash) revert InvalidStatementHash();','// metadata binding removed'],
 ['zkModel','zk','if (_pubSignals[1] != _modelId) revert InvalidModelSignal();','// model binding removed'],
 ['zkProof','zk','bool verified = verifier.verifyProof(_pA, _pB, _pC, _pubSignals);','bool verified = true;'],
 ['zkRole','zk','accessControl.hasRole(accessControl.REGISTRAR(), msg.sender),','true,'],
 ['sigReplay','sig','if (nonceUsed[_nonce]) revert NonceAlreadyUsed();','// replay guard removed'],
 ['sigOwner','sig','if (signer != publisher) revert UnauthorisedSigner();','// publisher check removed'],
 ['signedOwner','signed','if (digest.recover(authorization.signature) != owner) revert UnauthorisedSigner();','// owner signature verification removed'],
 ['signedHead','signed','if (authorization.expectedHead != modelChainHead[_modelId]) revert StaleHead();','// expected head check removed'],
 ['signedNonce','signed','if (nonceUsed[owner][authorization.nonce]) revert NonceAlreadyUsed();','// owner nonce guard removed'],
 ['signedProof','signed','bool verified = verifier.verifyProof(_pA, _pB, _pC, _pubSignals);','bool verified = true;'],
 ['signedNullifier','signed','if (nullifierUsed[nullifier]) revert NullifierAlreadyUsed();','// nullifier guard removed']
];
export class Campaign {
 constructor(runId) {
  this.base=path.join(root,'docs/bcra_revision/sepolia_20261027');fs.mkdirSync(this.base,{recursive:true});
  this.runId=runId||new Date().toISOString().replace(/[:.]/g,'-');this.out=path.join(this.base,'runs',this.runId);fs.mkdirSync(this.out,{recursive:true});
  this.stateFile=path.join(this.out,'state.json');this.s=fs.existsSync(this.stateFile)?JSON.parse(fs.readFileSync(this.stateFile)):{runId:this.runId,network:'sepolia',chainId:11155111,createdAt:new Date().toISOString(),deployments:{},models:{},auth:{},tx:{},rows:[],checks:[],stages:[],nextNonce:{},modelCounter:0};
  this.write('protocol.json',{groups:['E1','E2','E3','E4','E5','E6','E7','E8','E9'],securityTrials:5,baselineTrials:10,sizeTrials:10,lifecycleReplicates:3,lifecycleLength:64,
   variants:Object.keys(names),chainId:11155111,allMeasuredWrites:'Actual broadcast transactions, including expected reverts',concurrency:'Concurrent broadcast without controlling block production; observed ordering and blocks retained',
   timing:'Local proof/signature preparation; RPC broadcast latency; broadcast-to-first-inclusion latency; excludes IPFS upload and public-network finality',batching:'At most 24 pending sequential-nonce transactions per broadcast batch; separate receipts and transactions, not multicall',
   fixture:'Synthetic files with valid CIDv1/raw/sha256; not remotely pinned',mutationCount:specs.length});
 }
 log(m){console.log(new Date().toISOString(),m);}
 write(n,v){fs.writeFileSync(path.join(this.out,n),json(v));}
 save(){const temp=this.stateFile+'.tmp';fs.writeFileSync(temp,json(this.s));fs.renameSync(temp,this.stateFile);}
 check(name,actual,expected=true){const c={name,actual,expected,pass:actual===expected};this.s.checks.push(c);if(!c.pass){this.save();throw Error('Assertion failed: '+name+' actual='+actual+' expected='+expected);}}
 async init(){
  const req=new ethers.FetchRequest(process.env.BCRA_SEPOLIA_RPC||'https://ethereum-sepolia-rpc.publicnode.com');req.timeout=30000;
  this.p=new ethers.JsonRpcProvider(req,undefined,{batchMaxCount:1,cacheTimeout:-1});this.p.pollingInterval=1500;
  this.check('connected-chain',Number((await this.p.getNetwork()).chainId),11155111);
  this.wallets={};for(const role of ['governance','unprivileged_relay','groth16_relay','publisher','reserve']){
   const encrypted=fs.readFileSync(path.join(process.env.BCRA_KEYSTORE_DIR,role+'.json'),'utf8');
   this.wallets[role]=(await ethers.Wallet.fromEncryptedJson(encrypted,process.env.BCRA_KEYSTORE_PASSWORD)).connect(this.p);
   if(this.s.nextNonce[role]===undefined)this.s.nextNonce[role]=await this.p.getTransactionCount(this.wallets[role].address,'pending');
  }
  delete process.env.BCRA_KEYSTORE_PASSWORD;
  for(const e of JSON.parse(fs.readFileSync(path.join(root,'zk/artifact_manifest.json'))).artifacts)this.check('zk-artifact:'+e.path,sha(fs.readFileSync(path.join(root,e.path))),e.sha256);
  this.vk=JSON.parse(fs.readFileSync(path.join(root,'zk/verification_key.json')));
  this.compile();this.c={};for(const [key,d] of Object.entries(this.s.deployments))this.c[key]=new ethers.Contract(d.address,this.artifacts[d.name].abi,this.p);
  if(!this.s.environment){
   const block=await this.p.getBlock('latest');this.s.environment={node:process.version,solc:solc.version(),ethers:ethers.version,snarkjs:'0.7.5',os:os.platform()+' '+os.release(),cpu:os.cpus()[0].model,
    compilerSettings:{optimizer:{enabled:true,runs:200},viaIR:true,evmVersion:'paris'},chainId:11155111,startingBlock:block.number,
    addresses:Object.fromEntries(Object.entries(this.wallets).map(([r,w])=>[r,w.address])),sources:Object.fromEntries(sourceNames.map(n=>[n,sha(fs.readFileSync(path.join(root,'contracts',n+'.sol')))])),balances:{}};
   for(const [r,w]of Object.entries(this.wallets))this.s.environment.balances[r]=ethers.formatEther(await this.p.getBalance(w.address));
   this.write('environment.json',this.s.environment);
  }
  this.save();this.log('Initialized '+this.runId);
 }
 compile(){
  const cache=path.join(this.out,'compiled.json');if(fs.existsSync(cache)){this.artifacts=JSON.parse(fs.readFileSync(cache));return;}
  this.log('Compiling original trackers and 12 isolated ablation variants');
  const sources=Object.fromEntries(sourceNames.map(n=>['contracts/'+n+'.sol',{content:fs.readFileSync(path.join(root,'contracts',n+'.sol'),'utf8')}]));
  for(const [key,gate,needle,replacement]of specs){const name='Experiment_'+key,base=names[gate],orig=sources['contracts/'+base+'.sol'].content;assert.equal(orig.split(needle).length,2);sources['contracts/'+name+'.sol']={content:orig.replace('contract '+base+' ','contract '+name+' ').replace(needle,replacement)};}
  const input={language:'Solidity',sources,settings:{optimizer:{enabled:true,runs:200},viaIR:true,evmVersion:'paris',outputSelection:{'*':{'*':['abi','evm.bytecode.object','evm.deployedBytecode.object']}}}};
  const output=JSON.parse(solc.compile(JSON.stringify(input),{import:n=>{const p=path.join(root,n.startsWith('@')?'node_modules':'',n);if(!fs.existsSync(p))return{error:'Missing source '+n};const content=fs.readFileSync(p,'utf8');sources[n]={content};return{contents:content};}}));
  this.write('compiler_diagnostics.json',output.errors||[]);assert(!(output.errors||[]).some(e=>e.severity==='error'));
  this.artifacts=Object.assign({},...Object.values(output.contracts));this.write('compiled.json',this.artifacts);this.write('compile_input.json',{...input,sources});this.write('mutations.json',specs.map(([key,gate,removed,replacement])=>({key,gate,removed,replacement})));
 }
 async fee(){if(this.cachedFee&&Date.now()-this.cachedFeeAt<3000)return this.cachedFee;const f=await this.p.getFeeData(),priority=1000000n;const maxFee=(f.maxFeePerGas||0n)>10000000n?f.maxFeePerGas:10000000n;assert(maxFee<=1000000000n,'Fee cap exceeded: do not broadcast');this.cachedFee={maxFeePerGas:maxFee,maxPriorityFeePerGas:priority,type:2};this.cachedFeeAt=Date.now();return this.cachedFee;}
 async gas(request,role='governance') { const estimate=await this.p.estimateGas({...request,from:this.wallets[role].address});return estimate*125n/100n+100000n; }
 async broadcast(id,role,request,extra={}){
  let item=this.s.tx[id];
  if(!item){const w=this.wallets[role],nonce=this.s.nextNonce[role]++;
   const unsigned={...request,nonce,chainId:11155111,value:request.value||0n,...await this.fee()};
   const raw=await w.signTransaction(unsigned);item={id,role,hash:ethers.keccak256(raw),from:w.address,to:request.to||null,data:request.data||'0x',nonce,raw,
    preparedAt:new Date().toISOString(),...extra};this.s.tx[id]=item;this.save();
  }
  if(item.receipt)return item;
  if(!item.broadcastAt){const t=performance.now();
   try{await this.p.broadcastTransaction(item.raw);}catch(e){if(!/already known|nonce too low|already imported/i.test(e.message)){throw Error('Broadcast '+id+' failed: '+(e.code||e.shortMessage));}}
   item.broadcastAt=new Date().toISOString();item.broadcast_ms=performance.now()-t;this.save();
  }
  return item;
 }
 async settle(items){
  let pending=items.filter(x=>!x.receipt),poll=0;
  while(pending.length){
   for(let i=0;i<pending.length;i+=6){await Promise.all(pending.slice(i,i+6).map(async item=>{
    let r;try{r=await this.p.getTransactionReceipt(item.hash);}catch{ return; }
    if(r){item.receipt=r.toJSON();item.observedAt=new Date().toISOString();item.inclusion_ms=Date.now()-Date.parse(item.broadcastAt||item.preparedAt);}
   }));}
   this.save();pending=items.filter(x=>!x.receipt);if(pending.length){if(++poll%10===0)this.log('Awaiting '+pending.length+' Sepolia receipts');if(poll>300)throw Error('Receipt timeout; resume safely with same run ID');await delay(2000);}
  }
 }
 async transactions(requests){const result=[];for(let i=0;i<requests.length;i+=24){const part=[];for(const q of requests.slice(i,i+24))part.push(await this.broadcast(q.id,q.role,q.request,q.extra));await this.settle(part);result.push(...part);}return result;}
 async setupTx(id,c,method,args=[],role='governance'){
  const data=c.interface.encodeFunctionData(method,args),request={to:await c.getAddress(),data};request.gasLimit=await this.gas(request,role);const [t]=await this.transactions([{id,role,request}]);this.check(id+':success',t.receipt.status,1);return t;
 }
 async deployBatch(entries){
  const reqs=[];for(const [key,name,args]of entries){if(this.c[key])continue;const factory=new ethers.ContractFactory(this.artifacts[name].abi,'0x'+this.artifacts[name].evm.bytecode.object);const d=await factory.getDeployTransaction(...args);let id='deploy/'+key,attempt=0;while(this.s.tx[id]?.receipt?.status===0){id='deploy/'+key+'/retry'+(++attempt);assert(attempt<=3,'Repeated deployment failure');}reqs.push({id,role:'governance',request:{data:d.data,gasLimit:await this.gas({data:d.data})},extra:{contractName:name,key}});}
  const txs=await this.transactions(reqs);for(const t of txs){this.check(t.id+':success',t.receipt.status,1);this.s.deployments[t.key]={name:t.contractName,address:t.receipt.contractAddress,transactionHash:t.hash};this.c[t.key]=new ethers.Contract(t.receipt.contractAddress,this.artifacts[t.contractName].abi,this.p);this.check(t.id+':code-exists',(await this.p.getCode(t.receipt.contractAddress)).length>2);}
  this.write('deployment_addresses.json',this.s.deployments);this.save();
 }
 async deploy(){
  await this.deployBatch([['access','ModelAccessControl',[this.wallets.governance.address]],['verifier','Groth16Verifier',[]]]);
  await this.deployBatch([['registry','ModelRegistry',[await this.c.access.getAddress()]]]);
  await this.setupTx('role/adminRegistrar',this.c.access,'grantRole',[await this.c.access.REGISTRAR(),this.wallets.governance.address]);
  await this.setupTx('role/zkRegistrar',this.c.access,'grantRole',[await this.c.access.REGISTRAR(),this.wallets.groth16_relay.address]);
  const argsFor=gate=>['zk','signed'].includes(gate)?[this.c.access.target,this.c.registry.target,this.c.verifier.target]:gate==='sig'?[this.c.registry.target]:[];
  await this.deployBatch([...Object.entries(names).map(([key,n])=>[key,n,argsFor(key)]),...specs.map(([key,g])=>[key,'Experiment_'+key,argsFor(g)])]);
  await this.models(['warm']);const jobs=[];
  for(const key of [...Object.keys(names),...specs.map(s=>s[0])]){const gate=this.gate(key),m=this.meta(this.model('warm'));const a=await this.auth('warm/'+key,key,this.model('warm'),m);jobs.push(this.job('warm/'+key,'SETUP','warmup',key,a));}
  await this.batch('warmups',jobs,{measured:false});
 }
 gate(key){return names[key]?key:specs.find(s=>s[0]===key)[1];}
 async models(keys){const reqs=[];for(const key of [...new Set(keys)]){if(this.s.models[key]&&this.s.tx['model/'+key]?.receipt)continue;const id=this.s.models[key]||++this.s.modelCounter;this.s.models[key]=id;
   const request={to:this.c.registry.target,data:this.c.registry.interface.encodeFunctionData('registerModelFor',[this.wallets.publisher.address,'SepoliaRevision-'+key,'','','','synthetic','research'])};request.gasLimit=await this.gas(request);reqs.push({id:'model/'+key,role:'governance',request,extra:{modelId:id,modelKey:key}});
  }this.save();const txs=await this.transactions(reqs);for(const t of txs){this.check(t.id+':success',t.receipt.status,1);const e=t.receipt.logs.map(l=>{try{return this.c.registry.interface.parseLog(l)}catch{return null}}).find(x=>x?.name==='ModelRegistered');this.check(t.id+':id',Number(e.args.id),t.modelId);}}
 model(key){assert(this.s.models[key],'Unknown model '+key);return this.s.models[key];}
 fixture(label){
  const bytes=Buffer.from('Sepolia revision artifact '+label),digest=crypto.createHash('sha256').update(bytes).digest();let bits=0,val=0,s='';for(const x of Buffer.concat([Buffer.from([1,85,18,32]),digest])){val=(val<<8)|x;bits+=8;while(bits>=5){s+='abcdefghijklmnopqrstuvwxyz234567'[(val>>>(bits-5))&31];bits-=5;}}if(bits)s+='abcdefghijklmnopqrstuvwxyz234567'[(val<<(5-bits))&31];
  fs.mkdirSync(path.join(this.out,'fixtures'),{recursive:true});fs.writeFileSync(path.join(this.out,'fixtures',label+'.bin'),bytes);return{modelHash:digest.toString('hex'),artifactCid:'b'+s};
 }
 meta(id,version=1,extra={},size){const v={action:'UPDATED',modelId:id,version,...this.fixture('common'),...extra};if(size){v.padding='';const pad=size-Buffer.byteLength(canonical(v));assert(pad>=0);v.padding='x'.repeat(pad);}return canonical(v);}
 async head(key,id){return this.gate(key)==='passive'?null:await this.c[key].modelChainHead(id);}
 async state(key,id){const c=this.c[key],g=this.gate(key);const [length,head]=await Promise.all([g==='passive'?c.getRecordCount(id).then(Number):['zk','signed'].includes(g)?c.getModelHistory(id).then(x=>x.length):c.getHistoryLength(id).then(Number),this.head(key,id)]);return{length,head};}
 async auth(label,key,id,m,options={}){
  if(this.s.auth[label])return this.s.auth[label];const gate=this.gate(key),t=performance.now();let a={id:label,key,gate,model:id,metadata:m,event:options.event??2,ownerRole:options.signer||'publisher',auth_ms:0,verify_ms:0};
  const digest=ethers.keccak256(ethers.toUtf8Bytes(m)),hash=BigInt(digest)%FIELD;a.statementHash=hash.toString();
  if(['zk','signed'].includes(gate)){
   if(options.proof)a.proof=options.proof;else{
    const witness=BigInt('0x'+sha(this.runId+label))%FIELD||1n;
    a.proof=await snarkjs.groth16.fullProve({secret:String(witness),modelId:String(id),messageHash:String(hash)},path.join(root,'zk/build/circuit_js/circuit.wasm'),path.join(root,'zk/circuit_final.zkey'),undefined,undefined,{singleThread:true});
   }
   a.proof_ms=performance.now()-t;const vt=performance.now();this.check(label+':proof-verified',await snarkjs.groth16.verify(this.vk,a.proof.publicSignals,a.proof.proof));a.verify_ms=performance.now()-vt;
   a.proofArgs=JSON.parse('['+await snarkjs.groth16.exportSolidityCallData(a.proof.proof,a.proof.publicSignals)+']');
  }
  if(['sig','signed'].includes(gate)){
   const st=performance.now();a.nonce=options.nonce??BigInt('0x'+sha(this.runId+label+'/nonce')).toString();
   a.domain={name:gate==='signed'?'SignedZKProvenance':'ModelProvenance',version:'1',chainId:11155111,verifyingContract:this.c[key].target,...options.domain};
   if(gate==='signed'){a.expectedHead=options.expectedHead??await this.head(key,id);a.deadline=options.deadline??((await this.p.getBlock('latest')).timestamp+86400);
    a.value={modelId:id,eventType:a.event,metadataHash:digest,nullifier:a.proof.publicSignals[0],nonce:a.nonce,expectedHead:a.expectedHead,deadline:a.deadline};
   }else a.value={modelId:id,eventType:a.event,statementHash:a.statementHash,nonce:a.nonce};
   a.signature=await this.wallets[a.ownerRole].signTypedData(a.domain,gate==='signed'?SIGNED_TYPES:TYPES,a.value);a.sign_ms=performance.now()-st;
  }
  a.auth_ms=(a.proof_ms||0)+(a.sign_ms||0);this.s.auth[label]=a;this.save();return a;
 }
 args(a,mod={}){const id=mod.model??a.model,m=mod.metadata??a.metadata,event=mod.event??a.event;
  if(a.gate==='zk')return[id,event,m,...(mod.proofArgs??a.proofArgs)];
  if(a.gate==='signed')return[id,event,m,...(mod.proofArgs??a.proofArgs),{nonce:mod.nonce??a.nonce,expectedHead:mod.expectedHead??a.expectedHead,deadline:mod.deadline??a.deadline,signature:mod.signature??a.signature}];
  if(a.gate==='sig')return[id,event,m,mod.nonce??a.nonce,mod.signature??a.signature];
  if(a.gate==='ungated')return[id,event,m,mod.owner??this.wallets.publisher.address];
  const v=JSON.parse(m);return[id,v.modelHash,v.artifactCid,m,mod.owner??this.wallets.publisher.address];
 }
 job(id,group,test,key,a,options={}){return{id,group,test,key,gate:this.gate(key),auth:a,expected:true,actor:'groth16_relay',mod:{},...options};}
 async batch(stage,jobs,{measured=true}={}){
  if(this.s.stages.includes(stage))return this.s.rows.filter(r=>r.stage===stage);
  this.log(stage+': '+jobs.length+' transactions');const results=[];
  for(let offset=0;offset<jobs.length;offset+=24){const chunk=jobs.slice(offset,offset+24),snapshots={};
   this.s.batchSnapshots??={};const snapshotKey=stage+'/'+offset;
   if(this.s.batchSnapshots[snapshotKey])Object.assign(snapshots,this.s.batchSnapshots[snapshotKey]);
   else{const unique=[...new Map(chunk.map(j=>[j.key+'/'+(j.mod.model??j.auth.model),j])).entries()];await limited(unique,async([k,j])=>{snapshots[k]=await this.state(j.key,j.mod.model??j.auth.model);});this.s.batchSnapshots[snapshotKey]=snapshots;this.save();}
   const requests=await limited(chunk,async j=>{const request={to:this.c[j.key].target,data:this.c[j.key].interface.encodeFunctionData(methods[j.gate],this.args(j.auth,j.mod))};request.gasLimit=j.expected===false?40000000n:await this.gas(request,j.actor);return{id:j.id,role:j.actor,request,extra:{group:j.group,test:j.test}};});
   const txs=await this.transactions(requests),after={},unique=[...new Map(chunk.map(j=>[j.key+'/'+(j.mod.model??j.auth.model),j])).entries()];await limited(unique,async([k,j])=>{after[k]=await this.state(j.key,j.mod.model??j.auth.model);});
   const evidence=await limited(chunk,async(j,index)=>{const tx=txs[index],c=this.c[j.key],accepted=tx.receipt.status===1;let rejection=null,rec=null;
    if(!accepted){try{await this.p.call({to:tx.to,from:tx.from,data:tx.data,blockTag:tx.receipt.blockNumber});}catch(e){try{rejection=c.interface.parseError(e.data)?.name||e.reason||'REVERT';}catch{rejection=e.reason||'REVERT';}}}
    const eventName=j.gate==='passive'?'RecordAnchored':'RecordAdded',events=tx.receipt.logs.map(l=>{try{return c.interface.parseLog(l)}catch{return null}}).filter(e=>e?.name===eventName);
    if(accepted&&j.gate!=='passive')rec=await c.records(events[0].args.recordId);return{rejection,rec,events};
   });
   for(let index=0;index<chunk.length;index++){
    const j=chunk[index],tx=txs[index],id=j.mod.model??j.auth.model,k=j.key+'/'+id,c=this.c[j.key],accepted=tx.receipt.status===1;
    const {rejection,rec,events:ev}=evidence[index];
    const row={id:j.id,stage,group:j.group,test:j.test,gate:j.gate,variant:j.key,trial:j.trial??0,model:id,auth_id:j.auth.id,expectedAccepted:j.expected,accepted,rejection,
     metadata_bytes:Buffer.byteLength(j.mod.metadata??j.auth.metadata),auth_ms:j.auth.auth_ms,verify_ms:j.auth.verify_ms,proof_ms:j.auth.proof_ms??0,sign_ms:j.auth.sign_ms??0,
     broadcast_ms:tx.broadcast_ms,inclusion_ms:tx.inclusion_ms,pipeline_ms:j.auth.auth_ms+tx.inclusion_ms,gas:Number(tx.receipt.gasUsed),batch_before:snapshots[k],batch_after:after[k],
     transaction:{hash:tx.hash,from:tx.from,to:tx.to,data:tx.data,nonce:tx.nonce,broadcastAt:tx.broadcastAt},receipt:tx.receipt,...j.tags};
    if(j.expected!==null)this.check(j.id+':accepted',accepted,j.expected);
    this.check(j.id+':write-event-count',ev.length,accepted?1:0);
    if(accepted&&j.gate!=='passive'){
     row.record=Object.fromEntries(['recordId','modelId','eventType','ipfsMetadata','timestamp','operator','previousHash','recordHash'].map(f=>[f,typeof rec[f]==='bigint'?String(rec[f]):rec[f]]));
     this.check(j.id+':record-metadata',rec.ipfsMetadata,j.mod.metadata??j.auth.metadata);this.check(j.id+':record-model',Number(rec.modelId),id);this.check(j.id+':eventType',Number(rec.eventType),j.mod.event??j.auth.event);
     const owner=(['sig','signed'].includes(j.gate)?this.wallets[j.auth.ownerRole].address:j.gate==='zk'?this.wallets[j.actor].address:j.mod.owner??this.wallets.publisher.address);
     if(j.key!=='signedOwner')this.check(j.id+':operator',rec.operator,owner);
     const recomputed=ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(['uint256','uint256','uint8','string','uint256','address','bytes32'],[rec.recordId,rec.modelId,rec.eventType,rec.ipfsMetadata,rec.timestamp,rec.operator,rec.previousHash]));this.check(j.id+':record-hash',recomputed,rec.recordHash);
    }
    results.push(row);if(measured&&!this.s.rows.some(r=>r.id===row.id))this.s.rows.push(row);this.save();
   }
   for(const [k,before]of Object.entries(snapshots)){const successes=chunk.filter((j,i)=>j.key+'/'+(j.mod.model??j.auth.model)===k&&txs[i].receipt.status===1).length;this.check(stage+':history-'+k,after[k].length,before.length+successes);if(successes===0)this.check(stage+':head-unchanged-'+k,after[k].head,before.head);}
  }
  this.s.stages.push(stage);this.save();this.write('transactions.json',this.s.rows);this.write('authorizations.json',this.s.auth);this.write('checks.json',this.s.checks);return results;
 }
 async finish(){
  this.write('transactions.json',this.s.rows);this.write('authorizations.json',this.s.auth);this.write('checks.json',this.s.checks);
  const experimentChecks=this.s.checks.filter(c=>!c.name.startsWith('deploy/')&&c.name!=='E9/fund_owner');this.write('experiment_checks.json',experimentChecks);
  const completion={complete:true,finishedAt:new Date().toISOString(),chainId:11155111,observations:this.s.rows.length,assertions:experimentChecks.length,allAssertionsPassed:experimentChecks.every(c=>c.pass),
   groups:Object.fromEntries([...new Set(this.s.rows.map(r=>r.group))].map(g=>[g,this.s.rows.filter(r=>r.group===g).length])),allBroadcastTransactions:Object.keys(this.s.tx).length};
  this.write('completion.json',completion);fs.writeFileSync(path.join(this.base,'LATEST.txt'),this.runId);this.log('COMPLETE '+completion.observations+' measured Sepolia transactions');
 }
}
