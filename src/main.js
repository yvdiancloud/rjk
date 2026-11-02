const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');
const { spawn } = require('node:child_process');
const net = require('node:net');
const { Client: SSHClient, utils: sshUtils } = require('ssh2');

const HOST = '127.0.0.1';
const DEFAULT_PORT = Number(process.env.WEXRUN_PORT || 43127);
const ROOT_DIR = path.resolve(__dirname, '..');
const UI_DIR = path.join(ROOT_DIR, 'ui');
const defaultUserDataDir = process.platform === 'win32'
  ? path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Local MCP Studio')
  : process.platform === 'darwin'
    ? path.join(os.homedir(), 'Library', 'Application Support', 'Local MCP Studio')
    : path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'local-mcp-studio');
const DATA_DIR = path.resolve(process.env.WEXRUN_DATA_DIR || defaultUserDataDir);
const CACHE_DIR = path.join(DATA_DIR, '.cache');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const SSH_PRIVATE_KEY_FILE = path.join(DATA_DIR, 'server-tunnel-ed25519');
const SELF_HOSTED_REMOTE_PORT = 43128;
const SKIP_DIRS = new Set(['.git', 'node_modules', '.venv', 'venv', 'dist', 'build', '.next', '.turbo', 'coverage']);
const MAX_BODY = 2 * 1024 * 1024;
const MAX_MCP_BODY = 32 * 1024 * 1024;
const MAX_OUTPUT = 64 * 1024;
const MAX_JOBS = 50;
const MCP_CALL_LIMIT = 180;
const APP_VERSION = '0.1.14';
const REA_VERSION = '6.8.0';
const MODERN_MCP_VERSION = '2026-07-28';
const MCP_SUPPORTED_VERSIONS = [MODERN_MCP_VERSION, '2025-11-25', '2025-06-18', '2025-03-26'];
const MCP_VERSIONS = new Set(MCP_SUPPORTED_VERSIONS);
const CLOUDFLARED_VERSION = '2026.10.7';
const CLOUDFLARED_SHA256 = '2493dbc168923bb3e59e5e7716f71deced92992eea9acd6e9d74f84ac7751343';
const CLOUDFLARED_DOWNLOAD_URL = `https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/cloudflared-windows-amd64.exe`;

const state = {
  port: DEFAULT_PORT,
  stopping: null,
  projectRoot: null,
  permission: 'read',
  token: null,
  connectionMode: 'quick',
  tunnelUrl: null,
  tunnelProcess: null,
  sshClient: null,
  tunnelBuffer: '',
  logs: [],
  jobs: new Map(),
  mcpRequests: [],
};

let appSettingsCache = null;
let appSettingsPromise = null;
let reaPackageInfoCache = null;
const reaBridge = {
  child: null,
  starting: null,
  pending: new Map(),
  buffer: '',
  decoder: null,
  nextId: 0,
  tools: [],
  nameMap: new Map(),
  packageRoot: null,
  lastError: '',
  stopping: false,
  expectedChild: null,
};

function publicKeyFromPrivate(privateKey) {
  const parsed = sshUtils.parseKey(privateKey);
  if (parsed instanceof Error) throw new Error('服务器转发密钥无法读取，请重新生成。');
  return `${parsed.type} ${Buffer.from(parsed.getPublicSSH()).toString('base64')} Local MCP Studio`;
}

async function loadAppSettings() {
  if (appSettingsCache) return appSettingsCache;
  if (appSettingsPromise) return appSettingsPromise;
  appSettingsPromise = initializeAppSettings();
  try { return await appSettingsPromise; }
  finally { appSettingsPromise = null; }
}

async function initializeAppSettings() {
  await fsp.mkdir(DATA_DIR, { recursive: true });
  let stored = {};
  try { stored = JSON.parse(await fsp.readFile(SETTINGS_FILE, 'utf8')); } catch {}
  let privateKey;
  try {
    privateKey = await fsp.readFile(SSH_PRIVATE_KEY_FILE, 'utf8');
    publicKeyFromPrivate(privateKey);
  } catch {
    const pair = sshUtils.generateKeyPairSync('ed25519', { comment: 'Local MCP Studio server tunnel' });
    privateKey = pair.private;
    await fsp.writeFile(SSH_PRIVATE_KEY_FILE, privateKey, { mode: 0o600, flag: 'wx' }).catch(async error => {
      if (error.code !== 'EEXIST') throw error;
      privateKey = await fsp.readFile(SSH_PRIVATE_KEY_FILE, 'utf8');
      publicKeyFromPrivate(privateKey);
    });
  }
  const defaults = {
    stableMcpToken: crypto.randomBytes(32).toString('hex'),
    connectionMode: 'quick',
    selfHosted: { host: '', port: 22, username: '', publicUrl: '', remotePort: SELF_HOSTED_REMOTE_PORT, hostFingerprint: '' },
  };
  const selfHosted = { ...defaults.selfHosted, ...(stored.selfHosted && typeof stored.selfHosted === 'object' ? stored.selfHosted : {}) };
  appSettingsCache = {
    ...defaults,
    ...stored,
    stableMcpToken: /^[a-f0-9]{64}$/.test(stored.stableMcpToken || '') ? stored.stableMcpToken : defaults.stableMcpToken,
    connectionMode: stored.connectionMode === 'selfHosted' ? 'selfHosted' : 'quick',
    selfHosted,
  };
  await saveAppSettings(appSettingsCache);
  return appSettingsCache;
}

async function saveAppSettings(next) {
  appSettingsCache = next;
  await fsp.mkdir(DATA_DIR, { recursive: true });
  const temporary = `${SETTINGS_FILE}.${process.pid}.tmp`;
  await fsp.writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await fsp.rename(temporary, SETTINGS_FILE).catch(async error => {
    if (error.code !== 'EEXIST' && error.code !== 'EPERM') throw error;
    await fsp.rm(SETTINGS_FILE, { force: true });
    await fsp.rename(temporary, SETTINGS_FILE);
  });
}

function normalizedFingerprint(value) {
  return String(value || '').trim().replace(/^SHA256:/i, '').replace(/=+$/, '');
}

function sshFingerprintFromHash(hash) {
  const value = String(hash || '').trim();
  if (/^[a-f0-9]{64}$/i.test(value)) return Buffer.from(value, 'hex').toString('base64').replace(/=+$/, '');
  return normalizedFingerprint(value);
}

function validateSelfHostedSettings(body) {
  const host = String(body.host || '').trim();
  const username = String(body.username || '').trim();
  const port = Number(body.port || 22);
  const remotePort = Number(body.remotePort || SELF_HOSTED_REMOTE_PORT);
  const publicUrlInput = String(body.publicUrl || '').trim();
  const hostFingerprint = normalizedFingerprint(body.hostFingerprint);
  if (host && !(net.isIP(host) || /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(host))) throw new Error('服务器地址格式无效。');
  if (username && !/^[a-z_][a-z0-9_.-]{0,31}$/i.test(username)) throw new Error('SSH 用户名格式无效。');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('SSH 端口必须在 1 到 65535 之间。');
  if (!Number.isInteger(remotePort) || remotePort < 1024 || remotePort > 65535) throw new Error('服务器转发端口必须在 1024 到 65535 之间。');
  let publicUrl = '';
  if (publicUrlInput) {
    let parsed;
    try { parsed = new URL(publicUrlInput); } catch { throw new Error('公网地址必须是完整的 HTTPS URL。'); }
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || !['', '/'].includes(parsed.pathname) || parsed.search || parsed.hash) throw new Error('公网地址必须是根路径形式的 HTTPS 地址，例如 https://mcp.example.com。');
    publicUrl = parsed.origin;
  }
  if (hostFingerprint && !/^[A-Za-z0-9+/]{43}$/.test(hostFingerprint)) throw new Error('SSH 指纹格式应为 SHA256: 后的 43 位字符。');
  return { host, port, username, publicUrl, remotePort, hostFingerprint };
}

