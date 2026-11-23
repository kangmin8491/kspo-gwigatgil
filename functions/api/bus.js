// Cloudflare Pages Function: GET /api/bus?dir=machon|gangbyeon
// 서울시 버스도착정보(getArrInfoByRoute)를 대신 호출해 3214번 도착 예정만 정리해 돌려준다.
// 인증키는 환경변수 SEOUL_BUS_SERVICE_KEY에서만 읽고, 응답·로그에 절대 넣지 않는다.

const ROUTE_ID = '100100213'; // 3214
const STOPS = {
  machon: { stId: '123000154', ord: '44', ars: '24244' },
  gangbyeon: { stId: '123000155', ord: '17', ars: '24245' },
};
const CACHE_SEC = 30;
const TIMEOUT_MS = 8000;
// https는 시간 초과가 나서 http로 호출한다 (2026-11-24 확인).
const ENDPOINT = 'http://ws.bus.go.kr/api/rest/arrive/getArrInfoByRoute';

const memory = new Map(); // isolate 안 메모리 캐시: dir -> { at, body }

function json(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': `public, max-age=${CACHE_SEC}`,
      ...extra,
    },
  });
}

// "2026-11-24 01:17:10.0" (KST) -> "2026-11-24T01:17:10+09:00"
function kstIso(mkTm) {
  const m = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})/.exec(mkTm || '');
  return m ? `${m[1]}T${m[2]}+09:00` : null;
}

function bus(item, n) {
  const msg = (item[`arrmsg${n}`] || '').trim();
  const t = parseInt(item[`traTime${n}`], 10);
  let sec = null;
  if (t > 0) sec = t;
  else if (msg.includes('곧 도착')) sec = 0;
  return { msg, sec, isLast: item[`isLast${n}`] === '1' };
}

export function normalize(payload) {
  const header = payload && payload.msgHeader;
  if (!header || String(header.headerCd) !== '0') {
    return { ok: false, reason: header ? `headerCd ${header.headerCd}` : 'no header' };
  }
  let list = payload.msgBody && payload.msgBody.itemList;
  if (list && !Array.isArray(list)) list = [list];
  const item = list && list[0];
  if (!item) return { ok: false, reason: 'no item' };
  const b1 = bus(item, 1);
  const b2 = bus(item, 2);
  return {
    ok: true,
    ars: item.arsId,
    mkTm: kstIso(item.mkTm),
    firstTm: item.firstTm || null,
    lastTm: item.lastTm || null,
    term: item.term ? parseInt(item.term, 10) : null,
    ended: b1.msg.includes('운행종료'),
    buses: [b1, b2].filter((b) => b.msg && !b.msg.includes('운행종료')),
  };
}

async function callApi(key, stop) {
  const qs = new URLSearchParams({
    serviceKey: key,
    stId: stop.stId,
    busRouteId: ROUTE_ID,
    ord: stop.ord,
    resultType: 'json',
  });
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${ENDPOINT}?${qs}`, { signal: ctrl.signal });
    if (!res.ok) return { ok: false, reason: `http ${res.status}` };
    const text = await res.text();
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      // 키 오류 등은 XML로 올 수 있다. 본문은 돌려주지 않는다.
      return { ok: false, reason: 'not json' };
    }
    return normalize(payload);
  } catch (e) {
    return { ok: false, reason: e.name === 'AbortError' ? 'timeout' : 'network' };
  } finally {
    clearTimeout(timer);
  }
}

export async function onRequestGet({ request, env, waitUntil }) {
  const dir = new URL(request.url).searchParams.get('dir');
  const stop = STOPS[dir];
  if (!stop) return json({ ok: false, reason: 'unknown dir' }, 400, { 'cache-control': 'no-store' });

  const now = Date.now();
  const hit = memory.get(dir);
  if (hit && now - hit.at < CACHE_SEC * 1000) {
    return json({ ...hit.body, cached: true, fetchedAt: new Date(hit.at).toISOString() });
  }

  // 같은 데이터센터의 다른 isolate와 나누는 캐시 (커스텀 도메인에서 동작)
  const cacheKey = new Request(`https://cache.internal/api/bus/${dir}`);
  const edge = typeof caches !== 'undefined' ? caches.default : null;
  if (edge) {
    const cachedRes = await edge.match(cacheKey).catch(() => null);
    if (cachedRes) return cachedRes;
  }

  const key = env.SEOUL_BUS_SERVICE_KEY;
  if (!key) return json({ ok: false, reason: 'no key configured' }, 503, { 'cache-control': 'no-store' });

  const body = await callApi(key, stop);
  if (!body.ok) {
    // 실패는 캐시하지 않는다. 사유만 남기고 키·주소는 로그에 쓰지 않는다.
    console.log(`bus api fail dir=${dir} reason=${body.reason}`);
    return json(body, 502, { 'cache-control': 'no-store' });
  }
  memory.set(dir, { at: now, body });
  const res = json({ ...body, cached: false, fetchedAt: new Date(now).toISOString() });
  if (edge) waitUntil(edge.put(cacheKey, res.clone()).catch(() => {}));
  return res;
}
