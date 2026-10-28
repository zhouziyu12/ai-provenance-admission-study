import path from 'node:path';
import fs from 'node:fs';
import dotenv from 'dotenv';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import {performance} from 'node:perf_hooks';
import express from 'express';
import {ethers} from 'ethers';
import {createSignedZKRouter} from '../../server/signed_zk.js';
import {FIELD,root} from './engine.mjs';
export async function sdkSepolia(C){
 const stage='E9/sdk_http_sepolia';if(C.s.stages.includes(stage))return;
 const cfg=dotenv.parse(fs.readFileSync(path.join(root,'.env')));
 if(!cfg.PINATA_API_KEY||!cfg.PINATA_SECRET)throw Error('Pinata credentials required for the complete SDK upload experiment');
 await C.models(['SDK/series_A','SDK/series_B','SDK/series_C']);
 if(!C.s.stages.includes('E9/sdk_second_owner')){
  const id=C.model('SDK/series_C');
  await C.setupTx('SDK/C/activate',C.c.registry,'activateModel',[id],'publisher');
  await C.setupTx('SDK/C/request',C.c.registry,'requestTransfer',[id,C.wallets.unprivileged_relay.address],'publisher');
  await C.setupTx('SDK/C/accept',C.c.registry,'acceptTransfer',[id],'unprivileged_relay');
  C.s.stages.push('E9/sdk_second_owner');C.save();
 }
 const tokens=new Map([['publisher',crypto.randomBytes(24).toString('hex')],['unprivileged_relay',crypto.randomBytes(24).toString('hex')]]);
 const app=express();app.use(express.json({limit:'10mb'}));let currentId=null;
 const relay=new ethers.Wallet(C.wallets.groth16_relay.privateKey,C.p);
 relay.sendTransaction=async request=>{
  if(!currentId)throw Error('SDK observation context missing');request={...request,to:await request.to};request.gasLimit=await C.gas(request,'groth16_relay');
  const item=await C.broadcast(currentId,'groth16_relay',request,{group:'E9',test:'python_sdk_http_sepolia'});
  for(let n=0;n<10;n++){const tx=await C.p.getTransaction(item.hash);if(tx)return tx;await new Promise(r=>setTimeout(r,200));}
  throw Error('Broadcast transaction unavailable from RPC');
 };
 const captured=new Map();app.use((req,res,next)=>{if(req.method==='POST')captured.set(currentId,structuredClone(req.body));next();});
 const failure=(message,statusCode=400)=>{throw Object.assign(new Error(message),{statusCode});};
 app.use('/api/sdk',createSignedZKRouter({chains:{sepolia:{provider:C.p,wallet:relay,addr:{contracts:{SignedZKProvenanceTracker:C.c.signed.target,ModelRegistry:C.c.registry.target}}}},
  requireAuth:(req,res,next)=>{const role=[...tokens].find(([,token])=>req.headers.authorization==='Bearer '+token)?.[0];if(!role)return res.status(401).json({success:false});req.auth={walletAddress:C.wallets[role].address.toLowerCase()};next();},
  handle:fn=>(req,res)=>Promise.resolve(fn(req,res)).catch(e=>res.status(e.statusCode||502).json({success:false,error:e.shortMessage||e.message})),
  ok:(res,value)=>res.json({success:true,...value}),requireString:v=>{if(typeof v!=='string'||!v)failure('Invalid string');return v;},
  requirePositiveInt:v=>{if(!Number.isSafeInteger(Number(v))||Number(v)<=0)failure('Invalid model');return Number(v);},
  parseCanonicalMetadataOrThrow:v=>({canonicalMetadata:v,parsed:JSON.parse(v)}),
  validateCanonicalMetadataShape:(v,scope)=>{if(v.modelName!==scope.modelName||v.chain!==scope.chain)failure('Metadata scope mismatch');},
  normalizeZKProof:v=>({...v,publicSignals:v.publicSignals.map(BigInt)}),computeStatementHash:v=>BigInt(ethers.keccak256(ethers.toUtf8Bytes(v)))%FIELD,
  getContracts:()=>({mr:C.c.registry}),getModelOwnerOrNull:async(mr,id)=>(await mr.getModelOwner(id)).toLowerCase(),requireWriteChain:()=>({wallet:relay}),ACTION_MAP:{UPDATED:2}}));
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
 try{
  const baseUrl='http://127.0.0.1:'+server.address().port;
  C.write('sdk_protocol.json',{chain:'sepolia',chainId:11155111,owners:2,series:3,versionsPerSeries:3,
   path:'Python SHA-256 -> actual Python SDK Pinata upload -> real Groth16 proof -> Python SDK owner signing -> actual signed_zk HTTP router -> Sepolia transaction -> contract state readback',
   identity:'Isolated bearer-token fixture mapping to actual registered owners; production login issuance is not evaluated',
   artifactStorage:'Nine actual synthetic byte artifacts uploaded through the Python SDK to Pinata/IPFS; service CID and local SHA-256 recorded for each'});
  const observations=C.s.sdkObservations||[];
  for(let version=1;version<=3;version++)for(const series of ['series_A','series_B','series_C']){
   const key=`SDK/${series}/v${version}`;if(observations.some(r=>r.id===key))continue;
   const id=C.model('SDK/'+series),ownerRole=series==='series_C'?'unprivileged_relay':'publisher',owner=C.wallets[ownerRole];
   const fixture=C.fixture(series+'-v'+version);C.s.sdkUploads??={};
   if(!C.s.sdkUploads[key]){
    const uploaded=await new Promise((resolve,reject)=>{
     const child=spawn('python',[path.join(root,'scripts/revision20261027/sdk_bridge.py')],{windowsHide:true});let stdout='',stderr='';
     child.stdout.on('data',v=>stdout+=v);child.stderr.on('data',v=>stderr+=v);child.on('error',reject);child.on('close',code=>code===0?resolve(JSON.parse(stdout.trim().split(/\r?\n/).at(-1))):reject(Error('SDK IPFS upload failed ('+code+'): '+stderr.slice(-1000))));
     child.stdin.end(JSON.stringify({mode:'upload',pinataApiKey:cfg.PINATA_API_KEY,pinataSecret:cfg.PINATA_SECRET,modelPath:path.join(C.out,'fixtures',series+'-v'+version+'.bin')}));
    });C.check(key+':uploaded-file-hash',uploaded.modelHash,fixture.modelHash);C.s.sdkUploads[key]=uploaded;C.write('sdk_uploads.json',C.s.sdkUploads);C.save();
   }
   const upload=C.s.sdkUploads[key],hash_ms=upload.hash_ms;fixture.artifactCid=upload.artifactCid;
   const modelName='SepoliaRevision-SDK/'+series,m=C.meta(id,version,{...fixture,modelName,chain:'sepolia',sender:owner.address,
    commit:'Signed-ZK Sepolia full-path experiment',versionTag:String(version),submittedAt:new Date().toISOString(),trainingMetadata:{framework:'synthetic',stage:'evaluation',version:String(version)}});
   const a=await C.auth(key+'/proof','signed',id,m,{signer:ownerRole}),p=a.proofArgs;
   const proof={pA:p[0],pB:p[1],pC:p[2],publicSignals:a.proof.publicSignals},before=await C.state('signed',id);
   currentId=key;
   const bridge=await new Promise((resolve,reject)=>{
    const child=spawn('python',[path.join(root,'scripts/revision20261027/sdk_bridge.py')],{windowsHide:true});let stdout='',stderr='';
    child.stdout.on('data',v=>stdout+=v);child.stderr.on('data',v=>stderr+=v);child.on('error',reject);
    child.on('close',code=>code===0?resolve(JSON.parse(stdout.trim().split(/\r?\n/).at(-1))):reject(Error('Python SDK bridge failed ('+code+'): '+stderr.slice(-1000))));
    child.stdin.end(JSON.stringify({privateKey:owner.privateKey,baseUrl,accessToken:tokens.get(ownerRole),model_id:id,model_name:modelName,chain:'sepolia',
     canonical_metadata:m,zk_proof:proof,verifying_contract:C.c.signed.target,chain_id:11155111,nonce:a.nonce,deadline:a.deadline}));
   });
   const tx=C.s.tx[key];await C.settle([tx]);const after=await C.state('signed',id),history=await C.c.signed.getModelHistory(id),rec=history.at(-1),body=captured.get(key);
   C.check(key+':status',tx.receipt.status,1);C.check(key+':signature',bridge.relayer.signatureVerified);C.check(key+':proof',bridge.relayer.proofVerified);
   C.check(key+':length',after.length,before.length+1);C.check(key+':operator',rec.operator,owner.address);C.check(key+':metadata',rec.ipfsMetadata,m);
   C.check(key+':head',rec.previousHash,before.head);C.check(key+':chain',await C.c.signed.verifyChain(id));
   a.signature=body.signature;a.expectedHead=body.expectedHead;a.nonce=body.nonce;a.deadline=Number(body.deadline);a.value=bridge.typedData.message;
   const r={id:key,stage,group:'E9',test:'python_sdk_http_sepolia',gate:'signed',variant:'signed',kind:'sdk_integration',model:id,auth_id:a.id,series,version,owner:owner.address,
    expectedAccepted:true,accepted:true,metadata_bytes:Buffer.byteLength(m),hash_ms,proof_ms:a.proof_ms,sign_ms:bridge.python_sign_ms,auth_ms:a.proof_ms+bridge.python_sign_ms,
    upload_ms:upload.upload_ms,artifactCid:upload.artifactCid,sdk_http_chain_ms:bridge.sdk_http_chain_ms,pipeline_ms:hash_ms+upload.upload_ms+a.proof_ms+bridge.sdk_http_chain_ms,inclusion_ms:tx.inclusion_ms,broadcast_ms:tx.broadcast_ms,gas:Number(tx.receipt.gasUsed),
    batch_before:before,batch_after:after,record:Object.fromEntries(['recordId','modelId','eventType','ipfsMetadata','timestamp','operator','previousHash','recordHash'].map(f=>[f,typeof rec[f]==='bigint'?String(rec[f]):rec[f]])),
    transaction:{hash:tx.hash,from:tx.from,to:tx.to,data:tx.data,nonce:tx.nonce,broadcastAt:tx.broadcastAt},receipt:tx.receipt};
   observations.push(r);C.s.sdkObservations=observations;C.s.rows.push(r);C.write('sdk_observations.json',observations);C.save();C.log(key+' confirmed on Sepolia');
  }
  C.s.stages.push(stage);C.save();
 }finally{await new Promise(r=>server.close(r));}
}
