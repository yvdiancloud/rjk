const $ = id => document.getElementById(id);
const icon = (name, extraClass='') => `<svg class="ui-icon ${extraClass}" aria-hidden="true" focusable="false"><use href="/icons.svg#${name}"></use></svg>`;
const emptyLogs = (title='等待连接', detail='连接状态和工具调用会显示在这里') => `<div class="empty-log">${icon('paw')}<b>${title}</b><small>${detail}</small></div>`;
const toolDescriptions = {
  project_list_files: ['读取', 'read'], project_read_file: ['读取', 'read'], project_search: ['搜索', 'read'],
  git_status: ['Git 状态', 'read'], git_diff: ['Git 差异', 'read'], project_write_file: ['写文件', 'write'],
  run_command: ['运行程序', 'exec'], run_shell: ['运行 Shell', 'exec'], command_output: ['长任务输出', 'exec'], command_stop: ['停止任务', 'exec'],
  git_stage: ['Git 暂存', 'exec'], git_commit: ['Git 提交', 'exec']
};
let lastLogKey = '';
let toastTimer;
let serverConfigLoaded = false;
function toast(message) { $('toast').textContent = message; $('toast').classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => $('toast').classList.remove('show'), 2200); }
function permission() { return document.querySelector('input[name="permission"]:checked').value; }
function setPermission(value) { const radio = document.querySelector(`input[name="permission"][value="${value}"]`); if (radio) radio.checked = true; updatePermissionView(); }
function connectionMode() { return document.querySelector('input[name="connectionMode"]:checked')?.value || 'quick'; }
function updateConnectionMode() {
  const mode = connectionMode();
  $('serverConfig').classList.toggle('hidden', mode !== 'selfHosted');
  $('stableLinkActions').classList.toggle('hidden', mode !== 'selfHosted');
}
function updatePermissionView() {
  const mode = permission(); $('devNotice').classList.toggle('hidden', mode !== 'dev');
  renderTools(mode === 'read' ? ['project_list_files','project_read_file','project_search','git_status','git_diff'] : mode === 'edit' ? ['project_list_files','project_read_file','project_search','git_status','git_diff','project_write_file'] : Object.keys(toolDescriptions));
}
function renderTools(names) { $('toolList').innerHTML = names.map(name => { const [label, kind] = toolDescriptions[name]; return `<div class="tool-item ${kind}"><i></i><span>${name}</span><span class="tool-desc">${label}</span></div>`; }).join(''); }
function setConnected(data) {
  const tunnelActive = Boolean(data.connected);
  const mode = data.connectionMode || connectionMode();
  $('statusText').textContent = tunnelActive ? (mode === 'selfHosted' ? '自有服务器已连接' : '临时公网已连接') : '本机待连接';
  $('statusDot').parentElement.classList.toggle('connected', tunnelActive);
  $('connectBtn').classList.toggle('hidden', tunnelActive); $('stopBtn').classList.toggle('hidden', !tunnelActive);
  $('projectRoot').disabled = tunnelActive; document.querySelectorAll('input[name="permission"]').forEach(r => r.disabled = tunnelActive);
  document.querySelectorAll('input[name="connectionMode"]').forEach(r => { r.disabled = tunnelActive; if (tunnelActive) r.checked = r.value === mode; });
  document.querySelectorAll('#serverConfig input, #serverConfig button').forEach(el => { if (el.id !== 'copyServerKeyBtn') el.disabled = tunnelActive; });
  $('mcpUrl').value = data.mcpUrl || ''; $('copyBtn').disabled = !data.mcpUrl;
  $('actionHint').textContent = tunnelActive ? (mode === 'selfHosted' ? `固定地址在线：${data.tunnelUrl}` : `临时地址：${data.tunnelUrl}`) : data.mcpUrl && mode === 'selfHosted' ? `固定地址已保留：${data.tunnelUrl}（连接本机后恢复服务）` : mode === 'selfHosted' ? '启动后通过服务器固定地址连接本机' : '启动后自动创建临时 HTTPS 隧道';
  if (!$('connectBtn').classList.contains('hidden')) updateConnectionMode();
}
function renderLogs(items) {
  if (!items?.length) { $('logs').innerHTML = emptyLogs(); return; }
  const latest = items[items.length - 1]; const key = `${latest.at}:${latest.message}`;
  if (key === lastLogKey) return; lastLogKey = key;
  $('logs').innerHTML = items.slice(-80).map(item => { const time = new Date(item.at).toLocaleTimeString('zh-CN',{hour12:false}); const msg = item.message.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;'); return `<div class="log-line ${item.kind}"><span class="log-time">${time}</span><span>${msg}</span></div>`; }).join(''); $('logs').scrollTop = $('logs').scrollHeight;
}
async function request(url, options={}) { const response = await fetch(url, { ...options, headers: { 'content-type':'application/json', ...(options.headers||{}) } }); const data = await response.json().catch(()=>({})); if (!response.ok) throw new Error(data.error || `请求失败：${response.status}`); return data; }
function serverConfigBody() { return { host:$('serverHost').value.trim(), port:Number($('serverPort').value||22), username:$('serverUser').value.trim(), publicUrl:$('publicBaseUrl').value.trim(), hostFingerprint:$('serverFingerprint').value.trim() }; }
function fillServerConfig(data) {
  $('serverHost').value=data.host||''; $('serverPort').value=data.port||22; $('serverUser').value=data.username||''; $('publicBaseUrl').value=data.publicUrl||'';
  $('serverFingerprint').value=data.hostFingerprint ? `SHA256:${data.hostFingerprint}` : '';
  $('serverPublicKey').value=data.publicKey||'';
  const selected=document.querySelector(`input[name="connectionMode"][value="${data.connectionMode||'quick'}"]`); if(selected) selected.checked=true;
  $('serverConfigHint').textContent=data.configured?'服务器设置已保存；隧道密钥已保存在本机。':'读取 SSH 指纹并保存服务器设置后即可连接。';
  updateConnectionMode();
}
async function loadServerConfig() { if(serverConfigLoaded)return; try{fillServerConfig(await request('/api/server-config'));serverConfigLoaded=true;}catch(e){$('serverConfigHint').textContent=e.message;} }
async function saveServerConfig(showToast=true) {
  const data=await request('/api/server-config',{method:'POST',body:JSON.stringify(serverConfigBody())});
  fillServerConfig(data); serverConfigLoaded=true;
  if(showToast)toast('自有服务器设置已保存');
  await refresh();
  return data;
}
async function refresh() { try { const data = await request('/api/state'); if (data.projectRoot && !$('projectRoot').value) $('projectRoot').value=data.projectRoot; setConnected(data); renderLogs(data.logs); if (data.permission && !document.querySelector('input[name="permission"]:checked')?.disabled) setPermission(data.permission); if(!serverConfigLoaded)await loadServerConfig(); } catch {} }
$('pickBtn').addEventListener('click', async () => { $('pickBtn').disabled=true; try { const data=await request('/api/pick-folder',{method:'POST',body:'{}'}); if(data.path) $('projectRoot').value=data.path; } catch(e){toast(e.message)} finally{$('pickBtn').disabled=false;} });
$('connectBtn').addEventListener('click', async () => {
  const root=$('projectRoot').value.trim(); if(!root){toast('请先选择项目目录');$('projectRoot').focus();return;}
  const mode=connectionMode();
  $('connectBtn').disabled=true; $('connectBtn').innerHTML=`${icon('loader','is-spinning')}正在建立安全连接`; $('actionHint').textContent=mode==='selfHosted'?'正在连接自有服务器并建立 SSH 反向转发…':'正在准备本地 MCP 服务和 HTTPS 隧道…';
  try { if(mode==='selfHosted')await saveServerConfig(false); const data=await request('/api/connect',{method:'POST',body:JSON.stringify({projectRoot:root,permission:permission(),connectionMode:mode})}); setConnected(data); toast('MCP 地址已就绪'); }
  catch(e){toast(e.message);$('actionHint').textContent=e.message;}
  finally{$('connectBtn').disabled=false;$('connectBtn').innerHTML=`${icon('arrow-up-right')}启动安全连接`;await refresh();}
});
$('stopBtn').addEventListener('click', async () => { $('stopBtn').disabled=true; try{await request('/api/disconnect',{method:'POST',body:'{}'});toast('连接已停止；稳定地址保持不变');}catch(e){toast(e.message)}finally{$('stopBtn').disabled=false;await refresh();} });
$('copyBtn').addEventListener('click', async () => { try { await navigator.clipboard.writeText($('mcpUrl').value); toast('MCP 地址已复制'); } catch { $('mcpUrl').select(); document.execCommand('copy'); toast('MCP 地址已复制'); } });
$('resetLinkBtn').addEventListener('click', async () => {
  if (!window.confirm('重置后旧 MCP 地址会立即失效，ChatGPT 中已添加的连接需要替换为新地址。确定继续吗？')) return;
  const button = $('resetLinkBtn'); button.disabled = true;
  try { await request('/api/reset-link', { method: 'POST', body: '{}' }); await refresh(); toast('固定链接已重置；请复制新地址并更新 ChatGPT 连接'); }
  catch (e) { toast(e.message); }
  finally { button.disabled = false; }
});
$('stepsToggle').addEventListener('click',()=>{$('stepsList').classList.toggle('collapsed');$('stepsToggle').innerHTML=`${icon($('stepsList').classList.contains('collapsed')?'chevron-right':'chevron-down')} ChatGPT 网页端配置步骤`;});
$('clearLogs').addEventListener('click',async()=>{try{await request('/api/clear-logs',{method:'POST',body:'{}'});$('logs').innerHTML=emptyLogs('日志已清空','新的连接活动会显示在这里');lastLogKey='';}catch(e){toast(e.message)}});
document.querySelectorAll('input[name="permission"]').forEach(r=>r.addEventListener('change',async()=>{updatePermissionView();try{await request('/api/permission',{method:'POST',body:JSON.stringify({permission:permission()})});}catch(e){toast(e.message)}}));
document.querySelectorAll('input[name="connectionMode"]').forEach(r=>r.addEventListener('change',async()=>{updateConnectionMode();$('actionHint').textContent=connectionMode()==='selfHosted'?'使用你的固定 HTTPS 地址，通过 SSH 反向转发连接本机':'创建临时 HTTPS 隧道，不需要配置域名';try{await request('/api/connection-mode',{method:'POST',body:JSON.stringify({mode:connectionMode()})});}catch(e){toast(e.message)}}));
$('probeServerBtn').addEventListener('click',async()=>{const host=$('serverHost').value.trim();if(!host){toast('请先填写 SSH 服务器地址');return;} $('probeServerBtn').disabled=true;$('probeServerBtn').textContent='正在读取…';try{const data=await request('/api/server-probe',{method:'POST',body:JSON.stringify({host,port:Number($('serverPort').value||22)})});$('serverFingerprint').value=data.fingerprint;$('serverConfigHint').textContent='请先核对指纹是否属于你的服务器，再保存设置。';toast('已读取 SSH 主机指纹');}catch(e){toast(e.message)}finally{$('probeServerBtn').disabled=false;$('probeServerBtn').textContent='读取指纹';}});
$('saveServerConfigBtn').addEventListener('click',async()=>{const button=$('saveServerConfigBtn');button.disabled=true;try{await saveServerConfig();}catch(e){toast(e.message)}finally{button.disabled=false;}});
$('copyServerKeyBtn').addEventListener('click',async()=>{try{await navigator.clipboard.writeText($('serverPublicKey').value);toast('SSH 公钥已复制');}catch{$('serverPublicKey').select();document.execCommand('copy');toast('SSH 公钥已复制');}});
refresh(); setInterval(refresh,1800);