function probeSSHHost(host, port) {
  return new Promise((resolve, reject) => {
    const conn = new SSHClient();
    let fingerprint = '';
    let finished = false;
    const finish = (error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      conn.end();
      if (fingerprint) resolve(sshFingerprintFromHash(fingerprint));
      else reject(error || new Error('未能读取 SSH 主机指纹。'));
    };
    const timer = setTimeout(() => finish(new Error('读取服务器指纹超时。')), 12000);
    conn.on('error', error => finish(error));
    conn.on('close', () => finish());
    conn.connect({
      host,
      port,
      username: 'fingerprint-probe',
      hostHash: 'sha256',
      hostVerifier: hash => { fingerprint = hash; return false; },
      readyTimeout: 10000,
    });
  });
}

async function getServerConfig() {
  const settings = await loadAppSettings();
  const privateKey = await fsp.readFile(SSH_PRIVATE_KEY_FILE, 'utf8');
  return {
    ...settings.selfHosted,
    connectionMode: settings.connectionMode,
    publicKey: publicKeyFromPrivate(privateKey),
    configured: Boolean(settings.selfHosted.host && settings.selfHosted.username && settings.selfHosted.publicUrl && settings.selfHosted.hostFingerprint),
  };
}

function log(message, kind = 'info') {
  const item = { at: new Date().toISOString(), message: String(message).slice(0, 2000), kind };
  state.logs.push(item);
  if (state.logs.length > 300) state.logs.splice(0, state.logs.length - 300);
  process.stderr.write(`[${item.at}] ${kind.toUpperCase()} ${item.message}\n`);
}

function json(res, status, data, extra = {}) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extra });
  res.end(status === 204 || status === 304 ? undefined : JSON.stringify(data));
}

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

async function ensureRoot() {
  if (!state.projectRoot) throw new Error('请先选择并连接一个项目目录。');
  const real = await fsp.realpath(state.projectRoot);
  if (real !== state.projectRoot) state.projectRoot = real;
  return real;
}

function resolveInputPath(input) {
  const root = state.projectRoot;
  if (!root) throw new Error('尚未选择项目目录。');
  const value = typeof input === 'string' && input.trim() ? input.trim() : '.';
  if (path.isAbsolute(value)) throw new Error('请使用相对于项目根目录的路径。');
  const target = path.resolve(root, value);
  if (!isWithin(root, target)) throw new Error('路径超出已授权的项目目录。');
  return target;
}

async function assertSafePath(input, { allowMissing = false, directory = false } = {}) {
  const root = await ensureRoot();
  const target = resolveInputPath(input);
  const relative = path.relative(root, target);
  let cursor = root;
  const segments = relative ? relative.split(path.sep) : [];
  for (let i = 0; i < segments.length; i++) {
    cursor = path.join(cursor, segments[i]);
    let stat;
    try { stat = await fsp.lstat(cursor); }
    catch (e) {
      if (e.code === 'ENOENT' && allowMissing) {
        const rest = path.join(cursor, ...segments.slice(i + 1));
        return { root, target, real: rest };
      }
      throw e;
    }
    if (stat.isSymbolicLink()) throw new Error('出于安全原因，不允许通过符号链接访问项目文件。');
    if (i < segments.length - 1 && !stat.isDirectory()) throw new Error('路径中的上级项目不是目录。');
  }
  const stat = await fsp.stat(target).catch(e => { if (allowMissing && e.code === 'ENOENT') return null; throw e; });
  if (directory && stat && !stat.isDirectory()) throw new Error('指定路径不是目录。');
  const real = stat ? await fsp.realpath(target) : target;
  if (!isWithin(root, real)) throw new Error('解析后的路径超出项目目录。');
  return { root, target, real, stat };
}

function requirePermission(minimum) {
  const rank = { read: 0, edit: 1, dev: 2 };
  if ((rank[state.permission] ?? -1) < rank[minimum]) throw new Error(`此工具需要“${minimum === 'edit' ? '允许编辑' : '开发模式'}”权限。`);
}

async function readBody(req, limit = MAX_BODY) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error(`请求内容超过 ${Math.floor(limit / (1024 * 1024))} MiB 限制。`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function localToolsForPermission() {
  const tools = [
    { name: 'project_list_files', description: '列出已授权项目目录内的文件和目录；不会跟随符号链接。', inputSchema: { type: 'object', properties: { path: { type: 'string', description: '相对项目根目录的目录路径，默认为 .' }, depth: { type: 'integer', minimum: 1, maximum: 5, description: '递归深度，默认为 2' }, limit: { type: 'integer', minimum: 1, maximum: 500, description: '最多返回条目数，默认为 200' } } } },
    { name: 'project_read_file', description: '读取项目根目录内的 UTF-8 文本文件。', inputSchema: { type: 'object', required: ['path'], properties: { path: { type: 'string', description: '相对项目根目录的文件路径' }, max_bytes: { type: 'integer', minimum: 1, maximum: 1000000, description: '最大读取字节数，默认为 200000' } } } },
    { name: 'project_search', description: '在项目文本文件中搜索字面文本；跳过依赖目录、构建输出和二进制文件。', inputSchema: { type: 'object', required: ['query'], properties: { query: { type: 'string' }, path: { type: 'string', description: '相对项目根目录的搜索起点，默认为 .' }, limit: { type: 'integer', minimum: 1, maximum: 200, description: '最多返回匹配行数，默认为 50' }, case_sensitive: { type: 'boolean', description: '是否区分大小写' } } } },
    { name: 'git_status', description: '读取项目的 Git 状态。', inputSchema: { type: 'object', properties: {} } },
    { name: 'git_diff', description: '查看项目的未暂存 Git 差异，可选择指定相对路径。', inputSchema: { type: 'object', properties: { path: { type: 'string', description: '可选的相对路径' }, staged: { type: 'boolean', description: '读取已暂存差异' } } } },
  ];
  if (state.permission === 'edit' || state.permission === 'dev') tools.push(
    { name: 'project_write_file', description: '在项目根目录内创建或覆盖 UTF-8 文件。仅在“允许编辑”或“开发模式”下开放。', inputSchema: { type: 'object', required: ['path', 'content'], properties: { path: { type: 'string' }, content: { type: 'string' }, create_directories: { type: 'boolean', description: '是否创建缺失的父目录' } } } },
  );
  if (state.permission === 'dev') tools.push(
    { name: 'run_command', description: '运行指定可执行文件及参数，不经 shell 解析；进程以当前 Windows 用户权限运行，工作目录必须在项目内。仅对可信项目启用开发模式。', inputSchema: { type: 'object', required: ['command'], properties: { command: { type: 'string', description: '可执行文件名或绝对路径，例如 node、git.exe、python.exe' }, args: { type: 'array', items: { type: 'string' } }, cwd: { type: 'string', description: '项目内相对工作目录，默认为 .' }, timeout_ms: { type: 'integer', minimum: 1000, maximum: 120000, description: '同步等待时长，默认为 20000' } } } },
    { name: 'run_shell', description: '在项目目录中运行 PowerShell 命令行，支持管道、重定向和 Windows .cmd 工具；命令以当前 Windows 用户权限执行。仅对可信项目启用开发模式。', inputSchema: { type: 'object', required: ['command_line'], properties: { command_line: { type: 'string', description: '完整 PowerShell 命令行，例如 npm run build' }, cwd: { type: 'string', description: '项目内相对工作目录，默认为 .' }, timeout_ms: { type: 'integer', minimum: 1000, maximum: 120000, description: '同步等待时长，默认为 20000' } } } },
    { name: 'command_output', description: '读取由 run_command 启动的开发命令的最新输出和运行状态。', inputSchema: { type: 'object', required: ['process_id'], properties: { process_id: { type: 'string' }, offset: { type: 'integer', minimum: 0 } } } },
    { name: 'command_stop', description: '停止由 run_command 启动的开发命令。', inputSchema: { type: 'object', required: ['process_id'], properties: { process_id: { type: 'string' } } } },
    { name: 'git_stage', description: '暂存项目内指定路径的 Git 更改。仅开发模式可用。', inputSchema: { type: 'object', required: ['paths'], properties: { paths: { type: 'array', minItems: 1, items: { type: 'string' } } } } },
    { name: 'git_commit', description: '提交当前 Git 暂存区。仅开发模式可用。', inputSchema: { type: 'object', required: ['message'], properties: { message: { type: 'string', minLength: 1, maxLength: 500 } } } },
  );
  return tools;
}

function locateReaPackageRoot() {
  const candidates = [
    process.env.LOCALMCP_REA_ROOT,
    path.join(ROOT_DIR, 'rea'),
    'D:\\npm-global\\node_modules\\rea-agents',
  ].filter(Boolean);
  for (const candidate of candidates) {
    const root = path.resolve(candidate);
    if (fs.existsSync(path.join(root, 'scripts', 'rea.mjs')) && fs.existsSync(path.join(root, 'dist', 'mcp-catalog-full.json'))) return root;
  }
  return null;
}

function reaPackageInfo() {
  if (reaPackageInfoCache) return reaPackageInfoCache;
  const packageRoot = locateReaPackageRoot();
  if (!packageRoot) {
    reaPackageInfoCache = { available: false, version: null, toolCount: 0, error: '安装包中未找到 REA MCP 运行时。' };
    return reaPackageInfoCache;
  }
  try {
    const packageJson = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
    const catalog = JSON.parse(fs.readFileSync(path.join(packageRoot, 'dist', 'mcp-catalog-full.json'), 'utf8'));
    if (packageJson.version !== REA_VERSION || !Array.isArray(catalog.tools)) throw new Error(`预期 REA ${REA_VERSION}，实际为 ${packageJson.version || '未知版本'}。`);
    reaBridge.packageRoot = packageRoot;
    reaPackageInfoCache = { available: true, version: packageJson.version, toolCount: catalog.tools.length, error: '' };
  } catch (error) {
    reaPackageInfoCache = { available: false, version: null, toolCount: 0, error: error.message };
  }
  return reaPackageInfoCache;
}

function clearReaBridge(child, error, expected = false) {
  if (reaBridge.child !== child) return;
  reaBridge.child = null;
  reaBridge.tools = [];
  reaBridge.nameMap.clear();
  reaBridge.buffer = '';
  reaBridge.decoder = null;
  if (reaBridge.expectedChild === child) reaBridge.expectedChild = null;
  for (const pending of reaBridge.pending.values()) {
    clearTimeout(pending.timer);
    pending.reject(error || new Error('REA MCP 服务已退出。'));
  }
  reaBridge.pending.clear();
  if (!expected) {
    reaBridge.lastError = error?.message || 'REA MCP 服务意外退出。';
    log(`REA MCP 服务已停止：${reaBridge.lastError}`, 'error');
  }
}

function receiveReaStdout(child, chunk) {
  if (reaBridge.child !== child || !reaBridge.decoder) return;
  reaBridge.buffer += reaBridge.decoder.write(chunk);
  for (;;) {
    const end = reaBridge.buffer.indexOf('\n');
    if (end < 0) return;
    const line = reaBridge.buffer.slice(0, end).trim();
    reaBridge.buffer = reaBridge.buffer.slice(end + 1);
    if (!line) continue;
    let message;
    try { message = JSON.parse(line); }
    catch { continue; }
    if (message.id === undefined || message.id === null) continue;
    const pending = reaBridge.pending.get(message.id);
    if (!pending) continue;
    reaBridge.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error) pending.reject(new Error(message.error.message || 'REA MCP 请求失败。'));
    else pending.resolve(message.result);
  }
}

