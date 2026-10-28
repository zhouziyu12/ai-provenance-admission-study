import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ethers } from 'ethers';
const pointer=JSON.parse(fs.readFileSync(path.join(os.homedir(),'.ai-provenance/bcra-final-campaign/latest.json')));
const pub=JSON.parse(fs.readFileSync(path.join(pointer.keystoreDirectory,'public_addresses.json')));
const endpoints=['https://ethereum-sepolia-rpc.publicnode.com','https://ethereum-sepolia.publicnode.com','https://sepolia.drpc.org'];
for(const url of endpoints) {
  const request=new ethers.FetchRequest(url);request.timeout=15000;
  const p=new ethers.JsonRpcProvider(request,undefined,{batchMaxCount:1});
  try {
    const network=await p.getNetwork();if(network.chainId!==11155111n)throw Error('Wrong chain');
    const block=await p.getBlock('latest'),fee=await p.getFeeData();
    const accounts=[];
    for(const [role,address] of Object.entries(pub.addresses)) accounts.push({role,address,balanceETH:ethers.formatEther(await p.getBalance(address)),nonce:await p.getTransactionCount(address)});
    console.log(JSON.stringify({rpc:url,chainId:String(network.chainId),blockNumber:block.number,blockTimestamp:block.timestamp,
      baseFeeGwei:ethers.formatUnits(block.baseFeePerGas||0n,'gwei'),maxFeeGwei:ethers.formatUnits(fee.maxFeePerGas||fee.gasPrice,'gwei'),
      maxPriorityFeeGwei:ethers.formatUnits(fee.maxPriorityFeePerGas||0n,'gwei'),accounts},null,2));
    break;
  }catch(e){console.log(JSON.stringify({rpc:url,error:e.code||'RPC_ERROR'}));}finally{p.destroy();}
}
