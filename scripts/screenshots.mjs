// 기획서용 캡처: 375px 모바일 화면을 크롬 DevTools 프로토콜로 찍는다. 별도 설치 없음(Node 22+).
// 사용: 로컬 서버를 띄운 뒤  node scripts/screenshots.mjs [기준주소]
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = process.argv[2] || 'http://127.0.0.1:8788';
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'screenshots');
const PORT = 9333;

const SHOTS = [
  ['01_공연선택.png', '#/'],
  ['02_방면선택.png', '#/dir'],
  ['03_버스카드.png', '#/go/bus-machon'],
  ['04_지하철카드.png', '#/go/subway-olympic'],
  ['상태_첫버스놓침.png', '#/go/bus-gangbyeon'],
  ['상태_서두르면가능.png', '?s=hurry#/go/bus-gangbyeon'],
  ['상태_막차이후.png', '?s=ended#/go/bus-machon'],
  ['상태_조회실패.png', '?s=fail#/go/bus-machon'],
  ['지하철_한성백제역.png', '#/go/subway-hanseong'],
  ['자가용_준비중.png', '#/car'],
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

mkdirSync(OUT, { recursive: true });
const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--hide-scrollbars', `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${mkdtempSync(join(tmpdir(), 'shot-'))}`, 'about:blank',
], { stdio: 'ignore' });

let wsUrl;
for (let i = 0; i < 50 && !wsUrl; i++) {
  await sleep(200);
  try {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    wsUrl = list.find((t) => t.type === 'page')?.webSocketDebuggerUrl;
  } catch {}
}
if (!wsUrl) { chrome.kill(); throw new Error('크롬 연결 실패'); }

const ws = new WebSocket(wsUrl);
await new Promise((r) => ws.addEventListener('open', r));
let id = 0;
const pending = new Map();
ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
});
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const n = ++id;
  pending.set(n, (m) => (m.error ? reject(new Error(m.error.message)) : resolve(m.result)));
  ws.send(JSON.stringify({ id: n, method, params }));
});
const evaluate = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result.value;

await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 375, height: 812, deviceScaleFactor: 2, mobile: true });

for (const [file, path] of SHOTS) {
  await send('Page.navigate', { url: `${BASE}/${path}` });
  // 지도 타일이 다 뜰 때까지(최대 10초) 기다린다
  for (let i = 0; i < 50; i++) {
    await sleep(200);
    const ready = await evaluate(`(() => {
      if (!document.querySelector('#app h1, #app .card')) return false;
      const tiles = [...document.querySelectorAll('.leaflet-tile')];
      if (!document.getElementById('map')) return true;
      return tiles.length > 0 && tiles.every(t => t.complete);
    })()`).catch(() => false);
    if (ready) break;
  }
  await sleep(400);
  const h = await evaluate('Math.ceil(document.documentElement.scrollHeight)');
  await send('Emulation.setDeviceMetricsOverride', { width: 375, height: Math.max(812, h), deviceScaleFactor: 2, mobile: true });
  await sleep(300);
  const { data } = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(OUT, file), Buffer.from(data, 'base64'));
  await send('Emulation.setDeviceMetricsOverride', { width: 375, height: 812, deviceScaleFactor: 2, mobile: true });
  console.log(file, `375x${h}`);
}
ws.close();
chrome.kill();