function reaRequest(method, params, timeoutMs = 1200000) {
  const child = reaBridge.child;
  if (!child || child.exitCode !== null) return Promise.reject(new Error('REA MCP 服务未运行。'));
  const id = ++reaBridge.nextId;
  const message = `${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reaBridge.pending.delete(id);
      reject(new Error(`REA MCP 请求超时：${method}`));
    }, timeoutMs);
    reaBridge.pending.set(id, { resolve, reject, timer });
    child.stdin.write(message, error => {
      if (!error) return;
      const pending = reaBridge.pending.get(id);
      if (!pending) return;
      reaBridge.pending.delete(id);
      clearTimeout(timer);
      reject(error);
    });
  });
}

function reaNotification(method, params = {}) {
  const child = reaBridge.child;
  if (!child || child.exitCode !== null) throw new Error('REA MCP 服务未运行。');
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
}

async function startReaServer() {
  if (reaBridge.child && reaBridge.child.exitCode === null && reaBridge.tools.length) return reaBridge.tools;
  if (reaBridge.starting) return reaBridge.starting;
  if (reaBridge.stopping) throw new Error('REA MCP 服务正在关闭，请重试。');
  const info = reaPackageInfo();
  if (!info.available) throw new Error(info.error || 'REA MCP 运行时不可用。');
  const packageRoot = reaBridge.packageRoot;
  const projectRoot = await ensureRoot();
  const entry = path.join(packageRoot, 'scripts', 'rea.mjs');
  const child = spawn(process.execPath, [entry, 'mcp'], {
    cwd: projectRoot,
    env: { ...process.env, REA_MCP_INPUT_SCHEMA_PROFILE: 'full', REA_MCP_OUTPUT_SCHEMA_PROFILE: 'full' },
    windowsHide: true,
    shell: false,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  reaBridge.child = child;
  reaBridge.decoder = new (require('node:string_decoder').StringDecoder)('utf8');
  reaBridge.buffer = '';
  reaBridge.lastError = '';
  const failed = (error, expected = false) => clearReaBridge(child, error || new Error('REA MCP 服务意外退出。'), expected);
  child.stdout.on('data', chunk => receiveReaStdout(child, chunk));
  child.stderr.on('data', () => {});
  child.once('error', failed);
  child.once('close', (code, signal) => {
    const expected = reaBridge.expectedChild === child;
    failed(new Error(`进程结束（${signal || `退出码 ${code}`}）`), expected);
  });
  const launch = (async () => {
    const initialized = await reaRequest('initialize', {
      protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'local-mcp-studio', version: APP_VERSION },
    }, 120000);
    if (!initialized?.protocolVersion) throw new Error('REA MCP 初始化返回格式无效。');
    reaNotification('notifications/initialized');
    const tools = [];
    let cursor;
    let pages = 0;
    do {
      const page = await reaRequest('tools/list', cursor ? { cursor } : {}, 120000);
      if (!Array.isArray(page?.tools)) throw new Error('REA MCP 工具清单格式无效。');
      tools.push(...page.tools);
      cursor = page.nextCursor;
      pages++;
      if (pages > 100) throw new Error('REA MCP 工具清单分页数量异常。');
    } while (cursor);
    const localNames = new Set(localToolsForPermission().map(tool => tool.name));
    reaBridge.nameMap.clear();
    const publicTools = tools.map(tool => {
      let name = tool.name;
      if (localNames.has(name)) name = `rea_${name}`;
      while (localNames.has(name) || reaBridge.nameMap.has(name)) name = `rea_${name}`;
      reaBridge.nameMap.set(name, tool.name);
      return name === tool.name ? tool : { ...tool, name };
    });
    reaBridge.tools = publicTools;
    log(`REA ${info.version} MCP 已就绪：${publicTools.length} 项工具`, 'success');
    return publicTools;
  })();
  reaBridge.starting = launch;
  try { return await launch; }
  catch (error) {
    reaBridge.lastError = error.message;
    child.kill();
    clearReaBridge(child, error, true);
    throw error;
  } finally {
    if (reaBridge.starting === launch) reaBridge.starting = null;
  }
}

async function stopReaServer() {
  reaBridge.stopping = true;
  try {
    if (reaBridge.starting) await reaBridge.starting.catch(() => {});
    const child = reaBridge.child;
    if (!child) return;
    if (child.exitCode !== null) { clearReaBridge(child, new Error('REA MCP 服务已关闭。'), true); return; }
    reaBridge.expectedChild = child;
    const closed = new Promise(resolve => child.once('close', resolve));
    child.stdin.end();
    let timer;
    await Promise.race([closed, new Promise(resolve => { timer = setTimeout(resolve, 5000); })]);
    clearTimeout(timer);
    if (child.exitCode === null) child.kill();
    if (reaBridge.child === child && child.exitCode !== null) clearReaBridge(child, new Error('REA MCP 服务已关闭。'), true);
  } finally { reaBridge.stopping = false; }
}

async function reaToolsForPermission() {
  if (state.permission !== 'dev') return [];
  requirePermission('dev');
  return startReaServer();
}

async function toolsForPermission() {
  const tools = localToolsForPermission();
  if (state.permission !== 'dev') return tools;
  return [...tools, ...await reaToolsForPermission()];
}

async function listFiles(args) {
  const base = await assertSafePath(args.path || '.', { directory: true });
  const maxDepth = Math.max(1, Math.min(5, Number(args.depth) || 2));
  const limit = Math.max(1, Math.min(500, Number(args.limit) || 200));
  const output = [];
  async function visit(dir, depth) {
    if (output.length >= limit || depth > maxDepth) return;
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (output.length >= limit) break;
      if (entry.isSymbolicLink()) continue;
      const full = path.join(dir, entry.name);
      const rel = path.relative(base.root, full).split(path.sep).join('/');
      output.push({ path: rel, type: entry.isDirectory() ? 'directory' : 'file' });
      if (entry.isDirectory() && !SKIP_DIRS.has(entry.name) && depth < maxDepth) await visit(full, depth + 1);
    }
  }
  await visit(base.real, 1);
  return { root: base.root, files: output, truncated: output.length >= limit };
}

async function readFile(args) {
  const item = await assertSafePath(args.path);
  if (!item.stat.isFile()) throw new Error('指定路径不是普通文件。');
  const max = Math.max(1, Math.min(1_000_000, Number(args.max_bytes) || 200_000));
  const handle = await fsp.open(item.real, 'r');
  try {
    const buffer = Buffer.alloc(max + 1);
    const { bytesRead } = await handle.read(buffer, 0, max + 1, 0);
    const clipped = bytesRead > max;
    const data = buffer.subarray(0, Math.min(bytesRead, max));
    if (data.includes(0)) throw new Error('该文件看起来是二进制文件，已跳过。');
    return { path: path.relative(item.root, item.real).split(path.sep).join('/'), content: data.toString('utf8'), bytes: Math.min(bytesRead, max), truncated: clipped };
  } finally { await handle.close(); }
}

async function searchFiles(args) {
  const query = String(args.query || '');
  if (!query) throw new Error('query 不能为空。');
  const start = await assertSafePath(args.path || '.', { directory: true });
  const limit = Math.max(1, Math.min(200, Number(args.limit) || 50));
  const sensitive = Boolean(args.case_sensitive);
  const needle = sensitive ? query : query.toLocaleLowerCase();
  const results = [];
  let scanned = 0;
  async function walk(dir) {
    if (results.length >= limit || scanned >= 5000) return;
    for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
      if (results.length >= limit || scanned >= 5000) break;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) { if (!SKIP_DIRS.has(entry.name)) await walk(path.join(dir, entry.name)); continue; }
      if (!entry.isFile()) continue;
      const file = path.join(dir, entry.name);
      const stat = await fsp.stat(file);
      if (stat.size > 1_000_000) continue;
      scanned++;
      const buffer = await fsp.readFile(file);
      if (buffer.includes(0)) continue;
      const lines = buffer.toString('utf8').split(/\r?\n/);
      for (let i = 0; i < lines.length && results.length < limit; i++) {
        const hay = sensitive ? lines[i] : lines[i].toLocaleLowerCase();
        if (hay.includes(needle)) results.push({ path: path.relative(start.root, file).split(path.sep).join('/'), line: i + 1, text: lines[i].slice(0, 600) });
      }
    }
  }
  await walk(start.real);
  return { matches: results, files_scanned: scanned, truncated: results.length >= limit || scanned >= 5000 };
}

async function git(args) {
  const root = await ensureRoot();
  const gitArgs = args;
  const result = await new Promise((resolve, reject) => {
    const child = spawn('git', gitArgs, { cwd: root, windowsHide: true, shell: false });
    let out = ''; let err = '';
    child.stdout.on('data', b => { if (out.length < MAX_OUTPUT) out += b.toString(); });
    child.stderr.on('data', b => { if (err.length < MAX_OUTPUT) err += b.toString(); });
    child.on('error', reject);
    child.on('close', code => resolve({ exit_code: code, stdout: out.slice(0, MAX_OUTPUT), stderr: err.slice(0, MAX_OUTPUT) }));
  });
  if (result.exit_code !== 0) throw new Error(result.stderr || `git 退出码 ${result.exit_code}`);
  return result.stdout;
}

function appendJob(job, chunk) {
  job.output += chunk.toString();
  if (job.output.length > MAX_OUTPUT) job.output = job.output.slice(-MAX_OUTPUT);
}

async function startCommand(args, useShell = false) {
  requirePermission('dev');
  if (state.jobs.size >= MAX_JOBS) {
    for (const [jobId, oldJob] of state.jobs) {
      if (oldJob.state !== 'running' && oldJob.state !== 'stopping') state.jobs.delete(jobId);
      if (state.jobs.size < MAX_JOBS) break;
    }
    if (state.jobs.size >= MAX_JOBS) throw new Error('当前命令任务过多，请停止或等待现有任务结束。');
  }
  const executable = String(useShell ? args.command_line || '' : args.command || '').trim();
  if (!executable) throw new Error(useShell ? 'command_line 不能为空。' : 'command 不能为空。');
  const cwdInfo = await assertSafePath(args.cwd || '.', { directory: true });
  const argv = Array.isArray(args.args) ? args.args.map(String) : [];
  if (argv.length > 100) throw new Error('命令参数最多 100 项。');
  const id = crypto.randomUUID();
  const spawnOptions = { cwd: cwdInfo.real, windowsHide: true, shell: false, env: process.env };
  const child = useShell
    ? (process.platform === 'win32'
      ? spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', executable], spawnOptions)
      : spawn(process.env.SHELL || '/bin/sh', ['-lc', executable], spawnOptions))
    : spawn(executable, argv, spawnOptions);
  const job = { id, command: executable, args: argv, output: '', state: 'running', exitCode: null, startedAt: Date.now(), child };
  state.jobs.set(id, job);
  child.stdout.on('data', b => appendJob(job, b));
  child.stderr.on('data', b => appendJob(job, b));
  child.on('error', e => { job.state = 'failed'; appendJob(job, `\n${e.message}`); });
  child.on('close', code => { job.state = 'exited'; job.exitCode = code; });
  const timeout = Math.max(1000, Math.min(120000, Number(args.timeout_ms) || 20000));
  const until = Date.now() + timeout;
  while (Date.now() < until && job.state === 'running') await new Promise(resolve => setTimeout(resolve, 100));
  return { process_id: id, state: job.state, exit_code: job.exitCode, output: job.output.slice(-12000), ...(job.state === 'running' ? { message: '命令仍在运行，可用 command_output 继续读取。' } : {}) };
}

function getJob(args) {
  const job = state.jobs.get(String(args.process_id));
  if (!job) throw new Error('找不到此进程，或进程标识已过期。');
  return job;
}

function stopJob(job) {
  if (job.state !== 'running') return;
  job.state = 'stopping';
  if (process.platform === 'win32' && job.child.pid) {
    const killer = spawn('taskkill.exe', ['/PID', String(job.child.pid), '/T', '/F'], { windowsHide: true, shell: false, stdio: 'ignore' });
    killer.on('error', () => job.child.kill());
    killer.on('close', code => { if (code !== 0 && job.child.exitCode === null) job.child.kill(); });
  } else job.child.kill();
}

async function callTool(name, args) {
  if (reaBridge.nameMap.has(name)) {
    requirePermission('dev');
    return reaRequest('tools/call', { name: reaBridge.nameMap.get(name), arguments: args || {} });
  }
  switch (name) {
    case 'project_list_files': return listFiles(args);
    case 'project_read_file': return readFile(args);
    case 'project_search': return searchFiles(args);
    case 'git_status': return git(['status', '--short', '--branch']);
    case 'git_diff': {
      const argv = ['diff'];
      if (args.staged) argv.push('--cached');
      if (args.path) { const p = await assertSafePath(args.path, { allowMissing: true }); argv.push('--', path.relative(p.root, p.target)); }
      return git(argv);
    }
    case 'project_write_file': {
      requirePermission('edit');
      const item = await assertSafePath(args.path, { allowMissing: true });
      const parent = path.dirname(item.target);
      if (args.create_directories) await fsp.mkdir(parent, { recursive: true });
      const parentInfo = await assertSafePath(path.relative(item.root, parent) || '.', { directory: true });
      if (item.stat?.nlink > 1) throw new Error('出于安全原因，不允许覆盖包含多个硬链接的文件。');
      if (item.stat && !item.stat.isFile()) throw new Error('目标路径不是普通文件。');
      await fsp.writeFile(item.target, String(args.content), { encoding: 'utf8', flag: item.stat ? 'w' : 'wx' });
      log(`文件已写入：${path.relative(item.root, item.target)}`, 'write');
      return { path: path.relative(item.root, item.target).split(path.sep).join('/'), bytes: Buffer.byteLength(String(args.content), 'utf8'), written: true };
    }
    case 'run_command': return startCommand(args);
    case 'run_shell': return startCommand(args, true);
    case 'command_output': {
      requirePermission('dev');
      const job = getJob(args);
      const offset = Math.max(0, Number(args.offset) || 0);
      return { process_id: job.id, state: job.state, exit_code: job.exitCode, output: job.output.slice(offset), next_offset: job.output.length, started_at: new Date(job.startedAt).toISOString() };
    }
    case 'command_stop': {
      requirePermission('dev');
      const job = getJob(args);
      stopJob(job);
      return { process_id: job.id, state: job.state };
    }
    case 'git_stage': {
      requirePermission('dev');
      const paths = args.paths;
      if (!Array.isArray(paths) || !paths.length) throw new Error('paths 必须包含至少一个相对路径。');
      const root = await ensureRoot();
      const safe = [];
      for (const p of paths) { const item = await assertSafePath(p, { allowMissing: true }); safe.push(path.relative(root, item.target)); }
      return { staged: await git(['add', '--', ...safe]) };
    }
    case 'git_commit': {
      requirePermission('dev');
      const message = String(args.message || '').trim();
      if (!message) throw new Error('提交说明不能为空。');
      return { result: await git(['commit', '-m', message.slice(0, 500)]) };
    }
    default: throw new Error(`未知工具：${name}`);
  }
}

function rpcError(id, code, message, data) { return { jsonrpc: '2.0', id: id ?? null, error: { code, message, ...(data === undefined ? {} : { data }) } }; }

function isAllowedMcpOrigin(origin) {
  if (!origin) return true;
  try {
    const parsed = new URL(origin);
    const host = parsed.hostname.toLowerCase();
    return (parsed.protocol === 'https:' && (host === 'chatgpt.com' || host.endsWith('.chatgpt.com') || host === 'openai.com' || host.endsWith('.openai.com')))
      || (['http:', 'https:'].includes(parsed.protocol) && ['localhost', '127.0.0.1', '[::1]'].includes(host));
  } catch { return false; }
}

async function handleMcp(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const match = url.pathname.match(/^\/mcp\/([a-f0-9]{64})$/);
  if (!match) return json(res, 404, { error: 'not found' });
  const presented = Buffer.from(match[1]);
  const remoteAuthorized = Boolean(state.tunnelUrl && state.token && crypto.timingSafeEqual(presented, Buffer.from(state.token)));
  if (!remoteAuthorized) return json(res, 404, { error: 'not found' });
  if (!isAllowedMcpOrigin(req.headers.origin)) return json(res, 403, { error: 'origin denied' });
  const now = Date.now();
  state.mcpRequests = state.mcpRequests.filter(at => now - at < 60_000);
  if (state.mcpRequests.length >= MCP_CALL_LIMIT) return json(res, 429, { error: 'rate limit exceeded' }, { 'retry-after': '60' });
  state.mcpRequests.push(now);
  const origin = req.headers.origin;
  const cors = { ...(origin ? { 'access-control-allow-origin': origin, vary: 'Origin' } : {}), 'access-control-expose-headers': 'Mcp-Session-Id, MCP-Protocol-Version' };
  if (req.method === 'OPTIONS') return json(res, 204, {}, { ...cors, 'access-control-allow-methods': 'POST, OPTIONS', 'access-control-allow-headers': 'Content-Type, Accept, Mcp-Session-Id, Last-Event-ID, MCP-Protocol-Version, Mcp-Method, Mcp-Name', 'access-control-max-age': '86400' });
  if (req.method === 'GET' && !String(req.headers.accept || '').toLowerCase().includes('text/event-stream')) {
    return json(res, 200, { status: 'ok', transport: 'streamable-http', message: 'Send MCP JSON-RPC requests with POST.' }, cors);
  }
  if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' }, { ...cors, allow: 'POST, OPTIONS' });
  if (!String(req.headers.accept || '').includes('application/json')) return json(res, 406, { error: 'Accept must include application/json' }, cors);
  if (!String(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) return json(res, 415, { error: 'Content-Type must be application/json' }, cors);
  let message;
    try { message = JSON.parse(await readBody(req, MAX_MCP_BODY)); }
  catch (e) { return json(res, 400, rpcError(null, -32700, e.message), cors); }
  const id = message.id;
  if (message.jsonrpc !== '2.0' || typeof message.method !== 'string') return json(res, 400, rpcError(id, -32600, 'Invalid Request'), cors);
  const meta = message.params?._meta || {};
  const metaVersion = meta['io.modelcontextprotocol/protocolVersion'];
  const versionHeader = req.headers['mcp-protocol-version'];
  const requestedVersion = metaVersion || versionHeader || (message.method === 'initialize' ? message.params?.protocolVersion : '2025-03-26');
  const modern = requestedVersion === MODERN_MCP_VERSION;
  if (modern) {
    if (versionHeader !== metaVersion) return json(res, 400, rpcError(id, -32020, 'Header mismatch: MCP-Protocol-Version must match request metadata.'), cors);
    if (req.headers['mcp-method'] !== message.method) return json(res, 400, rpcError(id, -32020, 'Header mismatch: Mcp-Method must match the request method.'), cors);
    if (message.method === 'tools/call' && req.headers['mcp-name'] !== message.params?.name) return json(res, 400, rpcError(id, -32020, 'Header mismatch: Mcp-Name must match the tool name.'), cors);
    if (!meta['io.modelcontextprotocol/clientCapabilities'] || !meta['io.modelcontextprotocol/clientInfo']) return json(res, 400, rpcError(id, -32021, 'Modern MCP requests must include client capabilities and client identity.'), cors);
  }
  if (!MCP_VERSIONS.has(requestedVersion)) {
    const error = rpcError(id, -32022, 'Unsupported protocol version', { supported: MCP_SUPPORTED_VERSIONS, requested: requestedVersion });
    return json(res, 400, error, cors);
  }
  if (versionHeader && metaVersion && versionHeader !== metaVersion) return json(res, 400, rpcError(id, -32020, 'Header mismatch: MCP-Protocol-Version must match request metadata.'), cors);
  if (versionHeader) res.setHeader('MCP-Protocol-Version', versionHeader);
  if (message.method.startsWith('notifications/')) { res.writeHead(202, cors); res.end(); return; }
  try {
    let result;
    switch (message.method) {
      case 'server/discover': {
        if (!modern) return json(res, 404, rpcError(id, -32601, 'Method not found: server/discover'), cors);
        result = { resultType: 'complete', supportedVersions: MCP_SUPPORTED_VERSIONS, capabilities: { tools: {} }, _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'local-project-mcp-bridge', version: APP_VERSION } }, instructions: 'Local MCP Studio 文件工具只操作当前选择的项目目录。开发模式还会开放完整 REA 6.8.0 MCP 工具集；REA 工具根据其参数指定目标，可能执行目标运行时操作。', ttlMs: 30000, cacheScope: 'private' };
        break;
      }
      case 'initialize': {
        const requested = message.params?.protocolVersion;
        const protocolVersion = MCP_VERSIONS.has(requested) && requested !== MODERN_MCP_VERSION ? requested : '2025-11-25';
        result = { protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'local-project-mcp-bridge', version: APP_VERSION }, instructions: 'Local MCP Studio 文件工具只操作当前选择的项目目录。REA 6.8.0 MCP 工具仅在开发模式开放，目标由 REA 工具参数指定，并可能执行目标运行时操作。' };
        res.setHeader('MCP-Protocol-Version', protocolVersion);
        break;
      }
      case 'ping': {
        if (modern) return json(res, 404, rpcError(id, -32601, 'Method not found: ping'), cors);
        result = {}; break;
      }
      case 'tools/list': result = { ...(modern ? { resultType: 'complete', ttlMs: 15000, cacheScope: 'private' } : {}), tools: await toolsForPermission() }; break;
      case 'tools/call': {
        if (!message.params || typeof message.params.name !== 'string') throw new Error('tools/call 缺少工具名。');
        try {
          const output = await callTool(message.params.name, message.params.arguments || {});
          if (output && typeof output === 'object' && 'isError' in output) result = modern && !('resultType' in output) ? { ...output, resultType: 'complete' } : output;
          else result = { ...(modern ? { resultType: 'complete' } : {}), content: [{ type: 'text', text: typeof output === 'string' ? output : JSON.stringify(output, null, 2) }], structuredContent: typeof output === 'object' && output !== null ? output : { result: output }, isError: false };
          log(`工具调用：${message.params.name}`, 'tool');
        } catch (e) {
          log(`${message.params.name}: ${e.message}`, 'error');
          result = { ...(modern ? { resultType: 'complete' } : {}), content: [{ type: 'text', text: e.message }], isError: true };
        }
        break;
      }
      default: return json(res, modern ? 404 : 200, rpcError(id, -32601, `Method not found: ${message.method}`), cors);
    }
    return json(res, 200, { jsonrpc: '2.0', id: id ?? null, result }, cors);
  } catch (e) {
    log(e.message, 'error');
    return json(res, 200, rpcError(id, -32603, e.message), cors);
  }
}

function isLocalHost(req) {
  const host = String(req.headers.host || '').toLowerCase().split(':')[0];
  return ['127.0.0.1', 'localhost', '[::1]'].includes(host);
}

function readOnlyJson(req, res, status, value) {
  if (req.headers.origin && !['http://127.0.0.1:43127', `http://127.0.0.1:${state.port}`, `http://localhost:${state.port}`].includes(req.headers.origin)) return json(res, 403, { error: 'origin denied' });
  return json(res, status, value, { 'access-control-allow-origin': req.headers.origin || `http://127.0.0.1:${state.port}`, 'access-control-allow-headers': 'Content-Type', 'access-control-allow-methods': 'GET, POST, OPTIONS' });
}

