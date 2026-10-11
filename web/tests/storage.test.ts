import { describe, expect, it } from 'vitest';
import { SQLRepository, mutate } from '../src/lib/database';
import { saveProfile, deleteProfile } from '../src/lib/service';
const url=process.env.TEMPERANCE_TEST_DATABASE_URL;
describe.skipIf(!url)('persistent HTTP SQL storage',()=>{
 it('persists across independent repository instances and serializes concurrent changes',async()=>{const a=new SQLRepository(url!),b=new SQLRepository(url!);const before=(await a.read()).state.profiles.length;const saved=await Promise.all([mutate(a,s=>saveProfile(s,{name:'Storage A'}).profiles.at(-1)!.id),mutate(b,s=>saveProfile(s,{name:'Storage B'}).profiles.at(-1)!.id)]);const after=(await new SQLRepository(url!).read()).state;expect(after.profiles).toHaveLength(before+2);expect(new Set(after.profiles.map(p=>p.id)).size).toBe(after.profiles.length);for(const id of saved)await mutate(a,s=>deleteProfile(s,id));});
});
