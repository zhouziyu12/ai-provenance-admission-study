import { ethers } from 'ethers';
import { specs } from './engine.mjs';
const gates=['zk','sig','signed'],all=['passive','ungated','sig','zk','signed'];
const trials=Array.from({length:5},(_,i)=>i),perf=Array.from({length:10},(_,i)=>i);
const done=(C,s)=>C.s.stages.includes(s);
async function e1(C){
 if(done(C,'E1'))return;
 const keys=gates.flatMap(g=>trials.flatMap(t=>['matching','inconsistent'].map(k=>`E1/${g}/${t}/${k}`)));await C.models(keys);const jobs=[];
 for(const g of gates)for(const t of trials)for(const mismatch of [false,true]){
  const label=`E1/${g}/${t}/${mismatch?'inconsistent':'matching'}`,id=C.model(label),aFile=C.fixture('A-'+t),bFile=C.fixture('B-'+t);
  const m=C.meta(id,1,{modelHash:aFile.modelHash,artifactCid:mismatch?bFile.artifactCid:aFile.artifactCid});
  jobs.push(C.job(label,'E1',mismatch?'hash_A_cid_B':'hash_A_cid_A',g,await C.auth(label,g,id,m),{trial:t,tags:{artifactAgreement:!mismatch}}));
 }await C.batch('E1',jobs);
}
async function e2(C){
 const keys=gates.flatMap(g=>trials.map(t=>`E2/${g}/${t}`));await C.models(keys);
 for(const step of ['first','replay','fresh_authorization']){
  if(done(C,'E2/'+step))continue;const jobs=[];
  for(const g of gates)for(const t of trials){const k=`E2/${g}/${t}`,id=C.model(k),m=C.meta(id,1,{trial:t});
   const a=await C.auth(k+(step==='fresh_authorization'?'/fresh':'/first'),g,id,m);
   jobs.push(C.job(k+'/'+step,'E2',step==='fresh_authorization'?(g==='sig'?'fresh_nonce_duplicate':g==='signed'?'fresh_proof_nonce_head_duplicate':'fresh_secret_duplicate'):step,g,a,{expected:step!=='replay',trial:t}));
  }await C.batch('E2/'+step,jobs);
 }
}
async function e3(C){
 if(done(C,'E3'))return;
 const fields=g=>['eventType','modelId','metadata',...(g==='sig'?['nonce','signature']:['pA','pB','pC','signal0','signal1','signal2']),...(g==='signed'?['nonce','signature','expectedHead','deadline']:[])];
 const keys=gates.flatMap(g=>trials.flatMap(t=>fields(g).map(f=>`E3/${g}/${t}/${f}`)));keys.push('E3/other');await C.models(keys);const jobs=[];
 for(const g of gates)for(const t of trials)for(const field of fields(g)){
  const k=`E3/${g}/${t}/${field}`,id=C.model(k),m=C.meta(id,1,{trial:t,field}),a=await C.auth(k,g,id,m),mod={};let expected=false;
  if(field==='eventType'){mod.event=5;expected=g==='zk';}
  if(field==='modelId')mod.model=C.model('E3/other');
  if(field==='metadata')mod.metadata=C.meta(id,99,{trial:t,field});
  if(field==='nonce')mod.nonce=(BigInt(a.nonce)+1n).toString();
  if(field==='deadline')mod.deadline=a.deadline+1000;
  if(field==='expectedHead')mod.expectedHead=ethers.id('different-head');
  if(field==='signature')mod.signature=(await C.auth(k+'/attacker',g,id,m,{signer:'unprivileged_relay'})).signature;
  if(g!=='sig'&&(/^(pA|pB|pC|signal)/.test(field))){mod.proofArgs=structuredClone(a.proofArgs);
   if(field==='pA')mod.proofArgs[0]=['0','0'];if(field==='pB')mod.proofArgs[1]=[['0','0'],['0','0']];if(field==='pC')mod.proofArgs[2]=['0','0'];
   if(field.startsWith('signal')){const index=Number(field.at(-1));mod.proofArgs[3][index]=String(BigInt(mod.proofArgs[3][index])+1n);}
  }jobs.push(C.job(k,'E3','mutate_'+field,g,a,{mod,expected,trial:t}));
 }await C.batch('E3',jobs);
}
async function e4(C){
 if(done(C,'E4')&&done(C,'E4/registrar'))return;
 const cases=['valid_unprivileged','missing_authorization','forged_owner'];
 await C.models(gates.flatMap(g=>trials.flatMap(t=>cases.map(k=>`E4/${g}/${t}/${k}`))));const jobs=[];
 for(const g of gates)for(const t of trials)for(const test of cases){
  const k=`E4/${g}/${t}/${test}`,id=C.model(k),m=C.meta(id,1,{trial:t}),a=await C.auth(k,g,id,m,{signer:test==='forged_owner'?'groth16_relay':'publisher'});
  if(test==='forged_owner'&&g==='zk')continue;
  const mod=test==='missing_authorization'?(g==='zk'?{proofArgs:[['0','0'],[['0','0'],['0','0']],['0','0'],a.proofArgs[3]]}:{signature:'0x'}):{};
  jobs.push(C.job(k,'E4',test,g,a,{actor:test==='valid_unprivileged'?'unprivileged_relay':'groth16_relay',expected:test==='valid_unprivileged'&&g!=='zk',mod,trial:t}));
 }await C.batch('E4',jobs);
 if(!done(C,'E4/registrar')){
  const valid=[];for(const t of trials){const k=`E4/zk/${t}/valid_unprivileged`;valid.push(C.job(k+'/registrar','E4','valid_registrar','zk',C.s.auth[k],{trial:t}));}await C.batch('E4/registrar',valid);
 }
}
async function e5(C){
 await C.models(gates.flatMap(g=>trials.flatMap(t=>[`E5/${g}/${t}/delay`,`E5/${g}/${t}/concurrent`])));
 // Both authorizations are generated before either write.
 for(const g of gates)for(const t of trials){const k=`E5/${g}/${t}/delay`,id=C.model(k);for(const v of [1,2])await C.auth(k+'/v'+v,g,id,C.meta(id,v,{authorizedHead:ethers.ZeroHash,trial:t}));}
 for(const v of [2,1]){
  const stage='E5/delayed/v'+v;if(done(C,stage))continue;const jobs=[];
  for(const g of gates)for(const t of trials){const k=`E5/${g}/${t}/delay`;jobs.push(C.job(k+'/submit'+v,'E5',v===2?'newer_version_first':'delayed_old_authorization',g,C.s.auth[k+'/v'+v],{expected:v===2||g!=='signed',trial:t}));}await C.batch(stage,jobs);
 }
 if(!done(C,'E5/signed_reauthorize')){const jobs=[];for(const t of trials){const k=`E5/signed/${t}/delay`,id=C.model(k),m=C.s.auth[k+'/v1'].metadata;jobs.push(C.job(k+'/reauthorize','E5','owner_reauthorizes_old_business_version','signed',await C.auth(k+'/fresh_old','signed',id,m),{trial:t}));}await C.batch('E5/signed_reauthorize',jobs);}
 if(!done(C,'E5/concurrent')){
  const jobs=[];for(const g of gates)for(const t of trials){const k=`E5/${g}/${t}/concurrent`,id=C.model(k);
   for(const v of [2,1]){const a=await C.auth(k+'/v'+v,g,id,C.meta(id,v,{authorizedHead:ethers.ZeroHash,trial:t}));
    jobs.push(C.job(k+'/submit'+v,'E5','concurrent_same_authorized_head',g,a,{expected:g==='signed'?null:true,actor:v===2?'groth16_relay':g==='zk'?'governance':'unprivileged_relay',trial:t,tags:{submittedVersion:v}}));}
  }
  const rows=await C.batch('E5/concurrent',jobs);
  for(const g of gates)for(const t of trials){const pair=rows.filter(r=>r.gate===g&&r.trial===t);C.check(`E5/concurrent/${g}/${t}:accepted-count`,pair.filter(r=>r.accepted).length,g==='signed'?1:2);C.check(`E5/concurrent/${g}/${t}:chain`,await C.c[g].verifyChain(C.model(`E5/${g}/${t}/concurrent`)));}
  C.write('concurrency_observations.json',rows.map(r=>({gate:r.gate,trial:r.trial,version:r.submittedVersion,accepted:r.accepted,tx:r.transaction.hash,block:r.receipt.blockNumber,index:r.receipt.index,broadcastAt:r.transaction.broadcastAt,rejection:r.rejection})));
 }
}
async function e6(C){
 await C.models(perf.map(t=>'E6/'+t));
 for(const v of [1,2]){const stage='E6/'+(v===1?'first':'append');if(done(C,stage))continue;const jobs=[];
  for(const t of perf){const id=C.model('E6/'+t),m=C.meta(id,v,{trial:t},512),order=all.slice(t%5).concat(all.slice(0,t%5));
   for(const g of order){const k=`E6/${g}/${t}/v${v}`;jobs.push(C.job(k,'E6',v===1?'first':'append',g,await C.auth(k,g,id,m),{trial:t,tags:{pair:`${t}-${v}`}}));}
  }await C.batch(stage,jobs);
 }
 if(!done(C,'E6/security_controls')){const jobs=[];await C.models(['E6/passive/control','E6/ungated/control']);
  // Separate models avoid state-dependent assertions across multiple writes in one batch.
  for(const g of ['passive','ungated']){const id=C.model('E6/'+g+'/control'),a=await C.auth('E6/'+g+'/control',g,id,C.meta(id,1,{artifactCid:C.fixture('B-0').artifactCid}));
   for(const test of ['inconsistent_reference','duplicate','unprivileged_tampered'])jobs.push(C.job(`E6/${g}/${test}`,'E6',test,g,a,{actor:test==='unprivileged_tampered'?'unprivileged_relay':'groth16_relay',mod:test==='unprivileged_tampered'?{metadata:C.meta(id,99),owner:C.wallets.unprivileged_relay.address}:{}}));
  }await C.batch('E6/security_controls',jobs);
 }
}
async function e7(C){
 await C.models(specs.flatMap(([key])=>trials.map(t=>`E7/${key}/${t}`)).concat(['E7/other']));
 if(!done(C,'E7/valid')){
  const jobs=[];for(const [key,g]of specs)for(const t of trials)for(const [condition,c]of [['full',g],['ablated',key]]){
   const k=`E7/${key}/${t}/${condition}`,id=C.model(`E7/${key}/${t}`),m=C.meta(id,1,{trial:t,ablation:key});
   const a=await C.auth(k+'/valid',c,id,m);jobs.push(C.job(k+'/valid','E7',key+'_valid',c,a,{trial:t,tags:{condition,ablation:key}}));
   if(key==='signedHead')await C.auth(k+'/attack',c,id,C.meta(id,2,{trial:t,ablation:key}));
  }await C.batch('E7/valid',jobs);
 }
 if(!done(C,'E7/attack')){
  const jobs=[];for(const [key,g]of specs)for(const t of trials)for(const [condition,c]of [['full',g],['ablated',key]]){
   const k=`E7/${key}/${t}/${condition}`,id=C.model(`E7/${key}/${t}`),valid=C.s.auth[k+'/valid'];let a=valid,mod={},actor='groth16_relay';
   if(!key.endsWith('Replay')){
    const options={};if(key==='signedNonce')options.nonce=valid.nonce;
    if(key==='signedNullifier')options.proof=valid.proof;
    if(['sigOwner','signedOwner'].includes(key))options.signer='groth16_relay';
    const m=key==='signedNullifier'?valid.metadata:C.meta(id,2,{trial:t,ablation:key});
    a=await C.auth(k+'/attack',c,id,m,options);
   }
   if(key==='zkMetadata')mod.metadata=C.meta(id,99);
   if(key==='zkModel')mod.model=C.model('E7/other');
   if(['zkProof','signedProof'].includes(key)){mod.proofArgs=structuredClone(a.proofArgs);mod.proofArgs[0]=['0','0'];}
   if(key==='zkRole')actor='unprivileged_relay';
   jobs.push(C.job(k+'/attack','E7',key+'_attack',c,a,{trial:t,actor,mod,expected:condition==='ablated',tags:{condition,ablation:key}}));
  }await C.batch('E7/attack',jobs);
 }
}
async function e8(C){
 await C.models([256,512,1024,2048,4096].flatMap(s=>perf.map(t=>`E8/size/${s}/${t}`)).concat([0,1,2].map(t=>'E8/lifecycle/'+t)));
 for(const size of [256,512,1024,2048,4096]){const stage='E8/size/'+size;if(done(C,stage))continue;const jobs=[];
  for(const t of perf){const id=C.model(`E8/size/${size}/${t}`),m=C.meta(id,1,{},size),order=all.slice(t%5).concat(all.slice(0,t%5));
   for(const g of order){const k=`${stage}/${g}/${t}`;jobs.push(C.job(k,'E8','metadata_size',g,await C.auth(k,g,id,m),{trial:t,tags:{size}}));}
  }await C.batch(stage,jobs);
 }
 for(let length=1;length<=64;length++){
  const stage='E8/lifecycle/'+length;if(done(C,stage))continue;const jobs=[];
  for(const t of [0,1,2]){const id=C.model('E8/lifecycle/'+t),m=C.meta(id,length,{trial:t},512);
   for(const g of all){const k=`${stage}/${g}/${t}`;jobs.push(C.job(k,'E8','lifecycle',g,await C.auth(k,g,id,m),{trial:t,tags:{length}}));}
  }await C.batch(stage,jobs);
  if([1,8,32,64].includes(length)){
   C.s.chainVerification??=[];
   for(const t of [0,1,2])for(const g of ['ungated','sig','zk','signed']){const id=C.model('E8/lifecycle/'+t);const valid=await C.c[g].verifyChain(id);C.check(`E8/chain/${g}/${t}/${length}`,valid);const gas=await C.c[g].verifyChain.estimateGas(id);C.s.chainVerification.push({gate:g,trial:t,length,gasEstimate:String(gas),valid});}
   C.write('chain_verification.json',C.s.chainVerification);C.save();
  }
 }
}
export async function experiments(C){
 await e1(C);await e2(C);await e3(C);await e4(C);await e5(C);await e6(C);await e7(C);await e8(C);
 const {signedExtra}=await import('./signed_extra.mjs');await signedExtra(C);
}