async function pickFolder() {
  if (process.platform !== 'win32') return null;
  const script = `$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Windows.Forms; $d=New-Object System.Windows.Forms.FolderBrowserDialog; $d.Description='选择要授权给 ChatGPT 的项目目录'; $d.ShowNewFolderButton=$false; if($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK){[Console]::Write($d.SelectedPath)}`;
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-STA', '-Command', script], { windowsHide: true, shell: false });
    let out = ''; let err = '';
    child.stdout.on('data', b => out += b.toString()); child.stderr.on('data', b => err += b.toString());
    child.on('error', reject); child.on('close', code => code === 0 ? resolve(out.trim()) : reject(new Error(err || '无法打开目录选择器。')));
  });
}

async function stopTunnel() {
  await stopReaServer();
  const child = state.tunnelProcess;
  const sshClient = state.sshClient;
  state.tunnelProcess = null;
  state.sshClient = null;
  state.tunnelUrl = null;
  state.token = null;
  if (sshClient) {
    const closed = new Promise(resolve => sshClient.once('close', resolve));
    sshClient.end();
    let timer;
    await Promise.race([closed, new Promise(resolve => { timer = setTimeout(resolve, 2500); })]);
    clearTimeout(timer);
  }
  if (child && child.exitCode === null) {
    const closed = new Promise(resolve => child.once('close', resolve));
    child.kill();
    let timer;
    await Promise.race([closed, new Promise(resolve => { timer = setTimeout(resolve, 2500); })]);
    clearTimeout(timer);
  }
  return true;
}

