import { z } from 'zod';
import { hash, randomToken, validateKey } from './auth';
import { type Device, type State } from './model';
import { accessReason, activeWindows, CATALOG, classify, dailyLimit, localTime, normalizeDomain, profileSchema, used, type Profile } from './policy';

const now=()=>Math.floor(Date.now()/1000);
const publicDevice=(d:Device)=>({id:d.id,ip:d.ip,name:d.name,profile_id:d.profile_id,paused:d.paused,managed:d.managed,last_seen:d.last_seen,location:d.location});
export function prune(state:State,at=now()){
  const cutoff=localTime(at-state.retention_days*86400,timezone()).day;
  state.history=state.history.filter(h=>localTime(h.at,timezone()).day>=cutoff).slice(-20000);
  for(const day of Object.keys(state.usage))if(day<cutoff)delete state.usage[day];
  state.rewards=state.rewards.filter(r=>r.day>=localTime(at,timezone()).day);
  state.codes=state.codes.filter(c=>c.expires>at);
  state.events=state.events.slice(-500);state.requests=state.requests.slice(-500);
}
export function timezone(){const zone=process.env.TEMPERANCE_TIMEZONE??'UTC';new Intl.DateTimeFormat('en',{timeZone:zone});return zone;}
export function effectiveProfile(state:State,profile:Profile,at=now()){
  const day=localTime(at,timezone()).day;
  return {...profile,used:used(state.usage,day,profile.id),usage_minutes:state.usage[day]?.[profile.id]??{},bucket_usage:Object.fromEntries(Object.keys(state.usage[day]?.[profile.id]??{}).map(bucket=>[bucket,used(state.usage,day,profile.id,bucket)])),rewards:state.rewards.filter(r=>r.profile_id===profile.id&&r.day===day),access_reason:accessReason(profile,at,timezone(),state.usage,state.rewards,state.paused),effective_limit:dailyLimit(profile,at,timezone(),state.rewards)};
}
export function snapshot(state:State,at=now()){
  const day=localTime(at,timezone()).day;
  const profiles=state.profiles.map(p=>effectiveProfile(state,p,at));
  return {schema:2,version:state.version,day,timezone:timezone(),vpn:true,profiles,devices:state.devices.filter(d=>!d.revoked).map(publicDevice),rewards:state.rewards.filter(r=>r.day===day),requests:state.requests,events:state.events,categories:Object.fromEntries(Object.entries(CATALOG).map(([k,v])=>[k,v.domains])),catalog:CATALOG,extra_domains:state.extra_domains,paused:state.paused,home_profile_id:state.home_profile_id,retention_days:state.retention_days,offline_grace_seconds:state.offline_grace_seconds,total:profiles.reduce((sum,p)=>sum+p.used,0),blocked:profiles.filter(p=>p.access_reason!=='allowed').length,recent:state.history.slice(-100).reverse()};
}
function profile(state:State,id:number){const found=state.profiles.find(p=>p.id===id);if(!found)throw new Error('Profile does not exist');return found;}
function event(state:State,kind:string,message:string){state.events.push({id:crypto.randomUUID(),at:now(),kind,message,read:false});}
function changed(state:State,kind:string,message:string){state.version++;event(state,kind,message);prune(state);}
export function saveProfile(state:State,input:unknown){
  const data=profileSchema.parse(input);const existing=data.id?profile(state,data.id):null;
  const saved={...data,id:existing?.id??state.nextProfileId++};
  if(existing)state.profiles=state.profiles.map(p=>p.id===saved.id?saved:p);else state.profiles.push(saved);
  changed(state,'policy',`Profile ${saved.name} ${existing?'updated':'created'}`);return snapshot(state);
}
export function deleteProfile(state:State,id:number){profile(state,id);if(state.devices.some(d=>!d.revoked&&d.profile_id===id))throw new Error('Reassign or revoke this profile’s devices first');state.profiles=state.profiles.filter(p=>p.id!==id);state.rewards=state.rewards.filter(r=>r.profile_id!==id);if(state.home_profile_id===id)delete state.home_profile_id;changed(state,'policy','Profile removed');return snapshot(state);}
export async function issueCode(state:State,id:number){profile(state,id);const code=randomToken();state.codes.push({hash:await hash(code),profile_id:id,expires:now()+600});prune(state);return {code,expires_in:600};}
const deviceInput=z.object({ip:z.string().regex(/^10\.77\.0\.(?:\d{1,3})$/),name:z.string().trim().min(1).max(80),profile_id:z.number().int().positive(),paused:z.boolean().optional(),managed:z.boolean().optional()});
export function saveDevice(state:State,input:unknown){const data=deviceInput.parse(input);profile(state,data.profile_id);const device=state.devices.find(d=>d.ip===data.ip&&!d.revoked);if(!device)throw new Error('Enroll a VPN device first');Object.assign(device,data);changed(state,'device',`Device ${device.name} updated`);return snapshot(state);}
export function revokeDevice(state:State,ip:string){const device=state.devices.find(d=>d.ip===ip&&!d.revoked);if(!device)throw new Error('Device does not exist');device.revoked=true;changed(state,'device',`Device ${device.name} revoked`);return snapshot(state);}
export function provisioning(device:Device){
  const endpoint=process.env.TEMPERANCE_VPN_ENDPOINT??'';
  if(!/^(?:\d{1,3}\.){3}\d{1,3}:\d{1,5}$/.test(endpoint)||endpoint.split(':')[0].split('.').some(n=>Number(n)>255)||Number(endpoint.split(':')[1])<1||Number(endpoint.split(':')[1])>65535)throw new Error('Configure a numeric IPv4 VPN endpoint');
  const serverKey=validateKey(process.env.TEMPERANCE_VPN_PUBLIC_KEY);
  const octet=Number(device.ip.split('.').at(-1));
  return {address:device.ip+'/32',address_v6:`fd77::${octet.toString(16)}/128`,dns:'10.77.0.1',endpoint,public_key:serverKey,allowed_ips:'0.0.0.0/0, ::/0',keepalive:25};
}
export function clientState(state:State,device:Device,at=now()){
  const p=profile(state,device.profile_id),policy=effectiveProfile(state,p,at);
  const reason=!device.managed?'unmanaged':device.paused?'device pause':policy.access_reason;
  return {device_id:device.id,version:state.version,policy:{...policy,timezone:timezone()},tunnel:provisioning(device),status:{reason,remaining_minutes:policy.effective_limit===0?null:Math.max(0,policy.effective_limit-policy.used),active_windows:activeWindows(p,at,timezone(),state.rewards),observed_at:at},requests:state.requests.filter(r=>r.device_id===device.id)};
}
export async function authenticatedDevice(state:State,token:string){const tokenHash=await hash(token);return state.devices.find(d=>!d.revoked&&d.token_hash===tokenHash);}
export async function enroll(state:State,input:unknown){
  const data=z.object({code:z.string().max(100),name:z.string().trim().min(1).max(80),public_key:z.string()}).parse(input),publicKey=validateKey(data.public_key);
  const codeHash=await hash(data.code),code=state.codes.find(c=>c.hash===codeHash&&c.expires>now());if(!code)throw new Error('Enrollment code expired or already used');
  if(state.devices.some(d=>d.public_key===publicKey))throw new Error('Key already enrolled; use a fresh key');
  const ip=Array.from({length:253},(_,n)=>`10.77.0.${n+2}`).find(ip=>!state.devices.some(d=>d.ip===ip));if(!ip)throw new Error('Gateway address pool exhausted');
  const token=randomToken(),device:Device={id:crypto.randomUUID(),ip,name:data.name,profile_id:code.profile_id,public_key:publicKey,token_hash:await hash(token),revoked:false,paused:false,managed:true,last_seen:now()};
  provisioning(device);state.devices.push(device);state.codes=state.codes.filter(c=>c!==code);changed(state,'new_device',`${device.name} enrolled`);
  return {token,...clientState(state,device)};
}
export function gatewayState(state:State,at=now()){
  return {...snapshot(state,at),issued_at:at,policy_schema:2,offline_grace_seconds:state.offline_grace_seconds,peers:state.devices.filter(d=>!d.revoked).map(d=>({id:d.id,ip:d.ip,public_key:d.public_key,profile_id:d.profile_id,paused:d.paused,managed:d.managed}))};
}
const activityInput=z.object({active_devices:z.array(z.string()).max(253).default([]),activity:z.array(z.object({device_id:z.string(),minute:z.number().int().optional(),buckets:z.array(z.string().max(300)).max(20).default(['total'])})).max(1000).default([]),history:z.array(z.object({id:z.string().max(100),device_id:z.string(),at:z.number(),domain:z.string().max(253),blocked:z.boolean(),reason:z.string().max(100),category:z.string().max(40).default('other')})).max(500).default([])});
export function account(state:State,input:unknown){
  const data=activityInput.parse(input),at=now();
  const entries=[...data.active_devices.map(device_id=>({device_id,minute:Math.floor(at/60),buckets:['total']})),...data.activity];
  for(const entry of entries){
    const device=state.devices.find(d=>d.id===entry.device_id&&!d.revoked);if(!device)continue;
    const p=profile(state,device.profile_id);if(!device.managed||!p.managed||p.filter_level==='none')continue;
    const minute=entry.minute??Math.floor(at/60);if(minute>Math.floor(at/60)+1||minute<Math.floor(at/60)-7*1440)throw new Error('Activity timestamp outside recovery window');
    const day=localTime(minute*60,timezone()).day;
    const daily=state.usage[day]??={};const usage=daily[p.id]??={};
    for(const bucket of entry.buckets){if(bucket!=='total'&&!/^(category|site):[a-z0-9.-]+$/.test(bucket))throw new Error('Invalid usage bucket');const list=usage[bucket]??=[];if(!list.includes(minute))list.push(minute);}
    device.last_seen=at;
  }
  const known=new Set(state.history.map(h=>h.id));
  for(const h of data.history){
    const device=state.devices.find(d=>d.id===h.device_id&&!d.revoked);if(!device||known.has(h.id))continue;
    const p=profile(state,device.profile_id);if(!device.managed||!p.managed||p.filter_level==='none')continue;
    if(h.at>at+60||h.at<at-state.retention_days*86400)continue;
    state.history.push({...h,profile_id:p.id,domain:h.domain?new URL('https://'+h.domain).hostname:''});known.add(h.id);
  }
  prune(state);return {ok:true};
}
const rewardSchema=z.object({id:z.string().optional(),profile_id:z.number().int().positive(),kind:z.enum(['extra_time','late_bedtime','skip_window']),minutes:z.number().int().min(1).max(1440).optional(),bedtime:z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional(),window_id:z.string().optional(),scope:z.string().regex(/^(total|category:[a-z]+|site:[a-z0-9.-]+)$/).default('total')});
export function reward(state:State,input:unknown){const data=rewardSchema.parse(input);const p=profile(state,data.profile_id);if(data.kind==='extra_time'&&!data.minutes)throw new Error('Set reward minutes');if(data.kind==='late_bedtime'&&!data.bedtime)throw new Error('Set the new bedtime');if(data.kind==='skip_window'&&!p.schedules.some(s=>s.id===data.window_id))throw new Error('Choose a schedule to skip');const value={...data,id:data.id??crypto.randomUUID(),day:localTime(now(),timezone()).day};state.rewards=state.rewards.filter(r=>r.id!==value.id);state.rewards.push(value);changed(state,'reward',`Reward sent to ${p.name}`);return snapshot(state);}
export function cancelReward(state:State,id:string){state.rewards=state.rewards.filter(r=>r.id!==id);changed(state,'reward','Reward cancelled');return snapshot(state);}
export function requestTime(state:State,device:Device,input:unknown){const data=z.object({minutes:z.number().int().min(1).max(180),message:z.string().trim().max(300).default('')}).parse(input);if(state.requests.some(r=>r.device_id===device.id&&r.status==='pending'))throw new Error('You already have a pending request');const request={...data,id:crypto.randomUUID(),at:now(),device_id:device.id,profile_id:device.profile_id,status:'pending' as const};state.requests.push(request);event(state,'time_request',`${device.name} requested ${data.minutes} extra minutes`);return request;}
export function answerRequest(state:State,input:unknown){const data=z.object({id:z.string(),approve:z.boolean()}).parse(input);const request=state.requests.find(r=>r.id===data.id&&r.status==='pending');if(!request)throw new Error('Pending request not found');request.status=data.approve?'approved':'denied';if(data.approve)reward(state,{profile_id:request.profile_id,kind:'extra_time',minutes:request.minutes});changed(state,'time_request',`Time request ${request.status}`);return snapshot(state);}
export function settings(state:State,input:unknown){const data=z.object({paused:z.boolean().optional(),home_profile_id:z.number().int().positive().nullable().optional(),retention_days:z.number().int().min(1).max(90).optional(),offline_grace_seconds:z.number().int().min(0).max(7*86400).optional()}).parse(input);if(data.home_profile_id)profile(state,data.home_profile_id);Object.assign(state,data);if(data.home_profile_id===null)delete state.home_profile_id;changed(state,'settings','Household settings updated');return snapshot(state);}
export function usageSummary(state:State,start:string,end:string){return Object.entries(state.usage).filter(([day])=>day>=start&&day<=end).map(([day,profiles])=>({day,profiles:Object.fromEntries(Object.entries(profiles).map(([id,buckets])=>[id,Object.fromEntries(Object.entries(buckets).map(([bucket,list])=>[bucket,list.length]))]))}));}
export function addFeed(state:State,input:unknown){const data=z.object({category:z.enum(Object.keys(CATALOG) as ['social',...string[]]),domains:z.array(z.string()).max(20000)}).parse(input);state.extra_domains[data.category]=[...new Set(data.domains.map(normalizeDomain))];changed(state,'feed',`Updated ${data.category} category feed`);return snapshot(state);}
