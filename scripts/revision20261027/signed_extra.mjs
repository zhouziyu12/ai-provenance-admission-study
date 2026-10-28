import {ethers} from 'ethers';
const ts=[0,1,2,3,4];
const done=(C,s)=>C.s.stages.includes(s);
async function actions(C,stage,entries,{group='E9',measured=false}={}){
 if(done(C,stage))return;
 const before={};for(const e of entries)if(e.track!==undefined)before[e.id]=await C.state(e.track,e.model);
 const requests=[];
 for(const e of entries){const request={to:C.c[e.contract].target,data:e.data??C.c[e.contract].interface.encodeFunctionData(e.method,e.args||[])};request.gasLimit=e.expected===false?40000000n:await C.gas(request,e.actor||'governance');requests.push({id:e.id,role:e.actor||'governance',request});}
 const txs=await C.transactions(requests);
 for(let i=0;i<entries.length;i++){
  const e=entries[i],tx=txs[i],accepted=tx.receipt.status===1;C.check(e.id+':status',accepted,e.expected!==false);
  let after=null;if(e.track!==undefined){after=await C.state(e.track,e.model);C.check(e.id+':history-delta',after.length-before[e.id].length,e.delta??0);}
  if(measured&&!C.s.rows.some(r=>r.id===e.id))C.s.rows.push({id:e.id,stage,group,test:e.test||e.method,kind:'administrative_or_interface',gate:e.track||'signed',variant:e.track||'signed',model:e.model,
   expectedAccepted:e.expected!==false,accepted,gas:Number(tx.receipt.gasUsed),broadcast_ms:tx.broadcast_ms,inclusion_ms:tx.inclusion_ms,
   before:before[e.id]||null,after,expectedRecordDelta:e.delta??0,transaction:{hash:tx.hash,from:tx.from,to:tx.to,data:tx.data,nonce:tx.nonce,broadcastAt:tx.broadcastAt},receipt:tx.receipt});
 }
 C.s.stages.push(stage);C.save();
}
export async function signedExtra(C){
 const cases=['cross_chain','cross_contract','expired','nonce_reuse','invalid_retry','proof_replacement','head_edit','blacklist','revoked','transfer','admin_exception','legacy_entry'];
 await C.models(cases.flatMap(k=>ts.map(t=>`E9/${k}/${t}`)));
 if(!done(C,'E9/domain_and_proof')){
  const jobs=[];
  for(const t of ts)for(const test of ['cross_chain','cross_contract','expired','proof_replacement']){
   const k=`E9/${test}/${t}`,id=C.model(k),m=C.meta(id,1,{trial:t}),options={};
   if(test==='cross_chain')options.domain={chainId:1};
   if(test==='cross_contract')options.domain={verifyingContract:C.c.signedHead.target};
   if(test==='expired')options.deadline=1;
   const a=await C.auth(k,'signed',id,m,options),mod={};
   if(test==='proof_replacement')mod.proofArgs=(await C.auth(k+'/replacement','signed',id,m)).proofArgs;
   jobs.push(C.job(k,'E9',test,'signed',a,{expected:false,mod,trial:t}));
  }await C.batch('E9/domain_and_proof',jobs);
 }
 if(!done(C,'E9/invalid_proof')){
  const jobs=[];for(const t of ts){const k=`E9/invalid_retry/${t}`,id=C.model(k),a=await C.auth(k,'signed',id,C.meta(id)),p=structuredClone(a.proofArgs);p[0]=['0','0'];jobs.push(C.job(k+'/bad','E9','invalid_proof_no_consumption','signed',a,{expected:false,mod:{proofArgs:p},trial:t}));}
  await C.batch('E9/invalid_proof',jobs);
  for(const t of ts){const a=C.s.auth[`E9/invalid_retry/${t}`];C.check(a.id+':nonce-unconsumed',await C.c.signed.nonceUsed(C.wallets.publisher.address,a.nonce),false);C.check(a.id+':nullifier-unconsumed',await C.c.signed.nullifierUsed(a.proof.publicSignals[0]),false);}
 }
 if(!done(C,'E9/retry_valid'))await C.batch('E9/retry_valid',ts.map(t=>C.job(`E9/invalid_retry/${t}/retry`,'E9','valid_retry_same_authorization','signed',C.s.auth[`E9/invalid_retry/${t}`],{trial:t})));
 for(const test of ['nonce_reuse','head_edit']){
  const firstStage='E9/'+test+'/first';
  if(!done(C,firstStage)){const jobs=[];for(const t of ts){const k=`E9/${test}/${t}`,id=C.model(k),a=await C.auth(k+'/first','signed',id,C.meta(id,2));
    if(test==='head_edit')await C.auth(k+'/old','signed',id,C.meta(id,1));jobs.push(C.job(k+'/first','E9',test+'_first','signed',a,{trial:t}));}await C.batch(firstStage,jobs);}
  const rejectStage='E9/'+test+'/reject';
  if(!done(C,rejectStage)){const jobs=[];for(const t of ts){const k=`E9/${test}/${t}`,id=C.model(k);let a,mod={};
    if(test==='nonce_reuse')a=await C.auth(k+'/reuse','signed',id,C.meta(id,3),{nonce:C.s.auth[k+'/first'].nonce});
    else{a=C.s.auth[k+'/old'];mod.expectedHead=await C.head('signed',id);}
    jobs.push(C.job(k+'/reject','E9',test==='head_edit'?'edited_head_without_new_signature':'consumed_owner_nonce_fresh_proof','signed',a,{expected:false,mod,trial:t}));}await C.batch(rejectStage,jobs);}
 }
 // State transitions are real Sepolia registry transactions. Owner signs them locally.
 if(!done(C,'E9/fund_owner')){
  if(await C.p.getBalance(C.wallets.publisher.address)<ethers.parseEther('0.001')){
   const request={to:C.wallets.publisher.address,value:ethers.parseEther('0.002')};request.gasLimit=await C.gas(request);
   let transferId='E9/fund_owner',retry=0;while(C.s.tx[transferId]?.receipt?.status===0)transferId='E9/fund_owner/retry'+(++retry);
   const [tx]=await C.transactions([{id:transferId,role:'governance',request}]);C.check(transferId,tx.receipt.status,1);
  }C.s.stages.push('E9/fund_owner');C.save();
 }
 for(const t of ts){const k=`E9/transfer/${t}`,id=C.model(k);await C.auth(k+'/old','signed',id,C.meta(id));}
 await actions(C,'E9/transfer/activate',ts.map(t=>({id:`E9/transfer/${t}/activate`,contract:'registry',method:'activateModel',args:[C.model(`E9/transfer/${t}`)],actor:'publisher'})));
 await actions(C,'E9/transfer/request',ts.map(t=>({id:`E9/transfer/${t}/request`,contract:'registry',method:'requestTransfer',args:[C.model(`E9/transfer/${t}`),C.wallets.unprivileged_relay.address],actor:'publisher'})));
 await actions(C,'E9/transfer/accept',ts.map(t=>({id:`E9/transfer/${t}/accept`,contract:'registry',method:'acceptTransfer',args:[C.model(`E9/transfer/${t}`)],actor:'unprivileged_relay'})));
 if(!done(C,'E9/transfer/old_rejected'))await C.batch('E9/transfer/old_rejected',ts.map(t=>C.job(`E9/transfer/${t}/old_rejected`,'E9','former_owner_signature','signed',C.s.auth[`E9/transfer/${t}/old`],{expected:false,trial:t})));
 if(!done(C,'E9/transfer/new_accepted')){const jobs=[];for(const t of ts){const k=`E9/transfer/${t}`,id=C.model(k);jobs.push(C.job(k+'/new','E9','current_owner_after_transfer','signed',await C.auth(k+'/new','signed',id,C.meta(id),{signer:'unprivileged_relay'}),{trial:t}));}await C.batch('E9/transfer/new_accepted',jobs);}
 // Compare the administrative entry points of the original and Signed-ZK tracker.
 const administrative=[];
 for(const g of ['zk','signed'])for(const t of ts){const id=C.model(`E9/admin_exception/${t}`);administrative.push({id:`E9/admin/${g}/${t}/blacklist`,contract:g,track:g,model:id,method:'blacklistModel',args:[id,'experimental administrative test'],delta:g==='zk'?1:0,test:g==='zk'?'original_admin_unsigned_append':'signed_admin_no_provenance_append'});}
 await actions(C,'E9/admin/blacklist',administrative,{group:'E4',measured:true});
 await actions(C,'E9/admin/nonadmin',ts.map(t=>({id:`E9/admin/${t}/nonadmin`,contract:'signed',track:'signed',model:C.model(`E9/admin_exception/${t}`),method:'unblacklistModel',args:[C.model(`E9/admin_exception/${t}`)],actor:'unprivileged_relay',expected:false,test:'nonadmin_management_rejected'})),{group:'E4',measured:true});
 await actions(C,'E9/admin/unblacklist',administrative.map(e=>({...e,id:e.id+'/undo',method:'unblacklistModel',args:[e.model],delta:0,test:'unblacklist_no_provenance_append'})));
 if(!done(C,'E9/legacy_entry')){
  const old=new ethers.Interface(['function addVerifiedRecord(uint256,uint8,string,uint256[2],uint256[2][2],uint256[2],uint256[3])']);const entries=[];
  for(const t of ts){const k=`E9/legacy_entry/${t}`,id=C.model(k),a=await C.auth(k,'signed',id,C.meta(id));entries.push({id:k,contract:'signed',track:'signed',model:id,data:old.encodeFunctionData('addVerifiedRecord',C.args(a).slice(0,7)),expected:false,test:'legacy_unsigned_selector_rejected'});}
  await actions(C,'E9/legacy_entry',entries,{measured:true});
 }
 for(const test of ['blacklist','revoked'])for(const t of ts){const k=`E9/${test}/${t}`,id=C.model(k);await C.auth(k,'signed',id,C.meta(id));}
 await actions(C,'E9/owner_blacklist',[{id:'E9/owner_blacklist',contract:'access',method:'addBlacklist',args:[C.wallets.publisher.address]}]);
 if(!done(C,'E9/blacklisted_owner_rejected'))await C.batch('E9/blacklisted_owner_rejected',ts.map(t=>C.job(`E9/blacklist/${t}/reject`,'E9','blacklisted_owner_rejected','signed',C.s.auth[`E9/blacklist/${t}`],{expected:false,trial:t})));
 await actions(C,'E9/owner_unblacklist',[{id:'E9/owner_unblacklist',contract:'access',method:'removeBlacklist',args:[C.wallets.publisher.address]}]);
 await actions(C,'E9/model_revoke',ts.map(t=>({id:`E9/revoked/${t}/revoke`,contract:'registry',method:'revokeModel',args:[C.model(`E9/revoked/${t}`)]})));
 if(!done(C,'E9/revoked_model_rejected'))await C.batch('E9/revoked_model_rejected',ts.map(t=>C.job(`E9/revoked/${t}/reject`,'E9','revoked_registry_model_rejected','signed',C.s.auth[`E9/revoked/${t}`],{expected:false,trial:t})));
 const {sdkSepolia}=await import('./sdk_sepolia.mjs');await sdkSepolia(C);
}