async function findOrDownloadCloudflared() {
  await fsp.mkdir(CACHE_DIR, { recursive: true });
  const packagedAsar = Boolean(process.resourcesPath && fs.existsSync(path.join(process.resourcesPath, 'app.asar')));
  const bundled = packagedAsar
    ? path.join(process.resourcesPath, 'app.asar.unpacked', 'assets', 'cloudflared.exe')
    : path.join(ROOT_DIR, 'assets', 'cloudflared.exe');
  const candidates = [bundled, path.join(ROOT_DIR, 'cloudflared.exe'), path.join(CACHE_DIR, 'cloudflared.exe')];
  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) continue;
    if (candidate === bundled) {
      const digest = crypto.createHash('sha256').update(await fsp.readFile(candidate)).digest('hex');
      if (digest !== CLOUDFLARED_SHA256) throw new Error('内置 cloudflared 校验失败，请重新安装 Local MCP Studio。');
      log(`使用内置 Cloudflare cloudflared ${CLOUDFLARED_VERSION}（SHA-256 ${digest}）。`);
    }
    return candidate;
  }
  const where = await new Promise(resolve => {
    const p = spawn('where.exe', ['cloudflared'], { windowsHide: true, shell: false });
    let out = ''; p.stdout.on('data', b => out += b.toString()); p.on('close', code => resolve(code === 0 ? out.trim().split(/\r?\n/)[0] : null)); p.on('error', () => resolve(null));
  });
  if (where) return where;
  const target = path.join(CACHE_DIR, 'cloudflared.exe');
  const temporary = `${target}.${process.pid}.download`;
  log(`未找到内置 cloudflared，尝试从 Cloudflare 官方发布地址下载 ${CLOUDFLARED_VERSION}…`);
  try {
    const response = await fetch(CLOUDFLARED_DOWNLOAD_URL, { redirect: 'follow', signal: AbortSignal.timeout(60000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length < 1_000_000) throw new Error('下载文件异常，未保存。');
    const digest = crypto.createHash('sha256').update(buffer).digest('hex');
    if (digest !== CLOUDFLARED_SHA256) throw new Error('SHA-256 与 Cloudflare 官方发布校验值不匹配，已拒绝保存。');
    await fsp.writeFile(temporary, buffer);
    await fsp.rename(temporary, target).catch(async error => {
      if (error.code !== 'EEXIST' && error.code !== 'EPERM') throw error;
      await fsp.rm(target, { force: true });
      await fsp.rename(temporary, target);
    });
    log(`cloudflared ${CLOUDFLARED_VERSION} 已保存（SHA-256 ${digest}）。`);
    return target;
  } catch (error) {
    await fsp.rm(temporary, { force: true }).catch(() => {});
    throw new Error(`无法下载 cloudflared ${CLOUDFLARED_VERSION}：${error.message}。请重新安装包含内置 cloudflared 的版本，或手动安装 cloudflared 后重试。`);
  }
}

function startTunnelProcess(binary) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, ['tunnel', '--protocol', 'http2', '--url', `http://${HOST}:${state.port}`, '--no-autoupdate'], { windowsHide: true, shell: false, cwd: CACHE_DIR });
    state.tunnelProcess = child;
    let settled = false;
    let tunnelUrl = null;
    let edgeRegistered = false;
    let partialLine = '';
    let startupTimer;
    const checkReady = () => {
      if (settled || !tunnelUrl || !edgeRegistered) return;
      settled = true;
      clearTimeout(startupTimer);
      log('Cloudflare Edge 已注册；隧道已就绪。', 'success');
      resolve(tunnelUrl);
    };
    const inspect = (chunk) => {
      const text = chunk.toString();
      state.tunnelBuffer = (state.tunnelBuffer + text).slice(-30000);
      partialLine += text;
      const lines = partialLine.split(/\r?\n/);
      partialLine = lines.pop() || '';
      for (const line of lines) {
        log(line, 'tunnel');
        const match = line.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
        if (match) tunnelUrl = match[0];
        if (/Registered tunnel connection/i.test(line)) edgeRegistered = true;
      }
      checkReady();
    };
    child.stdout.on('data', inspect); child.stderr.on('data', inspect);
    child.on('error', e => { if (!settled) { settled = true; reject(e); } else log(e.message, 'error'); });
    child.on('close', code => { if (state.tunnelProcess === child) { state.tunnelProcess = null; state.tunnelUrl = null; state.token = null; }
      if (!settled) { settled = true; clearTimeout(startupTimer); reject(new Error(`cloudflared 未能注册到 Cloudflare Edge（退出码 ${code}）。请检查网络或防火墙是否允许访问 TCP 7844。`)); } else log(`公网隧道已关闭（退出码 ${code}）。`, 'tunnel');
    });
    startupTimer = setTimeout(() => { if (!settled) { settled = true; reject(new Error('45 秒内未能连接 Cloudflare Edge。请检查网络/防火墙是否允许 TCP 7844 出站，再重试。')); child.kill(); } }, 45000);
    startupTimer.unref();
  });
}

