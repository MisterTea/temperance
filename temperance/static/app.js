let state;
const $ = (selector) => document.querySelector(selector);
const escape = (value) => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const profileName = (id) => state.profiles.find(p => p.id === id)?.name ?? 'Unmanaged';
const deviceName = (ip) => state.devices.find(d => d.ip === ip)?.name ?? ip;
async function api(path, data) {
  const response = await fetch(path, data === undefined ? {} : {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Request failed');
  return result;
}
function render() {
  $('#enroll-section').hidden = !state.vpn;
  if(state.vpn){
    $('.brand small').textContent='FAMILY VPN CONTROLS';
    $('#add-device').hidden=true;
    $('#devices .section-heading p').textContent='VPN devices are assigned automatically. Remove a device to revoke its access.';
    $('#profile-form').elements.limit.parentElement.querySelector('small').textContent='0 means unlimited. This budget counts observed allowed network minutes.';
    $('#activity h2').textContent='Activity by profile';
    $('#activity .section-heading p').textContent="Today's observed allowed network minutes · retained for 30 days";
    $('#activity thead').innerHTML='<tr><th>Profile</th><th>Observed minutes</th><th>Daily budget</th><th>Access</th></tr>';
    const select=$('#enroll-profile'); const selected=select.value;
    select.innerHTML=state.profiles.map(p=>`<option value="${p.id}">${escape(p.name)}</option>`).join('');
    if([...select.options].some(o=>o.value===selected))select.value=selected;
    $('#enroll-service').textContent='Policy service: '+location.origin;
    const stats=document.querySelectorAll('.stats article');
    stats[0].querySelector('span').textContent='Network activity minutes';
    stats[0].querySelector('small').textContent='Observed allowed traffic across profiles';
    stats[1].querySelector('span').textContent='Paused profiles';
    stats[1].querySelector('small').textContent='Access controlled at the VPN gateway';
    $('.notice strong').textContent='Network activity is an estimate, not screen time.';
    $('.notice p').textContent='A minute counts when the gateway observes allowed traffic. Background traffic counts too. Budgets, pauses, and bedtime block forwarded traffic at the gateway.';
  }
  $('#total').textContent = state.total.toLocaleString();
  $('#blocked').textContent = state.blocked.toLocaleString();
  $('#device-count').textContent = state.devices.filter(d => d.profile_id !== null).length;
  $('#date').textContent = new Date(state.day + 'T12:00:00').toLocaleDateString(undefined,{weekday:'long',month:'long',day:'numeric'});
  $('#zone').textContent = `Gateway timezone: ${state.timezone}`;
  $('#profiles').innerHTML = state.profiles.length ? state.profiles.map(p => `<article class="profile"><div class="profile-head"><div class="avatar">${escape(p.name.slice(0,1).toUpperCase())}</div><div><h3>${escape(p.name)}</h3><small>${state.devices.filter(d=>d.profile_id===p.id).length} devices</small></div><span class="badge ${p.paused?'paused':''}">${p.paused?'Paused':'Rules active'}</span></div><div class="usage"><strong>${p.used}</strong><span>min observed ${p.limit?`/ ${p.limit} min budget`:'· unlimited'}</span></div><progress aria-label="Daily activity budget" max="${p.limit||1440}" value="${p.used}"></progress><div class="profile-info">${p.categories.length?escape(p.categories.join(', '))+' filtered':'No category filters'}<br>${p.bedtime.start?`Bedtime ${escape(p.bedtime.start)} – ${escape(p.bedtime.end)}`:'No bedtime schedule'} · ${p.deny.length} custom blocks</div><div class="profile-actions"><button class="secondary" data-pause="${p.id}">${p.paused?'Resume access':'Pause access'}</button><button class="secondary" data-edit="${p.id}">Edit rules</button></div></article>`).join('') : '<div class="empty">Welcome home.<p>Add your first profile, then enroll or assign a device to start managing its activity.</p></div>';
  $('#device-list').innerHTML = state.devices.length ? state.devices.map(d=>`<tr><td>${escape(d.name)}</td><td class="domain">${escape(d.ip)}</td><td>${escape(profileName(d.profile_id))}</td><td><button class="secondary" data-device="${escape(d.ip)}">Edit</button> <button class="secondary" data-delete="${escape(d.ip)}">Remove</button></td></tr>`).join('') : '<tr><td colspan="4" class="empty">No devices assigned yet. Add a reserved IPv4 address.</td></tr>';
  $('#activity-list').innerHTML = state.recent.length ? state.recent.map(q=>`<tr><td>${escape(new Date(q.at*1000).toLocaleTimeString(undefined,{timeZone:state.timezone,hour:'2-digit',minute:'2-digit'}))}</td><td>${escape(deviceName(q.ip))}</td><td class="domain">${escape(q.domain||'(root)')}</td><td><span class="badge ${q.blocked?'blocked':'allowed'}">${escape(q.blocked?q.reason:'Allowed')}</span></td></tr>`).join('') : (state.vpn?'<tr><td colspan="4" class="empty">The policy service stores activity minutes. Domain requests remain on the gateway.</td></tr>':'<tr><td colspan="4" class="empty">No DNS activity today. Point a test device at the gateway to begin.</td></tr>');
  if(state.vpn){
    $('#activity-list').innerHTML=state.profiles.length?state.profiles.map(p=>`<tr><td>${escape(p.name)}</td><td>${p.used}</td><td>${p.limit||'Unlimited'}</td><td>${p.paused?'Paused':'Rules active'}</td></tr>`).join(''):'<tr><td colspan="4" class="empty">No profiles yet.</td></tr>';
    if(!state.devices.length)$('#device-list').innerHTML='<tr><td colspan="4" class="empty">Enroll a device using a code above.</td></tr>';
  }
}
function openProfile(id) {
  const form = $('#profile-form'); form.reset(); form.querySelector('.form-error').textContent='';
  const p = state.profiles.find(p=>p.id===id);
  $('#profile-title').textContent = p?'Edit profile':'Add profile';
  for (const key of ['id','name','limit']) form.elements[key].value=p?.[key]??(key==='limit'?0:'');
  for (const key of ['start','end']) form.elements[key].value=p?.bedtime[key]??'';
  for (const key of ['allow','deny']) form.elements[key].value=p?.[key].join('\n')??'';
  for (const key of Object.keys(state.categories)) form.elements[key].checked=p?.categories.includes(key)??false;
  $('#profile-dialog').showModal();
}
function openDevice(ip) {
  const form=$('#device-form'); form.reset(); form.querySelector('.form-error').textContent='';
  const d=state.devices.find(d=>d.ip===ip);
  $('#device-profile').innerHTML='<option value="">Unmanaged</option>'+state.profiles.map(p=>`<option value="${p.id}">${escape(p.name)}</option>`).join('');
  form.elements.name.value=d?.name??''; form.elements.ip.value=d?.ip??''; form.elements.ip.readOnly=Boolean(d);
  form.elements.profile_id.value=d?.profile_id??'';
  $('#device-dialog').showModal();
}
function report(error) { $('#error').textContent=error.message; $('#error').hidden=false; }
$('#add-profile').onclick=()=>openProfile();
$('#add-device').onclick=()=>openDevice();
document.addEventListener('click', async e=>{
  const b=e.target.closest('button'); if(!b)return;
  if(b.dataset.close) $('#'+b.dataset.close).close();
  if(b.dataset.edit) openProfile(Number(b.dataset.edit));
  if(b.dataset.device) openDevice(b.dataset.device);
  try {
    if(b.dataset.pause) {const p=state.profiles.find(p=>p.id===Number(b.dataset.pause));state=await api('/api/profiles',{...p,paused:!p.paused});render();}
    if(b.dataset.delete && confirm('Remove this device assignment? Its DNS requests will become unmanaged.')) {state=await api('/api/devices/delete',{ip:b.dataset.delete});render();}
  } catch(error){report(error);}
});
$('#profile-form').onsubmit=async e=>{
  e.preventDefault(); const f=e.target; const data=Object.fromEntries(new FormData(f));
  const prior=state.profiles.find(p=>p.id===Number(data.id));
  const payload={name:data.name,limit:Number(data.limit),paused:prior?.paused??false,categories:Object.keys(state.categories).filter(k=>f.elements[k].checked),bedtime:{start:data.start,end:data.end}};
  if(data.id)payload.id=Number(data.id);
  for(const key of ['allow','deny'])payload[key]=data[key].split(/\n/).map(s=>s.trim()).filter(Boolean);
  try {state=await api('/api/profiles',payload);render();$('#profile-dialog').close();}catch(error){f.querySelector('.form-error').textContent=error.message;}
};
$('#device-form').onsubmit=async e=>{
  e.preventDefault();const f=e.target;const data=Object.fromEntries(new FormData(f));data.profile_id=data.profile_id?Number(data.profile_id):null;
  try{state=await api('/api/devices',data);render();$('#device-dialog').close();}catch(error){f.querySelector('.form-error').textContent=error.message;}
};
async function refresh(){try{state=await api('/api/state');render();$('#error').hidden=true;}catch(error){report(error);}}
refresh();setInterval(refresh,5000);

$('#enroll-form').onsubmit=async e=>{e.preventDefault();try{const result=await api('/api/enrollment',{profile_id:Number($('#enroll-profile').value)});$('#enroll-code').value=result.code;}catch(error){report(error);}};
