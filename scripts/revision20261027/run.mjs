import fs from 'node:fs';
import path from 'node:path';
import { Campaign } from './engine.mjs';
const index=process.argv.indexOf('--run-id');
const campaign=new Campaign(index>=0?process.argv[index+1]:undefined);
console.log('RUN_ID='+campaign.runId);
try {
 await campaign.init();await campaign.deploy();
 if(!process.argv.includes('--setup-only')){
  const { experiments }=await import('./experiments.mjs');await experiments(campaign);await campaign.finish();
 }
 campaign.save();process.exit(0);
}catch(e){campaign.write('last_error.json',{at:new Date().toISOString(),message:e.message,stack:e.stack});campaign.save();console.error('STOPPED:',e.message,'Resume with --run-id',campaign.runId);process.exit(1);}