async function startSelfHostedTunnel() {
  const settings = await loadAppSettings();
  const config = settings.selfHosted;
  if (!config.host || !config.username || !config.publicUrl || !config.hostFingerprint) throw new Error('请先填写自有服务器地址、HTTPS 地址、SSH 用户，并验证服务器指纹后保存。');
  const privateKey = await fsp.readFile(SSH_PRIVATE_KEY_FILE, 'utf8');
  const conn = new SSHClient();
  return new Promise((resolve, reject) => {
    let settled = false;
    let observedFingerprint = '';
    let startupTimer;
    const finishError = error => {
      if (settled) return;
      settled = true;
      clearTimeout(startupTimer);
      conn.end();
      const normalizedSaved = normalizedFingerprint(config.hostFingerprint);
      if (!normalizedSaved && observedFingerprint) {
        const trustError = new Error(`首次连接需要核对 SSH 主机指纹：SHA256:${observedFingerprint}`);
        trustError.hostFingerprint = observedFingerprint;
        reject(trustError);
      } else if (normalizedSaved && observedFingerprint && observedFingerprint !== normalizedSaved) {
        reject(new Error('SSH 主机指纹与已保存的信任值不一致，已拒绝连接。'));
      } else reject(new Error(`SSH 连接失败：${error?.message || '请检查服务器、端口、用户名和公钥授权。'}`));
    };
    conn.on('ready', () => {
      conn.on('tcp connection', (_info, accept, rejectForward) => {
        if (state.sshClient !== conn) { rejectForward(); return; }
        const channel = accept();
        const local = net.createConnection({ host: HOST, port: state.port });
        local.once('connect', () => channel.pipe(local).pipe(channel));
        local.once('error', () => channel.destroy());
        channel.once('error', () => local.destroy());
      });
      conn.forwardIn('127.0.0.1', config.remotePort, error => {
        if (error) return finishError(error);
        settled = true;
        clearTimeout(startupTimer);
        state.sshClient = conn;
        state.connectionMode = 'selfHosted';
        state.tunnelUrl = config.publicUrl;
        state.token = settings.stableMcpToken;
        log(`已建立到自有服务器 ${config.host} 的 SSH 反向转发（127.0.0.1:${config.remotePort}）。`, 'success');
        resolve(config.publicUrl);
      });
    });
    conn.on('error', error => {
      if (!settled) finishError(error);
      else if (state.sshClient === conn) {
        state.sshClient = null; state.tunnelUrl = null; state.token = null;
        log(`自有服务器 SSH 连接中断：${error.message}`, 'error');
      }
    });
    conn.on('close', () => {
      if (state.sshClient === conn) {
        state.sshClient = null; state.tunnelUrl = null; state.token = null;
        log('自有服务器连接已关闭。', 'tunnel');
      }
      if (!settled) finishError(new Error('连接在启动前关闭。'));
    });
    startupTimer = setTimeout(() => finishError(new Error('连接服务器超时。')), 30000);
    startupTimer.unref();
    conn.connect({
      host: config.host,
      port: config.port,
      username: config.username,
      privateKey,
      hostHash: 'sha256',
      hostVerifier: hash => {
        observedFingerprint = sshFingerprintFromHash(hash);
        return observedFingerprint === normalizedFingerprint(config.hostFingerprint);
      },
      readyTimeout: 20000,
      keepaliveInterval: 30000,
      keepaliveCountMax: 3,
    });
  });
}

