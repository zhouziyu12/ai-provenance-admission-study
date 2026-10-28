import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {root} from './engine.mjs';
const base=path.join(root,'docs/bcra_revision/sepolia_20261027'),id=process.argv[2]||fs.readFileSync(path.join(base,'LATEST.txt'),'utf8').trim(),out=path.join(base,'runs',id);
const uploads=JSON.parse(fs.readFileSync(path.join(out,'sdk_uploads.json'))),results=[];
const entries=Object.entries(uploads);let next=0;
await Promise.all(Array.from({length:3},async()=>{
 while(next<entries.length){const [key,u]=entries[next++];const row={id:key,cid:u.artifactCid,expectedSha256:u.modelHash,retrieved:false,attempts:[]};
  for(const gateway of ['https://gateway.pinata.cloud/ipfs/','https://ipfs.io/ipfs/']){
   try{const response=await fetch(gateway+u.artifactCid,{signal:AbortSignal.timeout(15000)});row.attempts.push({gateway,status:response.status});if(!response.ok)continue;
    const bytes=Buffer.from(await response.arrayBuffer()),actual=crypto.createHash('sha256').update(bytes).digest('hex');
    row.actualSha256=actual;row.bytes=bytes.length;row.retrieved=true;row.hashMatches=actual===u.modelHash;if(!row.hashMatches)throw Error('IPFS artifact hash mismatch');break;
   }catch(e){row.attempts.push({gateway,error:e.name});}
  }results.push(row);
 }
}));
results.sort((a,b)=>a.id.localeCompare(b.id));
const result={observedAt:new Date().toISOString(),uploadedArtifacts:entries.length,retrieved:results.filter(r=>r.retrieved).length,allRetrievedHashesMatch:results.filter(r=>r.retrieved).every(r=>r.hashMatches),results};
fs.writeFileSync(path.join(out,'ipfs_verification.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({uploaded:result.uploadedArtifacts,retrieved:result.retrieved,allRetrievedHashesMatch:result.allRetrievedHashesMatch}));
if(!result.allRetrievedHashesMatch)process.exit(1);
