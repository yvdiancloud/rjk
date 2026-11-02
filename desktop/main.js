const path = require('node:path');
const { app, BrowserWindow, shell, dialog, screen } = require('electron');

const APP_ID = 'com.localmcp.studio';
let mainWindow = null;
let backend = null;
let allowQuit = false;
let quitStarted = false;

app.setAppUserModelId(APP_ID);
const hasSingleInstance = app.requestSingleInstanceLock();
if (!hasSingleInstance) app.quit();
else app.on('second-instance', () => {
  if (mainWindow?.isMinimized()) mainWindow.restore();
  mainWindow?.show();
  mainWindow?.focus();
});

function openExternalIfSafe(rawUrl) {
  try {
    const url = new URL(rawUrl);
    if (url.protocol === 'https:' && (url.hostname === 'chatgpt.com' || url.hostname.endsWith('.chatgpt.com'))) {
      shell.openExternal(url.href);
      return true;
    }
  } catch {}
  return false;
}

function createWindow(port) {
  const origin = `http://127.0.0.1:${port}`;
  const workArea = screen.getPrimaryDisplay().workAreaSize;
  const width = Math.min(1480, Math.max(980, workArea.width - 72));
  const height = Math.min(980, Math.max(700, workArea.height - 72));
  mainWindow = new BrowserWindow({
    width,
    height,
    minWidth: 820,
    minHeight: 640,
    show: false,
    backgroundColor: '#f7f4f1',
    autoHideMenuBar: true,
    icon: path.join(__dirname, '..', 'assets', 'app.ico'),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
    },
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    openExternalIfSafe(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (url !== origin && !url.startsWith(`${origin}/`)) {
      event.preventDefault();
      openExternalIfSafe(url);
    }
  });
  mainWindow.once('ready-to-show', () => mainWindow?.show());
  mainWindow.on('closed', () => { mainWindow = null; });
  mainWindow.loadURL(`${origin}/`);
}

if (hasSingleInstance) app.whenReady().then(async () => {
  const dataDir = process.env.PORTABLE_EXECUTABLE_DIR
    ? path.join(process.env.PORTABLE_EXECUTABLE_DIR, 'LocalMCPData')
    : app.getPath('userData');
  process.env.WEXRUN_DATA_DIR = dataDir;
  backend = require('../src/main');
  const { port } = await backend.startServer({ port: 43127, openBrowser: false });
  createWindow(port);
  app.on('activate', () => { if (!mainWindow) createWindow(port); });
}).catch(async error => {
  dialog.showErrorBox('Local MCP Studio 启动失败', error.stack || error.message || String(error));
  if (backend?.stopServer) await backend.stopServer().catch(() => {});
  app.quit();
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', event => {
  if (allowQuit || quitStarted) return;
  event.preventDefault();
  quitStarted = true;
  Promise.resolve(backend?.stopServer?.()).catch(() => {}).finally(() => {
    allowQuit = true;
    app.quit();
  });
});