async function api(req, res, url) {
  if (!isLocalHost(req)) return json(res, 403, { error: 'local UI only' });
  if (req.method === 'OPTIONS') return readOnlyJson(req, res, 204, {});
  const send = (code, value) => readOnlyJson(req, res, code, value);
  if (url.pathname === '/api/state' && req.method === 'GET') {
    const settings = await loadAppSettings();
    const mode = state.tunnelUrl ? state.connectionMode : settings.connectionMode;
    const tunnelUrl = state.tunnelUrl || (mode === 'selfHosted' ? settings.selfHosted.publicUrl || null : null);
    const mcpUrl = state.tunnelUrl && state.token
      ? `${state.tunnelUrl}/mcp/${state.token}`
      : mode === 'selfHosted' && settings.selfHosted.publicUrl
        ? `${settings.selfHosted.publicUrl}/mcp/${settings.stableMcpToken}`
        : null;
    return send(200, {
      projectRoot: state.projectRoot, permission: state.permission, connected: Boolean(state.tunnelUrl), connectionMode: mode, tunnelUrl, mcpUrl,
      logs: state.logs.slice(-80), tools: localToolsForPermission().map(t => t.name),
      rea: { ...reaPackageInfo(), running: Boolean(reaBridge.child && reaBridge.child.exitCode === null), loadedToolCount: reaBridge.tools.length, error: reaBridge.lastError || reaPackageInfo().error },
    });
  }
  if (url.pathname === '/api/server-config' && req.method === 'GET') {
    try { return send(200, await getServerConfig()); } catch (e) { return send(500, { error: e.message }); }
  }
  if (url.pathname === '/api/server-config' && req.method === 'POST') {
    try {
      if (state.tunnelUrl) throw new Error('请先停止公网连接，再修改服务器设置。');
      const body = JSON.parse(await readBody(req));
      const config = validateSelfHostedSettings(body);
      const settings = await loadAppSettings();
      settings.selfHosted = config;
      settings.connectionMode = 'selfHosted';
      await saveAppSettings(settings);
      state.connectionMode = 'selfHosted';
      log(`自有服务器设置已保存：${config.host || '未填写服务器'}；SSH 指纹已${config.hostFingerprint ? '固定' : '留空'}。`);
      return send(200, await getServerConfig());
    } catch (e) { return send(400, { error: e.message }); }
  }
  if (url.pathname === '/api/connection-mode' && req.method === 'POST') {
    try {
      if (state.tunnelUrl) throw new Error('请先停止公网连接，再切换连接方式。');
      const body = JSON.parse(await readBody(req));
      if (!['quick', 'selfHosted'].includes(body.mode)) throw new Error('连接方式无效。');
      const settings = await loadAppSettings();
      settings.connectionMode = body.mode;
      await saveAppSettings(settings);
      state.connectionMode = body.mode;
      return send(200, { connectionMode: body.mode });
    } catch (e) { return send(400, { error: e.message }); }
  }
  if (url.pathname === '/api/reset-link' && req.method === 'POST') {
    try {
      const settings = await loadAppSettings();
      const mode = state.tunnelUrl ? state.connectionMode : settings.connectionMode;
      if (mode !== 'selfHosted') throw new Error('只有自有服务器固定地址支持重置链接。');
      settings.stableMcpToken = crypto.randomBytes(32).toString('hex');
      await saveAppSettings(settings);
      if (state.tunnelUrl && state.connectionMode === 'selfHosted') state.token = settings.stableMcpToken;
      const tunnelUrl = state.tunnelUrl && state.connectionMode === 'selfHosted' ? state.tunnelUrl : settings.selfHosted.publicUrl || null;
      log('固定 MCP 链接已重置；旧链接已失效。', 'success');
      return send(200, { tunnelUrl, mcpUrl: tunnelUrl ? `${tunnelUrl}/mcp/${settings.stableMcpToken}` : null, connected: Boolean(state.tunnelUrl) });
    } catch (e) { return send(400, { error: e.message }); }
  }
  if (url.pathname === '/api/server-probe' && req.method === 'POST') {
    try {
      const body = JSON.parse(await readBody(req));
      const host = String(body.host || '').trim();
      const port = Number(body.port || 22);
      if (!(net.isIP(host) || /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(host))) throw new Error('请填写有效的服务器 IP 或主机名。');
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('SSH 端口必须在 1 到 65535 之间。');
      const fingerprint = await probeSSHHost(host, port);
      return send(200, { fingerprint: `SHA256:${sshFingerprintFromHash(fingerprint)}` });
    } catch (e) { return send(400, { error: e.message }); }
  }
  if (url.pathname === '/api/pick-folder' && req.method === 'POST') {
    try { const selected = await pickFolder(); return send(200, { path: selected }); } catch (e) { return send(500, { error: e.message }); }
  }
  if (url.pathname === '/api/connect' && req.method === 'POST') {
    try {
      if (state.tunnelUrl) return send(200, { tunnelUrl: state.tunnelUrl, mcpUrl: `${state.tunnelUrl}/mcp/${state.token}`, connectionMode: state.connectionMode });
      const body = JSON.parse(await readBody(req));
      const candidate = path.resolve(String(body.projectRoot || ''));
      const stat = await fsp.stat(candidate);
      if (!stat.isDirectory()) throw new Error('项目路径必须是目录。');
      const projectRoot = await fsp.realpath(candidate);
      const permission = ['read', 'edit', 'dev'].includes(body.permission) ? body.permission : 'read';
      state.projectRoot = projectRoot;
      state.permission = permission;
      state.tunnelBuffer = '';
      const settings = await loadAppSettings();
      const mode = body.connectionMode === 'selfHosted' ? 'selfHosted' : 'quick';
      state.connectionMode = mode;
      if (mode === 'quick') state.token = crypto.randomBytes(32).toString('hex');
      log(`项目已授权：${state.projectRoot}；权限级别：${state.permission}`);
      if (mode === 'selfHosted') {
        const tunnelUrl = await startSelfHostedTunnel();
        log(`固定 MCP 地址已恢复：${tunnelUrl}/mcp/[已隐藏]`, 'success');
        return send(200, { tunnelUrl, mcpUrl: `${tunnelUrl}/mcp/${settings.stableMcpToken}`, permission: state.permission, connectionMode: mode });
      }
      const binary = await findOrDownloadCloudflared();
      const tunnelUrl = await startTunnelProcess(binary);
      state.tunnelUrl = tunnelUrl;
      log(`MCP 地址已就绪：${tunnelUrl}/mcp/[已隐藏]`, 'success');
      return send(200, { tunnelUrl, mcpUrl: `${tunnelUrl}/mcp/${state.token}`, permission: state.permission, connectionMode: mode });
    } catch (e) {
      log(e.message, 'error'); await stopTunnel();
      return send(500, { error: e.message, ...(e.hostFingerprint ? { hostFingerprint: `SHA256:${e.hostFingerprint}` } : {}) });
    }
  }
  if (url.pathname === '/api/disconnect' && req.method === 'POST') { await stopTunnel(); log('连接已停止；稳定地址保持不变，当前暂时不可访问。'); return send(200, { stopped: true }); }
  if (url.pathname === '/api/clear-logs' && req.method === 'POST') { state.logs = []; return send(200, { cleared: true }); }
  if (url.pathname === '/api/shutdown' && req.method === 'POST') {
    if (process.env.WEXRUN_DESKTOP !== '1') return send(403, { error: 'desktop shutdown only' });
    setTimeout(() => stopServer().finally(() => process.exit(0)), 250).unref();
    return send(202, { stopping: true });
  }
  if (url.pathname === '/api/permission' && req.method === 'POST') {
    try {
      const body = JSON.parse(await readBody(req));
      if (!['read', 'edit', 'dev'].includes(body.permission)) throw new Error('权限选项无效。');
      if (state.tunnelUrl) throw new Error('请先停止连接，再更改权限并重新连接。');
      state.permission = body.permission;
      return send(200, { permission: state.permission, tools: localToolsForPermission().map(t => t.name), rea: reaPackageInfo() });
    } catch (e) { return send(400, { error: e.message }); }
  }
  return send(404, { error: 'not found' });
}

