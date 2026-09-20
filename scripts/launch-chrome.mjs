/**
 * 用独立 profile 启动一个带调试端口的 Chrome/Edge，不影响日常浏览器。
 * 首次启动后需要在这个窗口里登录一次 B 站，之后 profile 会记住。
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, platform } from 'node:os';

const PORT = Number(process.env.CDP_PORT || 9222);
const PROFILE = process.env.CDP_PROFILE || join(homedir(), '.bili-station', 'chrome-profile');

const CANDIDATES = {
  win32: [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    join(homedir(), 'AppData/Local/Google/Chrome/Application/chrome.exe'),
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  ],
  darwin: [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  ],
  linux: ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge'],
};

const found = (CANDIDATES[platform()] ?? []).find((p) => existsSync(p));
if (!found) {
  console.error('没找到 Chrome / Edge。请用环境变量指定：CHROME_PATH="完整路径" npm run chrome');
  process.exit(1);
}
const exe = process.env.CHROME_PATH || found;

mkdirSync(PROFILE, { recursive: true });

const args = [
  '--remote-debugging-port=' + PORT,
  '--user-data-dir=' + PROFILE,
  '--no-first-run',
  '--no-default-browser-check',
  'https://space.bilibili.com/',
];

console.log('');
console.log('  启动： ' + exe);
console.log('  端口： ' + PORT);
console.log('  档案： ' + PROFILE + '（独立 profile，和你日常的 Chrome 互不干扰）');
console.log('');
console.log('  如果是第一次，请在打开的窗口里登录一次 B 站，然后回到整理台点「连接 Chrome」。');
console.log('');

const child = spawn(exe, args, { detached: true, stdio: 'ignore' });
child.unref();
