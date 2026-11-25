/* 공연 끝, 귀갓길 — 시연용 모바일 웹
 * 화면: #/ 방면 고르기 · #/go/<id> 탑승 위치 · #/event 공연 고르기 · #/car 출차 그래프
 * 주소 인자: ?mode=live (실시간), ?s=basic|hurry|ended|fail (시연 상황, 예시값)
 */
(function () {
  'use strict';

  var HURRY = 2;             // 도착 예정 − 도보 ≥ 2분이면 '탈 수 있음' (기획서 초기값)
  var REFRESH_MS = 30000;
  var STALE_MS = 5 * 60000;  // 응답이 이보다 오래되면 '조회 불가'
  var BUS_WEB = 'https://bus.go.kr/app/';
  var METRO = 'https://www.seoulmetro.co.kr/kr/cyberStation.do';

  // 걷는 방법 문장: 소스/KSPO DOME 귀가 동선표.md
  var BUS = {
    machon: { short: '공원 쪽', walk: '올림픽공원역으로 이동해 <b>공원 쪽</b>, 역 3번 출구와 같은 쪽에 섭니다. 양재대로를 건너지 않습니다.' },
    gangbyeon: { short: '길 건너 1번 출구 쪽', walk: '올림픽공원역 쪽에서 <b>양재대로의 신호 횡단보도를 건너</b>, 역 1번 출구와 같은 쪽 정류장으로 갑니다.' }
  };
  // 2026-11-24 서울시 응답의 막차·배차. 2025-11-01 당일 값은 확보하지 못했다.
  var SCHEDULE = { machon: { last: '00:22', term: 13 }, gangbyeon: { last: '23:39', term: 13 } };
  // 시연 상황 — 모두 예시값(분)
  var SC = {
    basic: { label: '기본', date: '2025년 11월 1일', clock: '20:50', eta: { machon: [9, 22], gangbyeon: [5, 18] } },
    hurry: { label: '도착이 촉박할 때', date: '2025년 11월 1일', clock: '21:10', eta: { machon: [7, 20], gangbyeon: [9, 22] } },
    ended: { label: '막차 이후', date: '2025년 11월 2일', clock: '00:40', ended: true },
    fail: { label: '조회 실패', date: '2025년 11월 1일', clock: '20:50', fail: true }
  };

  var $ = function (id) { return document.getElementById(id); };
  var css = function (n) { return getComputedStyle(document.documentElement).getPropertyValue(n).trim(); };
  var q = new URLSearchParams(location.search);
  var mode = q.get('mode') === 'live' ? 'live' : 'demo', sc = SC[q.get('s')] ? q.get('s') : 'basic';
  var opts = [], sel = 0, view = 'home', live = {}, timer = null, D, map, base, over, exitData, gate = 'all';

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function badge(n) { return '<span class="badge s' + n + '">' + n + '</span>'; }
  function link(u, t) { return '<a href="' + esc(u) + '" target="_blank" rel="noopener">' + t + '</a>'; }
  function json(u) { return fetch(u).then(function (r) { if (!r.ok) throw new Error(u); return r.json(); }); }

  Promise.all([json('data/routes.json'), json('data/subway_paths.json'), json('data/basemap.json').catch(function () { return null; })]).then(function (a) {
    D = { r: a[0], s: a[1], b: a[2] };
    opts = D.r.options.map(function (o) {
      var k = o.ars_id === '24244' ? 'machon' : 'gangbyeon';
      return { id: 'bus-' + k, kind: 'bus', k: k, o: o, walk: o.walking_minutes_estimate, m: o.walking_m_estimate, line: o.walking_polyline_lon_lat };
    });
    var p = D.s.paths, so = D.r.subway_options;
    opts.push(
      // 경로선 자료는 역 중심점까지다. 지도에는 4번 출구(OSM node 8227072104)까지만 그린다.
      { id: 'subway-olympic', kind: 'sub', name: '올림픽공원역', exit: '4번 출구', lines: ['5', '9'], walk: so[0].walking_minutes_estimate, m: so[0].walking_m_estimate, o: so[0],
        line: p['subway-olympic'].walking_polyline_lon_lat.slice(0, 15).concat([so[0].exit_coordinate_lon_lat]) },
      { id: 'subway-hanseong', kind: 'sub', name: '한성백제역', exit: '2번 출구', lines: ['9'], crowd: true, walk: so[1].walking_minutes_estimate, m: so[1].walking_m_estimate, o: so[1],
        line: p['subway-hanseong'].walking_polyline_lon_lat });
    if (mode === 'demo' && SC[sc].ended) sel = 2;
    if (window.L && D.b) initMap();
    route();
    refresh();
  }).catch(function () { $('view').innerHTML = '<p class="pad">동선 자료를 불러오지 못했습니다. 새로고침해 주세요.</p>'; });

  // ---------- 버스 도착 ----------
  function pack(x, list) { // list: [{sec,msg,isLast}]
    var buses = list.slice(0, 2).map(function (b) {
      var m = b.sec == null ? null : Math.floor(b.sec / 60), gap = b.sec == null ? null : b.sec / 60 - x.walk;
      return { min: m, gap: gap, msg: b.msg, isLast: b.isLast,
        cls: gap == null ? '' : gap >= HURRY ? 'ok' : gap >= 0 ? 'hurry' : 'miss',
        text: gap == null ? '확인 필요' : gap >= HURRY ? '탈 수 있음' : gap >= 0 ? (x.k === 'gangbyeon' ? '신호에 따라 다름' : '서두르면 가능') : '놓칠 수 있음' };
    });
    var f = -1;
    buses.forEach(function (b, i) { if (f < 0 && (b.cls === 'ok' || b.cls === 'hurry')) f = i; });
    return { status: 'ok', buses: buses, f: f };
  }
  function arrival(x) {
    var s = SCHEDULE[x.k], a;
    if (mode === 'demo') {
      var c = SC[sc];
      a = c.fail ? { status: 'fail' } : c.ended ? { status: 'ended' } : pack(x, c.eta[x.k].map(function (m) { return { sec: m * 60 }; }));
      a.last = s.last; a.term = s.term; a.lastNote = '2026년 11월 24일 서울시 조회값';
      return a;
    }
    var j = live[x.k];
    if (!j) return { status: 'load' };
    var made = j.mkTm ? Date.parse(j.mkTm) : Date.now(), age = Math.max(0, Date.now() - made);
    if (!j.ok || age > STALE_MS) return { status: 'fail', last: s.last, term: s.term, lastNote: '2026년 11월 24일 서울시 조회값' };
    a = j.ended ? { status: 'ended' } : pack(x, (j.buses || []).map(function (b) {
      return { sec: b.sec == null ? null : Math.max(0, b.sec - age / 1000), msg: b.msg, isLast: b.isLast };
    }));
    a.last = j.lastTm && j.lastTm.length >= 12 ? j.lastTm.slice(8, 10) + ':' + j.lastTm.slice(10, 12) : null;
    a.term = j.term; a.lastNote = '오늘 서울시 응답'; a.asOf = j.mkTm && j.mkTm.slice(11, 19);
    return a;
  }
  function refresh() {
    clearTimeout(timer);
    if (mode !== 'live') return;
    if (!document.hidden) ['machon', 'gangbyeon'].forEach(function (k) {
      var ctrl = new AbortController(), t = setTimeout(function () { ctrl.abort(); }, 12000);
      fetch('/api/bus?dir=' + k, { signal: ctrl.signal, cache: 'no-store' }).then(function (r) { return r.json(); })
        .catch(function () { return { ok: false }; }).then(function (j) {
          clearTimeout(t);
          if (mode !== 'live') return;
          live[k] = j; clock(); update();
        });
    });
    timer = setTimeout(refresh, REFRESH_MS);
  }
  document.addEventListener('visibilitychange', function () { if (!document.hidden && D) refresh(); });

  // 도착 값만 바뀌었을 때: 화면 전체를 다시 그리지 않는다
  function update() {
    if (view === 'home') list();
    else if (view === 'go' && $('arr')) { $('arr').innerHTML = etaBlock(opts[sel]); cta(); }
  }

  // ---------- 상단 띠 ----------
  function clock() {
    var d = new Date(), two = function (n) { return (n < 10 ? '0' : '') + n; };
    $('mode').textContent = mode === 'live' ? '실시간' : '시연';
    $('clock').textContent = mode === 'live' ? (d.getMonth() + 1) + '월 ' + d.getDate() + '일 ' + two(d.getHours()) + ':' + two(d.getMinutes()) : SC[sc].date + ' ' + SC[sc].clock;
    $('modeBtn').textContent = mode === 'live' ? '시연 보기' : '실시간 보기';
  }
  function params() {
    var p = new URLSearchParams(location.search);
    if (mode === 'live') p.set('mode', 'live'); else p.delete('mode');
    if (mode === 'demo' && sc !== 'basic') p.set('s', sc); else p.delete('s');
    var s = p.toString();
    history.replaceState(null, '', location.pathname + (s ? '?' + s : '') + location.hash);
  }
  $('modeBtn').addEventListener('click', function () {
    mode = mode === 'live' ? 'demo' : 'live'; live = {};
    params(); route(); refresh();
  });

  // ---------- 화면 1: 방면 고르기 ----------
  function num(n, unit, t, cls) {
    return '<span class="num ' + (cls || '') + '"><span class="n">' + n + '</span><span class="u">' + unit + '</span><span class="t">' + t + '</span></span>';
  }
  function eg() { return mode === 'demo' ? '예시 · ' : ''; }
  function bar(x, b) {
    var h = '<span class="bar"><i class="w" style="flex:' + (x.kind === 'sub' ? '1 1 auto' : x.walk + ' 0 auto') + '">도보 ' + x.walk + '분</i>';
    if (x.kind === 'sub') return h + x.lines.map(function (l) { return '<i class="l' + l + '">' + l + '호선</i>'; }).join('') + '</span>';
    var w = b ? b.min - x.walk : 0;
    return h + (w > 0 ? '<i class="g" style="flex:' + Math.min(w, 12) + ' 0 auto">대기 ' + w + '분</i>' : '') + '<i class="b">3214번 →</i></span>';
  }
  function row(x, i) {
    var on = i === sel, h = '<button type="button" class="row' + (on ? ' on' : '') + '" aria-pressed="' + on + '" data-i="' + i + '"><span class="who">';
    if (x.kind === 'sub') {
      h += '<span class="name">' + x.lines.map(badge).join('') + x.name + '</span><span class="sub">' + x.exit + (x.crowd ? ' · 올림픽공원역이 붐빌 때' : ' · 공원 쪽') + '</span></span>' + num(x.walk, '분', '걸어서', 'walk');
      return h + (on ? bar(x) : '') + '</button>';
    }
    var a = arrival(x), b = a.status === 'ok' ? a.buses[Math.max(a.f, 0)] : null;
    if (a.status === 'ok' && a.f < 0 && a.buses[1] && a.buses[1].min != null) b = a.buses[1];
    h += '<span class="name"><span class="badge">3214</span>' + esc(x.o.direction) + ' 방면</span><span class="sub">' +
      (on ? '정류소 <b>' + x.o.ars_id + '</b> · ' + BUS[x.k].short + '<br>다음 정류장 ' + esc(x.o.next_stop)
        : a.f === 1 && a.buses[0].min != null ? '앞차 ' + a.buses[0].min + '분은 놓칠 수 있음' : '도보 ' + x.walk + '분 → 정류소 ' + x.o.ars_id) + '</span></span>';
    if (b && b.min != null) h += num(b.min < 1 ? '곧' : b.min, b.min < 1 ? '' : '분', (on ? '버스 ' + (b.min < 1 ? '곧 도착' : b.min + '분 뒤 도착') + '<br>' : '') + eg() + '<span class="' + b.cls + '">' + b.text + '</span>' + (b.isLast ? ' · 막차' : ''));
    else h += '<span class="num"><span class="u">' + ({ ended: '운행 종료', fail: '조회 불가', load: '조회 중' }[a.status] || esc((b && b.msg) || '도착 정보 없음')) + '</span><span class="t">' + (a.last ? '막차 ' + a.last : '') + '</span></span>';
    if (on) h += bar(x, b && b.min != null && b.cls !== 'miss' ? b : null) + (a.f === 1 && a.buses[0].min != null ? '<span class="miss1">앞차 ' + a.buses[0].min + '분은 걷는 동안 지나갈 수 있습니다</span>' : '') +
      (a.last && b && b.min != null ? '<span class="miss1">막차 <b>' + a.last + '</b> · ' + a.lastNote + '</span>' : '');
    return h + '</button>';
  }
  function list() {
    var box = $('list'); if (!box) return;
    var had = document.activeElement && box.contains(document.activeElement) ? document.activeElement.dataset.i : null;
    box.innerHTML = opts.map(row).join('');
    if (had != null) box.querySelector('[data-i="' + had + '"]').focus({ preventScroll: true });
  }
  function home() {
    $('view').innerHTML = '<div class="event"><p><b>KSPO DOME</b> 아이브 서울 2회차 18:00</p><button type="button" data-go="#/event" aria-label="공연 바꾸기">바꾸기</button></div>' +
      '<h1 tabindex="-1">어느 쪽으로 가세요?</h1><div id="list" role="group" aria-label="가는 방면"></div>' +
      '<button type="button" class="goto" data-go="#/car"><b>자가용으로 오셨나요?</b><span>출차가 몰린 시각 보기 →</span></button>' +
      scenario() + '<p class="foot">' + (mode === 'demo' ? '버스 도착 시간은 시연용 예시값입니다. 막차는 2026년 11월 24일 서울시 조회값입니다. ' : '실시간 보기에서도 공연은 시연 회차로 고정됩니다. ') +
      '도보는 지도 경로 추정이며 신호 대기와 공연장 안에서 걷는 시간은 빠져 있습니다.<br>자료: 한국체육산업개발 · 서울특별시 · OpenStreetMap</p>';
    list();
  }

  // ---------- 화면 2: 탑승 위치 ----------
  function etaBlock(x) {
    var a = arrival(x), h = '';
    var last = a.last ? '<p class="note">막차 <b>' + a.last + '</b>' + (a.term ? ' · 배차 약 ' + a.term + '분' : '') + ' <span class="small">' + a.lastNote + '</span></p>' : '';
    if (a.status === 'load') return '<p class="state">조회 중</p><p class="note">서울시 버스도착정보를 불러오고 있습니다.</p>';
    if (a.status === 'fail') return '<p class="state">도착 시간 조회 불가</p><p class="note">지금은 도착 시간을 불러올 수 없습니다. 아래 정류장 위치와 방향은 그대로입니다.</p><p class="links">' +
      link(BUS_WEB, '서울시 버스정보에서 확인') + (mode === 'live' ? '<button type="button" data-retry>다시 조회</button>' : '') + '</p>' + last;
    if (a.status === 'ended') return '<p class="state">운행 종료</p><p class="note">3214번 ' + esc(x.o.direction) + ' 방면 운행이 끝났습니다. 지하철로 가세요.</p><p class="links">' +
      '<button type="button" data-go="#/go/subway-hanseong">한성백제역 가는 길</button>' + link(METRO, '지하철 막차 확인') + '</p>' + last;
    if (!a.buses.length) return '<p class="state">도착 예정 버스 없음</p>' + last;
    h += '<div class="etas">' + a.buses.map(function (b, i) {
      return '<div class="eta ' + b.cls + (i === a.f || (a.f < 0 && i === 0 && b.min == null) ? ' on' : '') + '"><span class="k">' + (i ? '다음 버스' : '첫 버스') + ' 도착' + (b.isLast ? ' · 막차' : '') + (mode === 'demo' ? ' · 예시' : '') + '</span>' +
        (b.min == null ? '<span class="u">' + esc(b.msg || '정보 없음') + '</span>' : '<span class="n">' + (b.min < 1 ? '곧' : b.min) + '</span>' + (b.min < 1 ? '' : '<span class="u">분</span>')) +
        '<span class="v ' + b.cls + '">' + b.text + '</span></div>';
    }).join('') + '</div>';
    var b = a.buses[a.f];
    h += bar(x, b);
    if (x.k === 'gangbyeon') h += '<p class="small">도보 약 ' + x.walk + '분 · 신호 대기 별도</p>';
    if (b) h += '<p class="small">도착 ' + b.min + '분 − 도보 ' + x.walk + '분 = 여유 ' + Math.floor(b.gap) + '분 (' + HURRY + '분 이상이면 탈 수 있음)' + '</p>';
    else if (a.buses.every(function (y) { return y.cls === 'miss'; })) h += '<p class="note">두 버스 모두 걷는 동안 지나갈 수 있습니다. 그다음 차는 배차 간격' + (a.term ? '(약 ' + a.term + '분)' : '') + '을 참고하거나 지하철을 이용하세요.</p>';
    if (a.asOf) h += '<p class="small">서울시 응답 ' + a.asOf + (b && b.msg ? ' · ' + esc(b.msg) : '') + ' · 30초마다 갱신</p>';
    return h + last;
  }
  function go(x) {
    var h = '<button type="button" class="back" data-go="#/">← 방면 다시 고르기</button>';
    if (x.kind === 'bus') {
      var ot = opts[x.k === 'machon' ? 1 : 0].o;
      h += '<h1 class="route" tabindex="-1"><span class="badge">3214</span>' + esc(x.o.direction) + ' 방면</h1>' +
        '<section class="block first"><dl class="kv"><dt>정류소</dt><dd>' + x.o.ars_id + ' <small>' + esc(x.o.stop_name) + '</small></dd>' +
          '<dt>다음 정류장</dt><dd>' + esc(x.o.next_stop) + ' <small>' + x.o.next_ars_id + '</small></dd></dl></section>' +
        '<section class="block" id="arr" aria-live="polite">' + etaBlock(x) + '</section>' +
        '<section class="block"><h2>길 어느 쪽에 서나요</h2>' + road(x.k) +
          '<p class="note">' + BUS[x.k].walk + '</p><p class="note">이름이 같은 정류장이 길 건너에 하나 더 있습니다. <b>' + ot.ars_id + '</b>는 ' + esc(ot.direction) + ' 방면입니다.</p></section>' +
        '<section class="block"><h2>걸어가는 길</h2><dl class="kv sm"><dt>출발</dt><dd>한얼광장 ‘88서울올림픽’ 조각 앞</dd><dt>도보</dt><dd>약 ' + x.m + 'm · ' + x.walk + '분' + (x.k === 'gangbyeon' ? ' <small>신호 대기 별도</small>' : '') + '</dd></dl></section>' +
        scenario() + sources('정류소: 서울시 버스 노선별 정류소 원자료(2025-10-02, 2025-11-03, 2026-09-02판 대조). 도착·막차: 서울시 버스도착정보. 도보: OpenStreetMap 보행로(2026-11-24 조회, 현장 실측 아님). 정류소·출구의 앞뒤 순서는 OpenStreetMap 좌표를 따랐고 그림의 거리는 실제 비율이 아닙니다.', D.r.sources);
    } else {
      var oly = x.id === 'subway-olympic';
      h += '<h1 class="route" tabindex="-1">' + x.lines.map(badge).join('') + x.name + '</h1>' +
        '<section class="block first"><div class="etas"><div class="eta on"><span class="k">걸어서</span><span class="n">' + x.walk + '</span><span class="u">분</span></div>' +
          '<div class="eta"><span class="k">들어가는 곳</span><span class="n">' + x.exit.charAt(0) + '</span><span class="u">번 출구</span></div></div>' + bar(x) +
          '<p class="small">약 ' + (x.m >= 1000 ? (x.m / 1000).toFixed(1) + 'km' : x.m + 'm') + '. ' + (oly ? '4번 출구까지의 지도 경로 추정입니다.' : '2번 출구 인근까지의 지도 경로 추정입니다. 예매처 안내는 약 20분입니다.') + '</p></section>';
      if (oly) h += '<section class="block"><h2>길 어느 쪽으로 들어가나요</h2>' + road('exit4') + '<p class="note"><b>4번 출구</b>는 공원 쪽에 있습니다. 양재대로를 건너지 않습니다.</p></section>' +
        '<section class="block"><h2>5호선은 행선지를 확인하세요</h2><p class="note">5호선은 강동역에서 마천 방면과 하남 방면으로 갈라집니다. 타기 전에 열차 행선지를 확인하세요.</p></section>';
      else h += '<section class="block"><h2>올림픽공원역이 붐빌 때</h2><p class="note">예매처 공연장 안내는 공연 직후 올림픽공원역 혼잡을 피하려면 한성백제역이나 몽촌토성역을 권합니다.</p></section>';
      h += '<section class="block"><h2>막차</h2><p class="links">' + link(METRO, '서울교통공사 역별 시간표') + '</p></section>' +
        sources('도보: OSRM 보행 경로(OpenStreetMap, 2026-11-24 조회, 현장 실측 아님). 출구 위치: OpenStreetMap.', x.o.sources);
    }
    $('view').innerHTML = h;
  }
  function sources(t, urls) {
    return '<details class="pad"><summary>자료 출처</summary><p>' + t + '</p><p>' + (urls || []).map(function (u, i) { return link(u, '자료 ' + (i + 1)); }).join(' · ') + '</p></details>';
  }

  // 길 어느 쪽: 위가 북동쪽(KSPO DOME 쪽 길)인 약도. 왼쪽=공원 쪽, 오른쪽=1번 출구 쪽.
  // 출구·정류소의 위아래 순서는 OSM 좌표 순서다.
  function road(t) {
    var W = t === 'machon', E = t === 'gangbyeon', X = t === 'exit4', H = 232, s;
    var plate = function (x, y, n, on) { return '<rect class="' + (on ? 'plate' : 'off') + '" x="' + x + '" y="' + y + '" width="92" height="34" rx="6"/><text class="' + (on ? 'plate-t' : 'off-t') + '" x="' + (x + 46) + '" y="' + (y + (on ? 25 : 23)) + '">' + n + '</text>'; };
    var exit = function (x, y, n, on) { return '<rect class="ex' + (on ? ' on' : '') + '" x="' + x + '" y="' + y + '" width="54" height="20" rx="4"/><text class="ex-t' + (on ? ' on' : '') + '" x="' + (x + 27) + '" y="' + (y + 14) + '">' + n + '번 출구</text>'; };
    var me = function (x, y) { return '<circle class="me" cx="' + x + '" cy="' + y + '" r="5"/><path class="me" d="M' + (x - 7) + ' ' + (y + 22) + 'v-9a7 7 0 0 1 14 0v9z"/>'; };
    var bus = function (x, y) { return '<rect class="bus" x="' + x + '" y="' + y + '" width="38" height="50" rx="7"/><rect class="glass" x="' + (x + 6) + '" y="' + (W ? y + 39 : y + 5) + '" width="26" height="6" rx="2"/><text class="bus-t" x="' + (x + 19) + '" y="' + (W ? y + 25 : y + 33) + '">3214</text>'; };
    var label = W ? '공원 쪽 정류소 24244에 서고 버스는 아래쪽 마천동 방면으로 갑니다. 길 건너 24245는 강변역 방면입니다.'
      : E ? '신호 횡단보도를 건너 1번 출구 쪽 정류소 24245에 서고 버스는 위쪽 강변역 방면으로 갑니다. 길 건너기 전 24244는 마천동 방면입니다.'
      : '4번 출구는 공원 쪽, 정류소 24244와 3번 출구 사이에 있습니다.';
    s = '<svg class="road" viewBox="0 0 343 ' + H + '" role="img" aria-label="' + label + '">' +
      '<rect class="rd" x="120" y="0" width="104" height="' + H + '"/><line class="mid" x1="172" x2="172" y1="26" y2="' + H + '"/>' +
      '<text class="sm" x="172" y="17">양재대로</text><text class="side" x="6" y="17">공원 쪽</text><text class="side" x="337" y="17" text-anchor="end">길 건너</text>';
    for (var i = 0; i < 9; i++) s += '<line class="zebra" x1="' + (126 + i * 11.5) + '" x2="' + (126 + i * 11.5) + '" y1="196" y2="216"/>';
    s += plate(6, 48, '24244', W) + '<text x="6" y="100" class="' + (W ? 'on-t' : '') + '">마천동 방면</text>' + exit(42, 112, 4, X) + exit(42, 158, 3) +
      exit(246, 36, 1) + plate(245, 76, '24245', E) + '<text x="337" y="128" text-anchor="end" class="' + (E ? 'on-t' : '') + '">강변역 방면</text>' + exit(246, 158, 2);
    if (W) s += '<path class="pw" d="M6 36H109V44"/>' + bus(127, 40) + '<path class="go" d="M146 102V170M133 157l13 13 13-13"/>' + '<path class="go off" d="M198 150V90M191 97l7-7 7 7"/>' + me(109, 56);
    if (E) s += '<path class="pw" d="M6 145H109V206H235V118"/>' + bus(179, 72) + '<path class="go" d="M198 64V36M185 47l13-13 13 13"/>' + '<path class="go off" d="M146 90V150M139 143l7 7 7-7"/>' + me(235, 84) +
      '<text class="sm" x="337" y="210" text-anchor="end" style="text-anchor:end">신호 횡단보도</text>';
    if (X) s += '<path class="pw" d="M6 145H30V122H34"/>';
    return s + '</svg>';
  }

  // ---------- 시연 상황 ----------
  function scenario() {
    if (mode !== 'demo') return '';
    return '<section class="block"><h2>시연 상황 바꾸기 (예시값)</h2><div class="chips">' + Object.keys(SC).map(function (k) {
      return '<button type="button" data-sc="' + k + '" aria-pressed="' + (k === sc) + '">' + SC[k].label + '</button>';
    }).join('') + '</div></section>';
  }

  // ---------- 공연 고르기 ----------
  function eventView() {
    var e = D.r.event;
    $('view').innerHTML = '<button type="button" class="back" data-go="#/">← 돌아가기</button><h1 tabindex="-1">어떤 공연을 보고 나오셨나요?</h1><div class="pad">' +
      '<button type="button" class="ev" aria-pressed="true" data-go="#/"><b>KSPO DOME</b>' + esc(e.title) + '<i>2025년 11월 1일 토요일 18:00 · 서울 ' + e.session + '회차</i></button>' +
      '<div class="ev no"><b>올림픽홀</b>신승훈 공연<i>같은 날 18:00 · 귀가 동선은 아직 준비되지 않았습니다</i></div>' +
      '<p class="small">공연의 실제 종료 시각은 공개 자료로 확인되지 않았습니다. 실시간 보기에서도 공연은 이 회차로 고정됩니다.</p>' +
      '<p class="links">' + link(e.source, '공식 예매 공지') + link(D.r.start.source, '한얼광장 안내') + '</p></div>';
  }

  // ---------- 출차 그래프 ----------
  // make_exit_counts.py 형식과 스크립트/출차분석.py 형식을 모두 받아 하나로 맞춘다.
  function norm(j) {
    if (j.series) return {
      date: j.target_date, bins: j.series.map(function (x) { return x.t; }), gates: j.gates, n: (j.comparison_days || []).length, basis: j.comparison_basis, cmpName: '10월 공연 없고 비 오지 않은 평일 중앙값', foot: '자료가 있는 토요일에는 모두 공연이 있어 평일 13일과 비교',
      by: j.gates.reduce(function (o, g) { o[g] = j.series.map(function (x) { return x.by_gate[g] || 0; }); return o; }, {}),
      cmp: (j.comparison_days || []).length ? { all: j.series.map(function (x) { return x.baseline_median || 0; }) } : null,
      start: j.exit_start && j.exit_start.t, peak: j.exit_peak && j.exit_peak.t, notes: j.notes || []
    };
    var gs = j.gates || Object.keys(j.event_day.counts), c = j.comparison, sum = function (o) { return j.bins.map(function (_, i) { return gs.reduce(function (s, g) { return s + ((o[g] || [])[i] || 0); }, 0); }); };
    return { date: j.event_day.date, bins: j.bins, gates: gs, by: j.event_day.counts, n: c ? c.dates.length : 0, basis: '', cmpName: c ? '비교일 ' + c.dates.length + '일 중앙값' : '',
      cmp: c ? Object.assign({ all: sum(c.counts) }, c.counts) : null, start: j.markers && j.markers.surge_start, peak: j.markers && j.markers.peak, notes: j.notes || [] };
  }
  function car() {
    $('view').innerHTML = '<button type="button" class="back" data-go="#/">← 돌아가기</button><h1 tabindex="-1">출차가 몰린 시각</h1><div class="pad" id="car"><p class="note">불러오는 중…</p></div>';
    if (exitData) return chart();
    fetch('data/exit_counts.json', { cache: 'no-store' }).then(function (r) { if (!r.ok) throw 0; return r.json(); })
      .then(function (j) { exitData = norm(j); chart(); })
      .catch(function () {
        if ($('car')) $('car').innerHTML = '<p class="state">집계 준비 중</p><p class="note">한국체육산업개발 ‘올림픽공원 입출차정보(전체구역)’ 원자료를 받는 중입니다. 집계가 끝나면 2025년 11월 1일의 출차를 출구 게이트(동2문·남2문·북2문)별로 10분 단위로 보여 줍니다.</p>';
      });
  }
  function nice(v) { var p = Math.pow(10, Math.floor(Math.log10(v))), f = v / p; return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 3 ? 3 : f <= 5 ? 5 : 10) * p; }
  function interval(t) { return t + '~' + t.slice(0, 4) + '9'; }
  function chart() {
    var box = $('car'), d = exitData; if (!box) return;
    var v = d.bins.map(function (_, i) { return gate === 'all' ? d.gates.reduce(function (s, g) { return s + (d.by[g][i] || 0); }, 0) : d.by[gate][i] || 0; });
    var c = d.cmp && d.cmp[gate], top = nice(Math.max.apply(null, v.concat(c || [], [1]))), eve = function (i) { return d.bins[i] >= '19:00'; }, late = v.map(function (n, i) { return eve(i) ? n : -1; });
    // 강조하는 막대는 19시 이후 최고(전체는 집계 파일의 exit_peak). 17시대 낮 출차가 더 많을 수 있어 하루 최고와 구분한다.
    var pk = gate === 'all' && d.bins.indexOf(d.peak) >= 0 ? d.bins.indexOf(d.peak) : late.indexOf(Math.max.apply(null, late));
    var scope = gate === 'all' ? '공원 전체' : gate;
    var peaks = d.bins.filter(function (_, i) { return eve(i) && v[i] === v[pk]; }).map(interval).join(', ');
    var sum19 = v.reduce(function (s, n, i) { return s + (eve(i) ? n : 0); }, 0);
    var W = 343, H = 220, l = 34, r = 4, t = 34, b = 24, pw = W - l - r, ph = H - t - b, sl = pw / d.bins.length;
    var y = function (n) { return t + ph - n / top * ph; }, X = function (i) { return l + i * sl; }, s = '<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="10분 단위 출차 대수. 19시 이후 가장 많은 구간 ' + interval(d.bins[pk]) + ', ' + v[pk] + '대">';
    [0, .5, 1].forEach(function (f) { s += '<line class="grid" x1="' + l + '" x2="' + (W - r) + '" y1="' + y(top * f) + '" y2="' + y(top * f) + '"/><text x="' + (l - 5) + '" y="' + (y(top * f) + 4) + '" text-anchor="end">' + top * f + '</text>'; });
    d.bins.forEach(function (k, i) {
      s += '<rect class="b' + (i === pk ? ' hi' : '') + '" x="' + (X(i) + .75) + '" y="' + y(v[i]) + '" width="' + Math.max(1, sl - 1.5) + '" height="' + (t + ph - y(v[i])) + '"/>';
      if (k.slice(3) === '00' && +k.slice(0, 2) % 2 === 0) s += '<text x="' + (X(i) + sl / 2) + '" y="' + (H - 6) + '" text-anchor="' + (i ? 'middle' : 'start') + '">' + +k.slice(0, 2) + '시</text>';
    });
    if (c) s += '<polyline class="cmp" points="' + d.bins.map(function (_, i) { return X(i) + ',' + y(c[i] || 0) + ' ' + X(i + 1) + ',' + y(c[i] || 0); }).join(' ') + '"/>';
    if (gate === 'all') [[d.start, '출차가 크게 늘어난 첫 10분', 12], [d.peak, '가장 많은 10분', 26]].forEach(function (m) {
      var i = d.bins.indexOf(m[0]); if (i < 0) return;
      var x = X(i) + sl / 2, e = m[2] === 12 ? x > 130 : x > W - 100;
      s += '<line class="mk" x1="' + x + '" x2="' + x + '" y1="' + (m[2] - 8) + '" y2="' + (t + ph) + '"/><text x="' + (e ? x - 4 : x + 4) + '" y="' + m[2] + '" text-anchor="' + (e ? 'end' : 'start') + '">' + m[1] + '</text>';
    });
    d.bins.forEach(function (_, i) { s += '<rect data-b="' + i + '" x="' + X(i) + '" y="0" width="' + sl + '" height="' + H + '" fill="transparent"/>'; });
    box.innerHTML = '<div class="chips">' + ['all'].concat(d.gates).map(function (g) { return '<button type="button" data-gate="' + esc(g) + '" aria-pressed="' + (g === gate) + '">' + (g === 'all' ? '전체' : esc(g)) + '</button>'; }).join('') + '</div>' +
      '<p class="note">' + (gate === 'all' && d.start && d.peak
        ? '출차가 크게 늘어난 첫 10분: ' + interval(d.start) + ' · 공원 전체 ' + v[d.bins.indexOf(d.start)] + '대. 19시 이후 가장 많은 10분: ' + peaks + ' · 각 구간 공원 전체 <b>' + v[pk] + '대</b>.'
        : scope + ' 19시 이후 <b>' + sum19.toLocaleString('ko-KR') + '대</b>가 나갔고, <b>' + interval(d.bins[pk]) + '</b>에 10분당 <b>' + v[pk] + '대</b>로 가장 많았습니다.') + '</p>' +
      '<div class="chart">' + s + '</svg><div class="tip"></div></div><p class="legend"><span><i></i>' + esc(d.date) + ' 10분당 출차 대수</span>' + (c ? '<span><i class="c"></i>' + esc(d.cmpName) + '</span>' : '') + '</p>' +
      (d.foot ? '<p class="small">' + esc(d.foot) + (c ? '' : ' (비교선은 전체에만 있습니다)') + '</p>' : '') +
      '<p class="small">자료: 한국체육산업개발 올림픽공원 입출차정보(전체구역)</p>' +
      '<details><summary>집계 방법</summary>' + (d.basis ? '<p>비교 기준: ' + esc(d.basis) + '.</p>' : '') + d.notes.map(function (n) { return '<p>' + esc(n) + '.</p>'; }).join('') +
      (d.foot ? '<p>비교일은 평일이라 18시 전후에 퇴근 시간 출차가 섞여 있습니다.</p>' : '') + '<p>공연의 실제 종료 시각은 확인되지 않아 가로축은 시계 시각입니다.</p></details>' +
      '<details><summary>표로 보기</summary><table><thead><tr><th>시각</th><th>출차</th>' + (c ? '<th>비교</th>' : '') + '</tr></thead><tbody>' + d.bins.map(function (k, i) { return '<tr><td>' + interval(k) + '</td><td>' + v[i] + '</td>' + (c ? '<td>' + c[i] + '</td>' : '') + '</tr>'; }).join('') + '</tbody></table></details>';
    var ch = box.querySelector('.chart'), tip = box.querySelector('.tip');
    var show = function (e) {
      var k = e.target.dataset && e.target.dataset.b; if (k == null) return;
      var rc = ch.getBoundingClientRect(), tr = e.target.getBoundingClientRect();
      tip.textContent = interval(d.bins[k]) + ' · ' + scope + ' ' + v[k] + '대' + (c ? ' (비교 ' + c[k] + '대)' : '');
      tip.style.display = 'block'; tip.style.top = '60px';
      tip.style.left = Math.max(70, Math.min(rc.width - 70, tr.left - rc.left + tr.width / 2)) + 'px';
    };
    ch.addEventListener('pointermove', show); ch.addEventListener('pointerdown', show);
    ch.addEventListener('pointerleave', function () { tip.style.display = 'none'; });
  }

  // ---------- 주요 버튼 ----------
  function cta() {
    var b = $('cta'), x = opts[sel], t = '', g = '';
    if (view === 'home') { t = x.kind === 'bus' ? x.o.ars_id + ' 정류장으로 가기' : x.name + ' ' + x.exit + '로 가기'; g = '#/go/' + x.id; }
    else if (view === 'event') { t = '이 공연으로 보기'; g = '#/'; }
    else if (view === 'car') { t = '대중교통으로 가기'; g = '#/'; }
    else if (x.kind === 'bus' && arrival(x).status === 'ended') { t = '올림픽공원역으로 가기'; g = '#/go/subway-olympic'; }
    else { t = folded ? '안내 다시 보기' : '지도에서 길 보기'; g = 'fold'; }
    b.hidden = false; b.textContent = t; b.dataset.act = g;
  }
  $('cta').addEventListener('click', function () {
    var g = this.dataset.act;
    if (g === 'fold') fold(!folded); else nav(g);
  });

  // ---------- 화면 바꾸기 ----------
  function nav(h) { if ((location.hash || '#/') === h) route(); else location.hash = h; }
  function route(moved) {
    if (!D) return;
    var h = location.hash, i = -1;
    view = h === '#/event' ? 'event' : h === '#/car' ? 'car' : 'home';
    if (h.indexOf('#/go/') === 0) opts.forEach(function (x, k) { if (x.id === h.slice(5)) i = k; });
    if (i >= 0) { sel = i; view = 'go'; }
    $('sheet').dataset.view = view;
    clock(); setDown(0);
    if (view === 'home') home(); else if (view === 'go') go(opts[sel]); else if (view === 'event') eventView(); else car();
    $('view').scrollTop = 0;
    cta(); fit();
    if (moved === true) { var t = $('view').querySelector('h1'); if (t) t.focus({ preventScroll: true }); }
  }
  addEventListener('hashchange', function () { route(true); });
  $('view').addEventListener('click', function (e) {
    var t = e.target.closest('[data-i],[data-go],[data-sc],[data-retry],[data-gate]'); if (!t) return;
    var d = t.dataset;
    if (d.go) nav(d.go);
    else if (d.i != null) { sel = +d.i; list(); cta(); fit(); $('list').children[sel].scrollIntoView({ block: 'nearest' }); }
    else if (d.sc) {
      sc = d.sc; params(); clock(); update(); cta();
      $('view').querySelectorAll('[data-sc]').forEach(function (b) { b.setAttribute('aria-pressed', String(b.dataset.sc === sc)); });
    } else if (d.gate) { gate = d.gate; chart(); }
    else { delete live[opts[sel].k]; update(); refresh(); }
  });

  // ---------- 시트 끌기 ----------
  var down = 0, folded = false;
  function closedAt() { return $('sheet').offsetHeight - 24 - document.querySelector('.cta').offsetHeight; }
  function setDown(v) {
    var c = closedAt();
    down = v; folded = v > 0 && v >= c;
    $('sheet').style.transform = v ? 'translateY(' + v + 'px)' : '';
    document.querySelector('.cta').style.transform = v ? 'translateY(' + -v + 'px)' : '';
    $('view').style.visibility = folded ? 'hidden' : '';
    $('grip').setAttribute('aria-expanded', String(!folded));
  }
  function fold(on) { setDown(on ? closedAt() : 0); cta(); fit(); }
  (function () {
    var g = $('grip'), y0 = null, b0 = 0, moved = false, wasKey = true;
    g.addEventListener('pointerdown', function (e) { y0 = e.clientY; b0 = down; moved = false; wasKey = false; g.setPointerCapture(e.pointerId); $('sheet').classList.add('drag'); });
    g.addEventListener('pointermove', function (e) {
      if (y0 == null) return;
      if (Math.abs(e.clientY - y0) > 4) moved = true;
      setDown(Math.max(0, Math.min(closedAt() - 1, b0 + e.clientY - y0)));
    });
    var end = function () { if (y0 == null) return; y0 = null; $('sheet').classList.remove('drag'); fold(moved ? down > closedAt() / 2 : !b0); };
    g.addEventListener('pointerup', end); g.addEventListener('pointercancel', end);
    g.addEventListener('click', function () { if (wasKey) fold(!folded); wasKey = true; }); // 키보드로 누를 때
  })();

  // ---------- 지도 ----------
  function ll(p) { return [p[1], p[0]]; }
  function dec(a) {
    var x = 0, y = 0, out = [], b = D.b;
    for (var i = 0; i < a.length; i += 2) { x += a[i]; y += a[i + 1]; out.push([b.base[1] + y / b.scale, b.base[0] + x / b.scale]); }
    return out;
  }
  function mark(p, cls, html) {
    return L.marker(p, { interactive: false, keyboard: false, icon: L.divIcon({ className: '', iconSize: [0, 0], html: '<div class="m ' + cls + '">' + (html || '') + '</div>' }) });
  }
  // 차도 폭(m). 차로 수가 있으면 차로당 3.2m
  var W = { a: 26, b: 13, c: 7, d: 4.5, f: 2.5 };
  function px(m) { return Math.max(1, m / (156543.03 * Math.cos(37.517 * Math.PI / 180) / Math.pow(2, map.getZoom()))); }

  function initMap() {
    map = L.map('map', { zoomControl: false, attributionControl: false, zoomSnap: 0, minZoom: 14, maxZoom: 19, preferCanvas: true,
      maxBounds: [[37.48, 127.09], [37.54, 127.165]] });
    L.control.attribution({ position: 'bottomleft', prefix: false }).addAttribution('© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> 기여자').addTo(map);
    over = L.layerGroup().addTo(map);
    map.setView([37.5172, 127.129], 16);
    drawBase();
    map.on('zoomend', function () { base.eachLayer(function (l) { if (l.mw) l.setStyle({ weight: px(l.mw) }); }); overlay(); });
    matchMedia('(prefers-color-scheme: light)').addEventListener('change', function () { drawBase(); overlay(); });
    addEventListener('resize', function () { setDown(folded ? closedAt() : 0); fit(); });
    if (window.ResizeObserver) new ResizeObserver(function () { if (!$('sheet').classList.contains('drag')) fit(); }).observe($('sheet'));
  }
  function drawBase() {
    if (base) base.remove();
    var cv = L.canvas({ padding: 0.5 });
    base = L.layerGroup().addTo(map);
    var fill = function (k, v) { D.b[k].forEach(function (a) { L.polygon(dec(a), { renderer: cv, stroke: false, fillColor: css(v), fillOpacity: 1, interactive: false }).addTo(base); }); };
    fill('park', '--map-park'); fill('green', '--map-green'); fill('pitch', '--map-pitch'); fill('square', '--map-square'); fill('water', '--map-water');
    D.b.stream.forEach(function (a) { L.polyline(dec(a), { renderer: cv, color: css('--map-water'), weight: 4, interactive: false }).addTo(base); });
    ['f', 'd', 'c', 'b', 'a'].forEach(function (k) {
      D.b.road.forEach(function (r) {
        if (r[0] !== k) return;
        var mw = r[1] && k === 'a' ? r[1] * 3.2 : W[k];
        var l = L.polyline(dec(r[2]), { renderer: cv, color: css('--map-road-' + (k === 'd' ? 'c' : k)), weight: px(mw), interactive: false }).addTo(base);
        l.mw = mw;
      });
    });
    fill('bldg', '--map-bldg'); fill('venue', '--map-venue');
  }

  var ST = { machon: [37.516522, 127.13089], gangbyeon: [37.516348, 127.131315] };
  // 정류장 앞을 지나는 버스 진행 방향(양재대로 도로선과 평행). 마천동=남서, 강변역=북동
  function heading(k) {
    var a = [37.5166761, 127.1312998], b = [37.5126436, 127.1285849], s = ST[k];
    var dy = b[0] - a[0], dx = b[1] - a[1], n = Math.hypot(dy, dx * .793), sign = k === 'machon' ? 1 : -1;
    var uy = dy / n * sign / 111320, ux = dx / n * sign / 111320; // 1m
    // 차도 쪽으로 12m 옮긴다
    var c = k === 'machon' ? 1 : -1, oy = -dx * .793 / n * 12 * c / 111320, ox = dy / n * 12 * c / 111320 / .793;
    if (c === 1 ? ox < 0 : ox > 0) { oy = -oy; ox = -ox; }
    var at = function (m) { return [s[0] + oy + uy * m, s[1] + ox + ux * m]; };
    return [at(-45), at(80), at(60)];
  }
  function overlay() {
    if (!map || !opts.length) return;
    over.clearLayers();
    var x = opts[sel], path = x.line.map(ll), z = map.getZoom();
    mark([37.51915, 127.12735], 'm-text venue', 'KSPO DOME').addTo(over);
    mark([37.5199, 127.1330], 'm-text road', '양재대로').addTo(over);
    mark([37.5161, 127.1272], 'm-text', '올림픽홀').setZIndexOffset(-1000).addTo(over);
    // 도보 점선
    var sv = L.svg({ padding: 0.5 });
    L.polyline(path, { renderer: sv, color: css('--walk-case'), weight: 9, opacity: .55, lineCap: 'round', interactive: false }).addTo(over);
    L.polyline(path, { renderer: sv, color: css('--walk'), weight: 6, dashArray: '0.1 10', lineCap: 'round', interactive: false }).addTo(over);
    var st = path[0];
    mark(st, 'm-start').addTo(over);
    mark(st, 'm-text m-from at-l', '88서울올림픽<br>조각 앞').addTo(over);
    var exits = { '4': [37.516432, 127.130784] };
    if (x.name === '올림픽공원역') mark(exits['4'], 'm-exit on', '4').addTo(over);
    if (x.kind === 'bus') {
      var h = heading(x.k), other = x.k === 'machon' ? 'gangbyeon' : 'machon', c = css('--bus-text');
      L.polyline([h[0], h[1]], { renderer: sv, color: c, weight: 5, lineCap: 'round', interactive: false }).addTo(over);
      // 화살촉은 화면 픽셀 기준으로 그린다
      var p1 = map.project(h[1], z), p0 = map.project(h[2], z), an = Math.atan2(p1.y - p0.y, p1.x - p0.x);
      var wing = function (d) { return map.unproject([p1.x - Math.cos(an + d) * 13, p1.y - Math.sin(an + d) * 13], z); };
      L.polyline([wing(.6), h[1], wing(-.6)], { renderer: sv, color: c, weight: 5, lineCap: 'round', lineJoin: 'round', interactive: false }).addTo(over);
      mark(ST[other], 'm-dot off').addTo(over);
      mark(ST[other], 'm-tag off ' + (other === 'machon' ? 'at-l' : 'at-r'), (other === 'machon' ? '24244 마천동' : '24245 강변역')).addTo(over);
      mark(ST[x.k], 'm-dot').addTo(over);
      mark(ST[x.k], 'm-tag on ' + (x.k === 'machon' ? 'at-bl' : 'at-r'), '<b>' + x.o.ars_id + '</b>').addTo(over);
    } else {
      var e = x.name === '올림픽공원역' ? exits['4'] : path[path.length - 1];
      if (x.name !== '올림픽공원역') mark(e, 'm-exit on', '2').addTo(over);
      mark(e, 'm-tag plain at-b', x.name + ' ' + x.exit).addTo(over);
    }
  }
  // 출발점~목적지가 상단 띠와 시트 사이에 들어오게 맞춘다.
  // 애니메이션을 쓰지 않는다: 가려진 탭에서는 끝나지 않아 지도가 처음 위치에 남는다.
  function fit() {
    if (!map || !opts.length) return;
    map.stop();
    map.invalidateSize({ animate: false, pan: false });
    var x = opts[sel], b = L.latLngBounds(x.line.map(ll)), wide = innerWidth >= 768, s = $('sheet');
    if (x.kind === 'bus') b.extend(ST.machon).extend(ST.gangbyeon).extend(heading(x.k)[1]);
    var sh = s.offsetHeight - down;
    if (!wide) sh = Math.min(sh, innerHeight * .7);
    map.getContainer().querySelector('.leaflet-bottom').style.cssText = wide ? 'left:440px' : 'bottom:' + sh + 'px';
    map.fitBounds(b, { animate: false, paddingTopLeft: [wide ? 520 : 92, 112], paddingBottomRight: [wide ? 80 : x.kind === 'bus' ? 116 : 84, wide ? 40 : sh + (x.kind === 'bus' ? 30 : 54)] });
    overlay();
  }
})();
