// 화면 캡처: node scripts/screenshots.mjs [기준주소] [저장 폴더] [파일 이름 일부]  (Google Chrome, Node 22+, 2배율)
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = process.argv[2] || 'http://127.0.0.1:8788';
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const OUT = process.argv[3] || join(dirname(fileURLToPath(import.meta.url)), '..', 'screenshots');
const PORT = 9334;
// [파일, 주소, 색 모드, 동작, 폭, 높이]  동작: 'fold' 시트 접기, 'more' 지도 앱 링크까지 스크롤, 숫자 = 그 순서의 h2가 보이게 시트 스크롤
const SHOTS = [
  ['01_방면선택.png', '#/', 'dark'],
  ['방면선택_지도앱링크.png', '#/', 'dark', 'more'],
  ['02_버스_마천동.png', '#/go/bus-machon', 'dark'],
  ['03_버스_길어느쪽.png', '#/go/bus-machon', 'dark', 0],
  ['04_지하철_올림픽공원역.png', '#/go/subway-olympic', 'dark'],
  ['05_공연선택.png', '#/event', 'dark'],
  ['버스_강변역_첫버스놓침.png', '#/go/bus-gangbyeon', 'dark'],
  ['버스_강변역_길어느쪽.png', '#/go/bus-gangbyeon', 'dark', 0],
  ['버스_지도만.png', '#/go/bus-gangbyeon', 'dark', 'fold'],
  ['지하철_4번출구.png', '#/go/subway-olympic', 'dark', 0],
  ['지하철_한성백제역.png', '#/go/subway-hanseong', 'dark'],
  ['자가용_출차.png', '#/car', 'dark'],
  ['자가용_출차_동2문.png', '#/car', 'dark', 'gate'],
  ['라이트_자가용_출차.png', '#/car', 'light'],
  ['작은화면_자가용_출차.png', '#/car', 'dark', null, 360, 640],
  ['상태_서두르면가능.png', '?s=hurry#/go/bus-gangbyeon', 'dark'],
  ['상태_막차이후.png', '?s=ended#/go/bus-machon', 'dark'],
  ['상태_막차이후_방면선택.png', '?s=ended#/', 'dark'],
  ['상태_조회실패.png', '?s=fail#/go/bus-machon', 'dark'],
  ['라이트_방면선택.png', '#/', 'light'],
  ['라이트_버스_마천동.png', '#/go/bus-machon', 'light'],
  ['라이트_버스_길어느쪽.png', '#/go/bus-machon', 'light', 0],
  ['작은화면_방면선택.png', '#/', 'dark', null, 360, 640],
  ['작은화면_버스.png', '#/go/bus-machon', 'dark', null, 360, 640],
  ['넓은화면_버스.png', '#/go/bus-machon', 'dark', null, 1280, 800],
];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
mkdirSync(OUT, { recursive: true });
const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--hide-scrollbars', `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${mkdtempSync(join(tmpdir(), 'shot-'))}`, 'about:blank'], { stdio: 'ignore' });
process.on('exit', () => chrome.kill());
setTimeout(() => { console.log('시간 초과'); process.exit(1); }, 180000).unref();

let wsUrl;
for (let i = 0; i < 50 && !wsUrl; i++) {
  await sleep(200);
  try { wsUrl = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find((t) => t.type === 'page')?.webSocketDebuggerUrl; } catch {}
}
if (!wsUrl) throw new Error('크롬 연결 실패');
const ws = new WebSocket(wsUrl);
await new Promise((r) => ws.addEventListener('open', r));
let id = 0;
const pending = new Map();
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  if (m.method === 'Runtime.exceptionThrown') console.log('오류', m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
});
const send = (method, params = {}) => new Promise((res, rej) => {
  const n = ++id;
  pending.set(n, (m) => (m.error ? rej(new Error(m.error.message)) : res(m.result)));
  ws.send(JSON.stringify({ id: n, method, params }));
});
const evaluate = async (e) => (await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true })).result.value;
await send('Page.enable');
await send('Runtime.enable');
await send('Network.enable');
await send('Network.setCacheDisabled', { cacheDisabled: true });

for (const [file, q, scheme, act = null, width = 375, height = 812] of SHOTS) {
  if (process.argv[4] && !file.includes(process.argv[4])) continue;
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: width > 500 ? 1 : 2, mobile: width < 500 });
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] });
  await send('Page.navigate', { url: 'about:blank' });
  await send('Page.navigate', { url: `${BASE}/${q}` });
  for (let k = 0; k < 50; k++) {
    await sleep(200);
    if (await evaluate(`!!document.querySelector('.m-start') && !!document.querySelector('#view h1')`).catch(() => false)) break;
  }
  await evaluate('document.fonts.ready.then(() => 1)');
  if (q.includes('#/car')) await sleep(600);
  if (typeof act === 'number') await evaluate(`(() => { const v = document.getElementById('view'); v.scrollTop += v.querySelectorAll('h2')[${act}].getBoundingClientRect().top - v.getBoundingClientRect().top - 12; })()`);
  if (act === 'gate') await evaluate(`document.querySelector('[data-gate="동2문"]').click()`);
  if (act === 'more') await evaluate(`document.getElementById('more').scrollIntoView({ block: 'end' })`);
  if (act === 'fold') await evaluate(`document.getElementById('cta').click()`);
  await sleep(1300);
  const info = await evaluate(`JSON.stringify({
    font: document.fonts.check('700 16px "Pretendard Variable"', '방면'),
    over: document.documentElement.scrollWidth > innerWidth || document.getElementById('view').scrollWidth > document.getElementById('view').clientWidth,
    sheet: document.getElementById('sheet').offsetHeight, cta: document.getElementById('cta').textContent,
    scrollable: (s => s.scrollHeight - s.clientHeight)(document.getElementById('view')) })`);
  const { data } = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(OUT, file), Buffer.from(data, 'base64'));
  console.log(file, info);
}
ws.close();
process.exit(0);