let server = null;

function startServer(options = {}) {
  if (server?.listening) return Promise.resolve({ server, port: state.port });
  state.port = Number.isInteger(options.port) ? options.port : DEFAULT_PORT;
  server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (url.pathname.startsWith('/mcp/')) return handleMcp(req, res);
    if (url.pathname.startsWith('/api/')) return api(req, res, url);
    if (!isLocalHost(req)) return json(res, 403, { error: 'local UI only' });
    let pathname = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
    const file = path.resolve(UI_DIR, `.${pathname}`);
    if (!isWithin(UI_DIR, file)) return json(res, 404, { error: 'not found' });
    try {
      const data = await fsp.readFile(file);
      const type = file.endsWith('.css') ? 'text/css; charset=utf-8' : file.endsWith('.js') ? 'text/javascript; charset=utf-8' : file.endsWith('.svg') ? 'image/svg+xml; charset=utf-8' : 'text/html; charset=utf-8';
      res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'" }); res.end(data);
    } catch { json(res, 404, { error: 'not found' }); }
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(state.port, HOST, () => {
      state.port = server.address().port;
      log(`本地控制台：http://${HOST}:${state.port}`);
      const openBrowser = options.openBrowser ?? process.env.WEXRUN_NO_BROWSER !== '1';
      if (openBrowser && process.platform === 'win32') {
        const child = spawn('cmd.exe', ['/c', 'start', '', `http://${HOST}:${state.port}`], { windowsHide: true, stdio: 'ignore' });
        child.unref();
      }
      resolve({ server, port: state.port });
    });
  });
}

async function stopServer() {
  if (state.stopping) return state.stopping;
  state.stopping = (async () => {
    await stopTunnel();
    const stops = [];
    for (const job of state.jobs.values()) {
      if (job.state === 'running') {
        stops.push(new Promise(resolve => {
          const timer = setTimeout(resolve, 1800);
          job.child.once('close', () => { clearTimeout(timer); resolve(); });
          stopJob(job);
        }));
      }
    }
    await Promise.all(stops);
    if (server?.listening) await new Promise(resolve => server.close(resolve));
    server = null;
    state.stopping = null;
  })();
  return state.stopping;
}

if (require.main === module) {
  startServer().catch(error => { log(error.message, 'error'); process.exitCode = 1; });
  process.on('SIGINT', () => stopServer().finally(() => process.exit(0)));
  process.on('SIGTERM', () => stopServer().finally(() => process.exit(0)));
}

module.exports = { startServer, stopServer, state };
