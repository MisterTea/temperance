import { describe, expect, it } from 'vitest';
import cases from '../../specs/policy-cases.json';
import { accessReason, domainReason, localTime, profileSchema, type Reward, type Usage } from '../src/lib/policy';
describe('shared service/gateway policy contract',()=>{
 for(const entry of cases)it(entry.name,()=>{
  const input=entry.profile as typeof entry.profile&{used?:number;bucket_usage?:Record<string,number>;rewards?:Reward[]};
  const p={...profileSchema.parse(input),id:1},at=new Date(entry.at).getTime()/1000,day=localTime(at,entry.zone).day;
  const usage:Usage={[day]:{'1':{total:Array.from({length:input.used??0},(_,n)=>n),...Object.fromEntries(Object.entries(input.bucket_usage??{}).map(([bucket,n])=>[bucket,Array.from({length:n},(_,n)=>n)]))}}};
  const rewards=input.rewards??[];
  const reason=entry.kind==='domain'?domainReason(p,entry.host!,at,entry.zone,usage,rewards,entry.household_paused):accessReason(p,at,entry.zone,usage,rewards,entry.household_paused);
  expect(reason).toBe(entry.expected);
 });
});
