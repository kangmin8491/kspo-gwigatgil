/* 귀갓길 — 시연용 모바일 웹
 * 화면: #/ 방면 고르기 · #/go/<id> 탑승 위치 · #/event 공연 고르기 · #/car 출차 그래프
 * 주소 인자: ?mode=live (실시간), ?s=basic|hurry|ended|fail (시연 상황, 예시값), ?lang=en (영어)
 * 정류소 확인: #/go/bus-<방면>?at=24244|24245|none (표지판 번호를 누른 결과)
 */
(function () {
  'use strict';

  var HURRY = 2;             // 도착 예정 − 도보 ≥ 2분이면 '탈 수 있음' (기획서 초기값)
  var REFRESH_MS = 30000;
  var STALE_MS = 5 * 60000;  // 응답이 이보다 오래되면 '조회 불가'
  var WALK_M_MIN = 75;       // 시속 4.5km (귀가동선.json walking_method)
  var BUS_WEB = 'https://bus.go.kr/app/';
  var METRO = 'https://www.seoulmetro.co.kr/kr/cyberStation.do';

  var $ = function (id) { return document.getElementById(id); };
  var css = function (n) { return getComputedStyle(document.documentElement).getPropertyValue(n).trim(); };
  var q = new URLSearchParams(location.search);
  var lang = q.get('lang') === 'en' ? 'en' : 'ko';
  // 한 문장을 한국어·영어로 나란히 적는다
  function T(ko, en) { return lang === 'en' ? en : ko; }
  // 정류소·역·게이트 이름: 영어 화면에서는 영어 옆에 한글을 남긴다(표지판과 대조용)
  var NAME = { '올림픽공원역': 'Olympic Park Stn.', '한성백제역': 'Hanseong Baekje Stn.', '마천동': 'Macheon-dong', '강변역': 'Gangbyeon Stn.',
    '오금동대림아파트': 'Ogeum-dong Daelim Apt.', '보성중고등학교': 'Boseong Middle & High School', '동2문': 'East Gate 2', '남2문': 'South Gate 2', '북2문': 'North Gate 2' };
  function nm(k) { return lang === 'en' && NAME[k] ? NAME[k] + ' (' + k + ')' : k; }
  function dirName(d) { return T(d + ' 방면', 'to ' + nm(d)); }
  function exitName(x) { return T(x.exit, 'Exit ' + x.exit.charAt(0)); }
  function gateName(g) { return g === '기타' ? T('기타', 'Other') : nm(g); }

  // 걷는 방법 문장: 소스/KSPO DOME 귀가 동선표.md, 귀가동선.json(side)
  var BUS = {
    machon: {
      short: function () { return T('공원 쪽', 'park side'); },
      where: function () { return T('공원 쪽, 올림픽공원역 4번 출구 앞', 'park side, in front of Exit 4 of ' + nm('올림픽공원역')); },
      walk: function () { return T('올림픽공원역으로 이동해 <b>공원 쪽</b>, 역 3번 출구와 같은 쪽에 섭니다. 양재대로를 건너지 않습니다.',
        'Walk toward ' + nm('올림픽공원역') + ' and stand on the <b>park side</b>, the same side as Exit 3. You do not cross Yangjae-daero (양재대로).'); },
      cross: function () { return T('양재대로의 <b>신호 횡단보도</b>를 건너 <b>공원 쪽, 4번 출구 앞</b> 정류장으로 가세요.',
        'Cross Yangjae-daero (양재대로) at the <b>signalized crosswalk</b> to the stop on the <b>park side, in front of Exit 4</b>.'); }
    },
    gangbyeon: {
      short: function () { return T('길 건너 1번 출구 쪽', 'across the road, Exit 1 side'); },
      where: function () { return T('양재대로 길 건너, 올림픽공원역 1번 출구 쪽', 'across Yangjae-daero (양재대로), Exit 1 side of ' + nm('올림픽공원역')); },
      walk: function () { return T('올림픽공원역 쪽에서 <b>양재대로의 신호 횡단보도를 건너</b>, 역 1번 출구와 같은 쪽 정류장으로 갑니다.',
        'From the ' + nm('올림픽공원역') + ' side, <b>cross Yangjae-daero (양재대로) at the signalized crosswalk</b> to the stop on the same side as Exit 1.'); },
      cross: function () { return T('양재대로의 <b>신호 횡단보도</b>를 건너 <b>1번 출구 쪽</b> 정류장으로 가세요.',
        'Cross Yangjae-daero (양재대로) at the <b>signalized crosswalk</b> to the stop on the <b>Exit 1 side</b>.'); }
    }
  };
  // 2026-11-24 서울시 응답의 막차·배차. 2025-11-01 당일 값은 확보하지 못했다.
  var SCHEDULE = { machon: { last: '00:22', term: 13 }, gangbyeon: { last: '23:39', term: 13 } };
  // 시연 상황 — 모두 예시값(분)
  var SC = {
    basic: { label: ['기본', 'Default'], date: ['2025년 11월 1일', 'Nov 1, 2025'], clock: '20:50', eta: { machon: [9, 22], gangbyeon: [5, 18] } },
    hurry: { label: ['도착이 촉박할 때', 'Tight timing'], date: ['2025년 11월 1일', 'Nov 1, 2025'], clock: '21:10', eta: { machon: [7, 20], gangbyeon: [9, 22] } },
    ended: { label: ['막차 이후', 'After last bus'], date: ['2025년 11월 2일', 'Nov 2, 2025'], clock: '00:40', ended: true },
    fail: { label: ['조회 실패', 'Lookup failed'], date: ['2025년 11월 1일', 'Nov 1, 2025'], clock: '20:50', fail: true }
  };
  function pick(a) { return a[lang === 'en' ? 1 : 0]; }
  var MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var AT = { '24244': 1, '24245': 1, none: 1 };

  var mode = q.get('mode') === 'live' ? 'live' : 'demo', sc = SC[q.get('s')] ? q.get('s') : 'basic';
  var opts = [], sel = 0, view = 'home', live = {}, timer = null, D, map, base, over, attr, exitData, gate = 'all', at = null;

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function badge(n) { return '<span class="badge s' + n + '">' + n + '</span>'; }
  function link(u, t) { return '<a href="' + esc(u) + '" target="_blank" rel="noopener">' + t + '</a>'; }
  function json(u) { return fetch(u).then(function (r) { if (!r.ok) throw new Error(u); return r.json(); }); }

  statics();
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
  }).catch(function () { $('view').innerHTML = '<p class="pad">' + T('동선 자료를 불러오지 못했습니다. 새로고침해 주세요.', 'Could not load the route data. Please refresh.') + '</p>'; });

  // ---------- 버스 도착 ----------
  function pack(x, list) { // list: [{sec,msg,isLast}]
    var buses = list.slice(0, 2).map(function (b) {
      var m = b.sec == null ? null : Math.floor(b.sec / 60), gap = b.sec == null ? null : b.sec / 60 - x.walk;
      return { min: m, gap: gap, msg: b.msg, isLast: b.isLast,
        cls: gap == null ? '' : gap >= HURRY ? 'ok' : gap >= 0 ? 'hurry' : 'miss',
        text: gap == null ? T('확인 필요', 'Check') : gap >= HURRY ? T('탈 수 있음', 'You can make it') : gap >= 0 ? (x.k === 'gangbyeon' ? T('신호에 따라 다름', 'Depends on the signal') : T('서두르면 가능', 'Hurry')) : T('놓칠 수 있음', 'May miss') };
    });
    var f = -1;
    buses.forEach(function (b, i) { if (f < 0 && (b.cls === 'ok' || b.cls === 'hurry')) f = i; });
    return { status: 'ok', buses: buses, f: f };
  }
  function arrival(x) {
    var s = SCHEDULE[x.k], a, note = T('2026년 11월 24일 서울시 조회값', 'Seoul data, Nov 24, 2026');
    if (mode === 'demo') {
      var c = SC[sc];
      a = c.fail ? { status: 'fail' } : c.ended ? { status: 'ended' } : pack(x, c.eta[x.k].map(function (m) { return { sec: m * 60 }; }));
      a.last = s.last; a.term = s.term; a.lastNote = note;
      return a;
    }
    var j = live[x.k];
    if (!j) return { status: 'load' };
    var made = j.mkTm ? Date.parse(j.mkTm) : Date.now(), age = Math.max(0, Date.now() - made);
    if (!j.ok || age > STALE_MS) return { status: 'fail', last: s.last, term: s.term, lastNote: note };
    a = j.ended ? { status: 'ended' } : pack(x, (j.buses || []).map(function (b) {
      return { sec: b.sec == null ? null : Math.max(0, b.sec - age / 1000), msg: b.msg, isLast: b.isLast };
    }));
    a.last = j.lastTm && j.lastTm.length >= 12 ? j.lastTm.slice(8, 10) + ':' + j.lastTm.slice(10, 12) : null;
    a.term = j.term; a.lastNote = T('오늘 서울시 응답', 'Seoul data today'); a.asOf = j.mkTm && j.mkTm.slice(11, 19);
    return a;
  }
  // 서울시 응답 문구(arrmsg). 영어 화면에서 아는 형식만 옮기고 나머지는 원문을 둔다.
  function busMsg(m) {
    if (!m || lang !== 'en') return m;
    var r = /^(\d+)분(?:(\d+)초)?후\[(\d+)번째 전\]$/.exec(m);
    if (r) return 'in ' + r[1] + ' min' + (r[2] ? ' ' + r[2] + ' s' : '') + ' (' + r[3] + ' stops away)';
    return { '곧 도착': 'Arriving soon', '운행종료': 'Service ended', '출발대기': 'Waiting to depart', '정보 없음': 'No info' }[m] || m;
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
    var d = new Date(), two = function (n) { return (n < 10 ? '0' : '') + n; }, hm = two(d.getHours()) + ':' + two(d.getMinutes());
    $('mode').textContent = mode === 'live' ? T('실시간', 'LIVE') : T('시연', 'DEMO');
    $('clock').textContent = mode === 'live' ? T((d.getMonth() + 1) + '월 ' + d.getDate() + '일 ', MON[d.getMonth()] + ' ' + d.getDate() + ' ') + hm : pick(SC[sc].date) + ' ' + SC[sc].clock;
    $('modeBtn').textContent = mode === 'live' ? T('시연 보기', 'Demo') : T('실시간 보기', 'Live');
  }
  // 언어에 따라 바뀌는 고정 문구(index.html)
  function statics() {
    document.documentElement.lang = lang;
    document.title = T('귀갓길', 'Gwigatgil (귀갓길) — getting home from KSPO DOME');
    $('map').setAttribute('aria-label', T('한얼광장에서 정류장까지 걸어가는 길 지도', 'Map of the walk from Haneol Plaza to the stop'));
    $('grip').setAttribute('aria-label', T('안내판 올리기·내리기', 'Raise or lower the panel'));
    var b = $('langBtn');
    b.textContent = T('EN', '한국어'); b.lang = T('en', 'ko'); b.setAttribute('aria-label', T('English', '한국어로 보기'));
    if (attr) { attr.remove(); addAttr(); }
  }
  function params() {
    var p = new URLSearchParams(location.search);
    if (mode === 'live') p.set('mode', 'live'); else p.delete('mode');
    if (mode === 'demo' && sc !== 'basic') p.set('s', sc); else p.delete('s');
    if (lang === 'en') p.set('lang', 'en'); else p.delete('lang');
    var s = p.toString();
    history.replaceState(null, '', location.pathname + (s ? '?' + s : '') + location.hash);
  }
  $('modeBtn').addEventListener('click', function () {
    mode = mode === 'live' ? 'demo' : 'live'; live = {};
    params(); route(); refresh();
  });
  $('langBtn').addEventListener('click', function () {
    var y = $('view').scrollTop;
    lang = lang === 'en' ? 'ko' : 'en'; exitData = exitData && exitData.raw ? norm(exitData.raw) : exitData;
    params(); statics(); route(); $('view').scrollTop = y;
  });

  // ---------- 화면 1: 방면 고르기 ----------
  function num(n, unit, t, cls) {
    return '<span class="num ' + (cls || '') + '"><span class="n">' + n + '</span><span class="u">' + unit + '</span><span class="t">' + t + '</span></span>';
  }
  function eg() { return mode === 'demo' ? T('예시 · ', 'Sample · ') : ''; }
  function bar(x, b) {
    var h = '<span class="bar"><i class="w" style="flex:' + (x.kind === 'sub' ? '1 1 auto' : x.walk + ' 0 auto') + '">' + T('도보 ' + x.walk + '분', 'Walk ' + x.walk + ' min') + '</i>';
    if (x.kind === 'sub') return h + x.lines.map(function (l) { return '<i class="l' + l + '">' + T(l + '호선', 'Line ' + l) + '</i>'; }).join('') + '</span>';
    var w = b ? b.min - x.walk : 0;
    return h + (w > 0 ? '<i class="g" style="flex:' + Math.min(w, 12) + ' 0 auto">' + T('대기 ' + w + '분', 'Wait ' + w + ' min') + '</i>' : '') + '<i class="b">' + T('3214번 →', 'Bus 3214 →') + '</i></span>';
  }
  function row(x, i) {
    var on = i === sel, h = '<button type="button" class="row' + (on ? ' on' : '') + '" aria-pressed="' + on + '" data-i="' + i + '"><span class="who">';
    if (x.kind === 'sub') {
      h += '<span class="name">' + x.lines.map(badge).join('') + nm(x.name) + '</span><span class="sub">' + exitName(x) + (x.crowd ? T(' · 올림픽공원역이 붐빌 때', ' · when ' + NAME['올림픽공원역'] + ' is crowded') : T(' · 공원 쪽', ' · park side')) + '</span></span>' +
        num(x.walk, T('분', 'min'), T('걸어서', 'walk'), 'walk');
      return h + (on ? bar(x) : '') + '</button>';
    }
    var a = arrival(x), b = a.status === 'ok' ? a.buses[Math.max(a.f, 0)] : null;
    if (a.status === 'ok' && a.f < 0 && a.buses[1] && a.buses[1].min != null) b = a.buses[1];
    h += '<span class="name"><span class="badge">3214</span>' + esc(dirName(x.o.direction)) + '</span><span class="sub">' +
      (on ? T('정류소 ', 'Stop ') + '<b>' + x.o.ars_id + '</b> · ' + BUS[x.k].short() + '<br>' + T('다음 정류장 ', 'Next stop: ') + esc(nm(x.o.next_stop))
        : a.f === 1 && a.buses[0].min != null ? T('앞차 ' + a.buses[0].min + '분은 놓칠 수 있음', 'May miss the bus in ' + a.buses[0].min + ' min') : T('도보 ' + x.walk + '분 → 정류소 ', x.walk + '-min walk → Stop ') + x.o.ars_id) + '</span></span>';
    if (b && b.min != null) h += num(b.min < 1 ? T('곧', 'Now') : b.min, b.min < 1 ? '' : T('분', 'min'), (on ? T('버스 ' + (b.min < 1 ? '곧 도착' : b.min + '분 뒤 도착'), 'Bus ' + (b.min < 1 ? 'arriving' : 'in ' + b.min + ' min')) + '<br>' : '') + eg() + '<span class="' + b.cls + '">' + b.text + '</span>' + (b.isLast ? T(' · 막차', ' · last bus') : ''));
    else h += '<span class="num"><span class="u">' + ({ ended: T('운행 종료', 'Service ended'), fail: T('조회 불가', 'Unavailable'), load: T('조회 중', 'Loading') }[a.status] || esc(busMsg((b && b.msg) || T('도착 정보 없음', 'No arrival info')))) + '</span><span class="t">' + (a.last ? T('막차 ', 'Last bus ') + a.last : '') + '</span></span>';
    if (on) h += bar(x, b && b.min != null && b.cls !== 'miss' ? b : null) + (a.f === 1 && a.buses[0].min != null ? '<span class="miss1">' + T('앞차 ' + a.buses[0].min + '분은 걷는 동안 지나갈 수 있습니다', 'The bus in ' + a.buses[0].min + ' min may pass while you walk') + '</span>' : '') +
      (a.last && b && b.min != null ? '<span class="miss1">' + T('막차 ', 'Last bus ') + '<b>' + a.last + '</b> · ' + a.lastNote + '</span>' : '');
    return h + '</button>';
  }
  function list() {
    var box = $('list'); if (!box) return;
    var had = document.activeElement && box.contains(document.activeElement) ? document.activeElement.dataset.i : null;
    box.innerHTML = opts.map(row).join('');
    if (had != null) box.querySelector('[data-i="' + had + '"]').focus({ preventScroll: true });
  }
  function home() {
    $('view').innerHTML = '<div class="event"><p><b>KSPO DOME</b> ' + T('아이브 서울 2회차 18:00', 'IVE Seoul show 2 · 18:00') + '</p><button type="button" data-go="#/event" aria-label="' + T('공연 바꾸기', 'Change show') + '">' + T('바꾸기', 'Change') + '</button></div>' +
      '<h1 tabindex="-1">' + T('어느 쪽으로 가세요?', 'Which way are you going?') + '</h1><p class="lead">' + T('KSPO DOME 현장 귀가 안내 · 목적지 입력 없이 방면만 고르세요', 'Getting home from KSPO DOME · Just pick a direction, no destination needed') + '</p>' +
      '<div id="list" role="group" aria-label="' + T('가는 방면', 'Directions') + '"></div>' +
      '<button type="button" class="goto" data-go="#/car"><b>' + T('자가용으로 오셨나요?', 'Came by car?') + '</b><span>' + T('게이트별 출차 보기 →', 'Exits by gate →') + '</span></button>' +
      scenario() + '<p class="foot">' + (mode === 'demo' ? T('버스 도착 시간은 시연용 예시값입니다. 막차는 2026년 11월 24일 서울시 조회값입니다. ', 'Bus arrival times are sample values for the demo. Last bus times are Seoul data from Nov 24, 2026. ')
        : T('실시간 보기에서도 공연은 시연 회차로 고정됩니다. ', 'In live view, the show stays fixed to the demo show. ')) +
      T('도보는 지도 경로 추정이며 신호 대기와 공연장 안에서 걷는 시간은 빠져 있습니다.<br>자료: 한국체육산업개발 · 서울특별시 · OpenStreetMap',
        'Walking times are map estimates and exclude waiting at signals and walking inside the venue.<br>Data: KSPO&amp;CO (한국체육산업개발) · Seoul Metropolitan Government · OpenStreetMap') + '</p>';
    list();
  }

  // ---------- 화면 2: 탑승 위치 ----------
  function etaBlock(x) {
    var a = arrival(x), h = '';
    var last = a.last ? '<p class="note">' + T('막차 ', 'Last bus ') + '<b>' + a.last + '</b>' + (a.term ? T(' · 배차 약 ' + a.term + '분', ' · every ~' + a.term + ' min') : '') + ' <span class="small">' + a.lastNote + '</span></p>' : '';
    if (a.status === 'load') return '<p class="state">' + T('조회 중', 'Loading') + '</p><p class="note">' + T('서울시 버스도착정보를 불러오고 있습니다.', 'Getting Seoul bus arrival data.') + '</p>';
    if (a.status === 'fail') return '<p class="state">' + T('도착 시간 조회 불가', 'Arrival time unavailable') + '</p><p class="note">' + T('지금은 도착 시간을 불러올 수 없습니다. 아래 정류장 위치와 방향은 그대로입니다.', 'Arrival times can’t be loaded right now. The stop location and direction below still apply.') + '</p><p class="links">' +
      link(BUS_WEB, T('서울시 버스정보에서 확인', 'Check on Seoul Bus Info (Korean)')) + (mode === 'live' ? '<button type="button" data-retry>' + T('다시 조회', 'Try again') + '</button>' : '') + '</p>' + last;
    if (a.status === 'ended') return '<p class="state">' + T('운행 종료', 'Service ended') + '</p><p class="note">' + T('3214번 ' + esc(x.o.direction) + ' 방면 운행이 끝났습니다. 지하철로 가세요.', 'Bus 3214 ' + esc(dirName(x.o.direction)) + ' has stopped running. Take the subway.') + '</p><p class="links">' +
      '<button type="button" data-go="#/go/subway-hanseong">' + T('한성백제역 가는 길', 'Route to ' + nm('한성백제역')) + '</button>' + link(METRO, T('지하철 막차 확인', 'Subway last trains')) + '</p>' + last;
    if (!a.buses.length) return '<p class="state">' + T('도착 예정 버스 없음', 'No buses expected') + '</p>' + last;
    h += '<div class="etas">' + a.buses.map(function (b, i) {
      return '<div class="eta ' + b.cls + (i === a.f || (a.f < 0 && i === 0 && b.min == null) ? ' on' : '') + '"><span class="k">' + (i ? T('다음 버스 도착', 'Following bus') : T('첫 버스 도착', 'Next bus')) + (b.isLast ? T(' · 막차', ' · last bus') : '') + (mode === 'demo' ? T(' · 예시', ' · sample') : '') + '</span>' +
        (b.min == null ? '<span class="u">' + esc(busMsg(b.msg) || T('정보 없음', 'No info')) + '</span>' : '<span class="n">' + (b.min < 1 ? T('곧', 'Now') : b.min) + '</span>' + (b.min < 1 ? '' : '<span class="u">' + T('분', 'min') + '</span>')) +
        '<span class="v ' + b.cls + '">' + b.text + '</span></div>';
    }).join('') + '</div>';
    var b = a.buses[a.f];
    h += bar(x, b);
    if (x.k === 'gangbyeon') h += '<p class="small">' + T('도보 약 ' + x.walk + '분 · 신호 대기 별도', 'About ' + x.walk + ' min walk, plus waiting at the signal') + '</p>';
    if (b) h += '<p class="small">' + T('도착 ' + b.min + '분 − 도보 ' + x.walk + '분 = 여유 ' + Math.floor(b.gap) + '분 (' + HURRY + '분 이상이면 탈 수 있음)',
      'Arrives in ' + b.min + ' min − ' + x.walk + ' min walk = ' + Math.floor(b.gap) + ' min to spare (' + HURRY + '+ min: you can make it)') + '</p>';
    else if (a.buses.every(function (y) { return y.cls === 'miss'; })) h += '<p class="note">' + T('두 버스 모두 걷는 동안 지나갈 수 있습니다. 그다음 차는 배차 간격' + (a.term ? '(약 ' + a.term + '분)' : '') + '을 참고하거나 지하철을 이용하세요.',
      'Both buses may pass while you walk. For the one after, check the interval' + (a.term ? ' (about ' + a.term + ' min)' : '') + ' or take the subway.') + '</p>';
    if (a.asOf) h += '<p class="small">' + T('서울시 응답 ', 'Seoul data at ') + a.asOf + (b && b.msg ? ' · ' + esc(busMsg(b.msg)) : '') + T(' · 30초마다 갱신', ' · refreshes every 30 s') + '</p>';
    return h + last;
  }

  // ---------- 정류소 확인 ----------
  // 고른 방면(x.k)과 표지판 번호(at)를 비교한다. 맞으면 탑승, 다르면 길 건너기, 못 찾으면 찾는 법.
  function verdict(x) {
    if (!at) return '';
    var other = x.k === 'machon' ? 'gangbyeon' : 'machon', oo = opts[x.k === 'machon' ? 1 : 0].o, h, c;
    if (at === x.o.ars_id) {
      return '<div class="verdict ok"><p class="head">' + T('여기서 타세요', 'Board here') + '</p><p class="note">' + T('정류소 ', 'Stop ') + '<b>' + at + '</b> · ' + esc(dirName(x.o.direction)) + T('. 이 정류소의 버스 도착 정보입니다.', '. Bus arrivals at this stop:') + '</p>' +
        '<div id="arr" aria-live="polite">' + etaBlock(x) + '</div></div>';
    }
    if (at !== 'none') {
      c = crossPath(x.k); h = Math.round(plen(c) / 10) * 10;
      return '<div class="verdict no"><p class="head">' + T(esc(x.o.direction) + ' 방면은 길 건너편이에요', 'Buses ' + esc(dirName(x.o.direction)) + ' stop across the road') + '</p>' +
        '<p class="to"><span>' + T('타는 곳', 'Board at') + '</span><b class="plate-big">' + x.o.ars_id + '</b><span>' + esc(nm(x.o.stop_name)) + ' · ' + BUS[x.k].short() + '</span></p>' +
        '<p class="note">' + T('지금 계신 <b>' + at + '</b>는 ' + esc(oo.direction) + ' 방면 정류소입니다.', 'You are at Stop <b>' + at + '</b>, for buses ' + esc(dirName(oo.direction)) + '.') + '</p>' +
        '<p class="note">' + BUS[x.k].cross() + '</p><p class="small">' + T('약 ' + h + 'm · ' + Math.ceil(plen(c) / WALK_M_MIN) + '분, 신호 대기 별도 (지도 경로 추정)', 'About ' + h + ' m · ' + Math.ceil(plen(c) / WALK_M_MIN) + ' min, plus waiting at the signal (map estimate)') + '</p></div>';
    }
    return '<div class="verdict none"><p class="head">' + T('표지판에서 다섯 자리 번호를 찾아 보세요', 'Look for the 5-digit number on the sign') + '</p>' +
      '<p class="note">' + T('정류장 표지판이나 안내판에 정류장 이름 ‘올림픽공원역’과 함께 적힌 다섯 자리 숫자가 정류소 번호입니다. 숫자 사이에 줄(-)이 있어도 같은 번호입니다.',
        'The stop number is the 5-digit number shown with the stop name ‘올림픽공원역’ on the stop sign or information panel. If there is a hyphen between the digits, it is the same number.') + '</p>' +
      '<dl class="kv sm where"><dt>24244</dt><dd>' + esc(dirName('마천동')) + '<small>' + BUS.machon.where() + '</small></dd><dt>24245</dt><dd>' + esc(dirName('강변역')) + '<small>' + BUS.gangbyeon.where() + '</small></dd></dl>' +
      '<p class="note">' + T('이름이 같은 두 정류장 중 양재대로를 건너지 않은 쪽이 24244입니다. 고르신 ' + esc(x.o.direction) + ' 방면은 <b>' + x.o.ars_id + '</b>입니다.',
        'Of the two stops with the same name, the one you reach without crossing Yangjae-daero (양재대로) is 24244. You chose ' + esc(dirName(x.o.direction)) + ': <b>' + x.o.ars_id + '</b>.') + '</p></div>';
  }
  function checkBlock(x) {
    var b = function (v, html, cls) { return '<button type="button" class="' + (cls || '') + '" data-at="' + v + '" aria-pressed="' + (at === v) + '">' + html + '</button>'; };
    return '<section class="block check" id="chk"><h2>' + T('정류소에 도착했나요?', 'Are you at the stop?') + '</h2><p class="note">' + T('표지판 번호를 눌러 확인하세요.', 'Tap the number on the stop sign to check.') + '</p>' +
      '<div class="pick" role="group" aria-label="' + T('표지판 번호', 'Number on the sign') + '">' + ['24244', '24245'].map(function (n) { return b(n, '<small>' + T('표지판에', 'Sign says') + '</small><b>' + n + '</b>'); }).join('') +
      b('none', T('번호를 찾을 수 없어요', 'I can’t find the number'), 'wide') + '</div>' +
      '<div id="verdict" aria-live="polite">' + verdict(x) + '</div>' + (at ? '<p class="links"><button type="button" data-at="">' + T('다시 확인', 'Check again') + '</button></p>' : '') + '</section>';
  }

  function go(x) {
    var h = '<button type="button" class="back" data-go="#/">' + T('← 방면 다시 고르기', '← Choose another direction') + '</button>';
    if (x.kind === 'bus') {
      var ot = opts[x.k === 'machon' ? 1 : 0].o;
      h += '<h1 class="route" tabindex="-1"><span class="badge">3214</span>' + esc(dirName(x.o.direction)) + '</h1>' +
        '<section class="block first"><dl class="kv"><dt>' + T('정류소', 'Stop') + '</dt><dd>' + x.o.ars_id + ' <small>' + esc(nm(x.o.stop_name)) + '</small></dd>' +
          '<dt>' + T('다음 정류장', 'Next stop') + '</dt><dd>' + esc(nm(x.o.next_stop)) + ' <small>' + x.o.next_ars_id + '</small></dd></dl></section>' +
        (at === x.o.ars_id ? '' : '<section class="block" id="arr" aria-live="polite">' + etaBlock(x) + '</section>') +
        checkBlock(x) +
        '<section class="block"><h2>' + T('길 어느 쪽에 서나요', 'Which side of the road?') + '</h2>' + road(x.k) +
          '<p class="note">' + BUS[x.k].walk() + '</p><p class="note">' + T('이름이 같은 정류장이 길 건너에 하나 더 있습니다. <b>' + ot.ars_id + '</b>는 ' + esc(ot.direction) + ' 방면입니다.',
            'A stop with the same name is across the road. <b>' + ot.ars_id + '</b> is for buses ' + esc(dirName(ot.direction)) + '.') + '</p></section>' +
        '<section class="block"><h2>' + T('걸어가는 길', 'Walking route') + '</h2><dl class="kv sm"><dt>' + T('출발', 'From') + '</dt><dd>' + T('한얼광장 ‘88서울올림픽’ 조각 앞', 'Haneol Plaza (한얼광장), at the ‘88서울올림픽’ sculpture') + '</dd><dt>' + T('도보', 'Walk') + '</dt><dd>' + T('약 ' + x.m + 'm · ' + x.walk + '분', 'About ' + x.m + ' m · ' + x.walk + ' min') + (x.k === 'gangbyeon' ? ' <small>' + T('신호 대기 별도', 'plus signal wait') + '</small>' : '') + '</dd></dl></section>' +
        scenario() + sources(T('정류소: 서울시 버스 노선별 정류소 원자료(2025-10-02, 2025-11-03, 2026-09-02판 대조). 도착·막차: 서울시 버스도착정보. 도보: OpenStreetMap 보행로(2026-11-24 조회, 현장 실측 아님). 정류소·출구의 앞뒤 순서는 OpenStreetMap 좌표를 따랐고 그림의 거리는 실제 비율이 아닙니다.',
          'Stops: Seoul bus route-stop data (2025-10-02, 2025-11-03 and 2026-09-02 editions compared). Arrivals and last bus: Seoul bus arrival data. Walking: OpenStreetMap footpaths (retrieved 2026-11-24, not measured on site). The order of stops and exits follows OpenStreetMap coordinates; distances in the drawing are not to scale.'), D.r.sources);
    } else {
      var oly = x.id === 'subway-olympic', km = x.m >= 1000 ? (x.m / 1000).toFixed(1) + T('km', ' km') : x.m + T('m', ' m');
      h += '<h1 class="route" tabindex="-1">' + x.lines.map(badge).join('') + nm(x.name) + '</h1>' +
        '<section class="block first"><div class="etas"><div class="eta on"><span class="k">' + T('걸어서', 'Walk') + '</span><span class="n">' + x.walk + '</span><span class="u">' + T('분', 'min') + '</span></div>' +
          '<div class="eta"><span class="k">' + T('들어가는 곳', 'Enter at') + '</span>' + T('<span class="n">' + x.exit.charAt(0) + '</span><span class="u">번 출구</span>', '<span class="u pre">Exit</span><span class="n">' + x.exit.charAt(0) + '</span>') + '</div></div>' + bar(x) +
          '<p class="small">' + T('약 ' + km + '. ' + (oly ? '4번 출구까지의 지도 경로 추정입니다.' : '2번 출구 인근까지의 지도 경로 추정입니다. 예매처 안내는 약 20분입니다.'),
            'About ' + km + '. ' + (oly ? 'Map route estimate to Exit 4.' : 'Map route estimate to near Exit 2. The ticketing site says about 20 min.')) + '</p></section>';
      if (oly) h += '<section class="block"><h2>' + T('길 어느 쪽으로 들어가나요', 'Which side do you enter?') + '</h2>' + road('exit4') + '<p class="note">' + T('<b>4번 출구</b>는 공원 쪽에 있습니다. 양재대로를 건너지 않습니다.', '<b>Exit 4</b> is on the park side. You do not cross Yangjae-daero (양재대로).') + '</p></section>' +
        '<section class="block"><h2>' + T('5호선은 행선지를 확인하세요', 'Line 5: check the destination') + '</h2><p class="note">' + T('5호선은 강동역에서 마천 방면과 하남 방면으로 갈라집니다. 타기 전에 열차 행선지를 확인하세요.',
          'Line 5 splits at Gangdong Stn. (강동역) toward Macheon (마천) and Hanam (하남). Check the train’s destination before boarding.') + '</p></section>';
      else h += '<section class="block"><h2>' + T('올림픽공원역이 붐빌 때', 'When ' + NAME['올림픽공원역'] + ' is crowded') + '</h2><p class="note">' + T('예매처 공연장 안내는 공연 직후 올림픽공원역 혼잡을 피하려면 한성백제역이나 몽촌토성역을 권합니다.',
        'The ticketing site’s venue guide suggests ' + nm('한성백제역') + ' or Mongchontoseong Stn. (몽촌토성역) to avoid crowds at ' + nm('올림픽공원역') + ' right after a show.') + '</p></section>';
      h += '<section class="block"><h2>' + T('막차', 'Last train') + '</h2><p class="links">' + link(METRO, T('서울교통공사 역별 시간표', 'Seoul Metro station timetables (Korean)')) + '</p></section>' +
        sources(T('도보: OSRM 보행 경로(OpenStreetMap, 2026-11-24 조회, 현장 실측 아님). 출구 위치: OpenStreetMap.', 'Walking: OSRM footpath route (OpenStreetMap, retrieved 2026-11-24, not measured on site). Exit locations: OpenStreetMap.'), x.o.sources);
    }
    $('view').innerHTML = h;
  }
  function sources(t, urls) {
    return '<details class="pad"><summary>' + T('자료 출처', 'Sources') + '</summary><p>' + t + '</p><p>' + (urls || []).map(function (u, i) { return link(u, T('자료 ', 'Source ') + (i + 1)); }).join(' · ') + '</p></details>';
  }

  // 길 어느 쪽: 위가 북동쪽(KSPO DOME 쪽 길)인 약도. 왼쪽=공원 쪽, 오른쪽=1번 출구 쪽.
  // 출구·정류소의 위아래 순서는 OSM 좌표 순서다.
  function road(t) {
    var W = t === 'machon', E = t === 'gangbyeon', X = t === 'exit4', H = 232, s;
    var plate = function (x, y, n, on) { return '<rect class="' + (on ? 'plate' : 'off') + '" x="' + x + '" y="' + y + '" width="92" height="34" rx="6"/><text class="' + (on ? 'plate-t' : 'off-t') + '" x="' + (x + 46) + '" y="' + (y + (on ? 25 : 23)) + '">' + n + '</text>'; };
    var exit = function (x, y, n, on) { return '<rect class="ex' + (on ? ' on' : '') + '" x="' + x + '" y="' + y + '" width="54" height="20" rx="4"/><text class="ex-t' + (on ? ' on' : '') + '" x="' + (x + 27) + '" y="' + (y + 14) + '">' + T(n + '번 출구', 'Exit ' + n) + '</text>'; };
    var me = function (x, y) { return '<circle class="me" cx="' + x + '" cy="' + y + '" r="5"/><path class="me" d="M' + (x - 7) + ' ' + (y + 22) + 'v-9a7 7 0 0 1 14 0v9z"/>'; };
    var bus = function (x, y) { return '<rect class="bus" x="' + x + '" y="' + y + '" width="38" height="50" rx="7"/><rect class="glass" x="' + (x + 6) + '" y="' + (W ? y + 39 : y + 5) + '" width="26" height="6" rx="2"/><text class="bus-t" x="' + (x + 19) + '" y="' + (W ? y + 25 : y + 33) + '">3214</text>'; };
    var label = W ? T('공원 쪽 정류소 24244에 서고 버스는 아래쪽 마천동 방면으로 갑니다. 길 건너 24245는 강변역 방면입니다.', 'Stand at Stop 24244 on the park side; the bus goes down toward Macheon-dong. Stop 24245 across the road is for Gangbyeon.')
      : E ? T('신호 횡단보도를 건너 1번 출구 쪽 정류소 24245에 서고 버스는 위쪽 강변역 방면으로 갑니다. 길 건너기 전 24244는 마천동 방면입니다.', 'Cross at the signalized crosswalk and stand at Stop 24245 on the Exit 1 side; the bus goes up toward Gangbyeon. Stop 24244 before crossing is for Macheon-dong.')
      : T('4번 출구는 공원 쪽, 정류소 24244와 3번 출구 사이에 있습니다.', 'Exit 4 is on the park side, between Stop 24244 and Exit 3.');
    s = '<svg class="road" viewBox="0 0 343 ' + H + '" role="img" aria-label="' + label + '">' +
      '<rect class="rd" x="120" y="0" width="104" height="' + H + '"/><line class="mid" x1="172" x2="172" y1="26" y2="' + H + '"/>' +
      '<text class="sm" x="172" y="17">' + T('양재대로', 'Yangjae-daero') + '</text><text class="side" x="6" y="17">' + T('공원 쪽', 'Park side') + '</text><text class="side" x="337" y="17" text-anchor="end">' + T('길 건너', 'Across') + '</text>';
    for (var i = 0; i < 9; i++) s += '<line class="zebra" x1="' + (126 + i * 11.5) + '" x2="' + (126 + i * 11.5) + '" y1="196" y2="216"/>';
    s += plate(6, 48, '24244', W) + '<text x="6" y="100" class="' + (W ? 'on-t' : '') + '">' + T('마천동 방면', 'To Macheon-dong') + '</text>' + exit(42, 112, 4, X) + exit(42, 158, 3) +
      exit(246, 36, 1) + plate(245, 76, '24245', E) + '<text x="337" y="128" text-anchor="end" class="' + (E ? 'on-t' : '') + '">' + T('강변역 방면', 'To Gangbyeon') + '</text>' + exit(246, 158, 2);
    if (W) s += '<path class="pw" d="M6 36H109V44"/>' + bus(127, 40) + '<path class="go" d="M146 102V170M133 157l13 13 13-13"/>' + '<path class="go off" d="M198 150V90M191 97l7-7 7 7"/>' + me(109, 56);
    if (E) s += '<path class="pw" d="M6 145H109V206H235V118"/>' + bus(179, 72) + '<path class="go" d="M198 64V36M185 47l13-13 13 13"/>' + '<path class="go off" d="M146 90V150M139 143l7 7 7-7"/>' + me(235, 84) +
      '<text class="sm" x="337" y="210" text-anchor="end" style="text-anchor:end">' + T('신호 횡단보도', 'Crosswalk') + '</text>';
    if (X) s += '<path class="pw" d="M6 145H30V122H34"/>';
    return s + '</svg>';
  }

  // ---------- 시연 상황 ----------
  function scenario() {
    if (mode !== 'demo') return '';
    return '<section class="block"><h2>' + T('시연 상황 바꾸기 (예시값)', 'Demo scenarios (sample values)') + '</h2><div class="chips">' + Object.keys(SC).map(function (k) {
      return '<button type="button" data-sc="' + k + '" aria-pressed="' + (k === sc) + '">' + pick(SC[k].label) + '</button>';
    }).join('') + '</div></section>';
  }

  // ---------- 공연 고르기 ----------
  function eventView() {
    var e = D.r.event;
    $('view').innerHTML = '<button type="button" class="back" data-go="#/">' + T('← 돌아가기', '← Back') + '</button><h1 tabindex="-1">' + T('어떤 공연을 보고 나오셨나요?', 'Which show did you just leave?') + '</h1><div class="pad">' +
      '<button type="button" class="ev" aria-pressed="true" data-go="#/"><b>KSPO DOME</b>' + esc(e.title) + '<i>' + T('2025년 11월 1일 토요일 18:00 · 서울 ' + e.session + '회차', 'Sat, Nov 1, 2025, 18:00 · Seoul show ' + e.session) + '</i></button>' +
      '<div class="ev no"><b>' + T('올림픽홀', 'Olympic Hall (올림픽홀)') + '</b>' + T('신승훈 공연', 'Shin Seung-hun concert') + '<i>' + T('같은 날 18:00 · 귀가 동선은 아직 준비되지 않았습니다', 'Same day 18:00 · Route guide not ready yet') + '</i></div>' +
      '<p class="small">' + T('공연의 실제 종료 시각은 공개 자료로 확인되지 않았습니다. 실시간 보기에서도 공연은 이 회차로 고정됩니다.', 'The actual end time of the show is not confirmed in public sources. In live view, the show stays fixed to this one.') + '</p>' +
      '<p class="links">' + link(e.source, T('공식 예매 공지', 'Official ticketing notice (Korean)')) + link(D.r.start.source, T('한얼광장 안내', 'Haneol Plaza guide (Korean)')) + '</p></div>';
  }

  // ---------- 출차 그래프 ----------
  // make_exit_counts.py 형식과 스크립트/출차분석.py 형식을 모두 받아 하나로 맞춘다.
  // 집계 파일의 설명(notes·comparison_basis)은 한국어라 영어 화면에서는 같은 뜻의 고정 문장을 쓴다.
  var EN_NOTES = ['Counts are 10-minute totals by exit time from the Olympic Park vehicle entry/exit records (KSPO&CO)',
    'These are exits for the whole park and cannot be attributed to one show alone (other events at the same time may be included)',
    '“Sharp rise” is the first 10-minute slot after 19:00 when park-wide exits are at least twice the comparison median and 30 or more. It does not mean the audience started leaving (the actual end time is unconfirmed)'];
  function norm(j) {
    if (j.series) return {
      raw: j, date: j.target_date, bins: j.series.map(function (x) { return x.t; }), gates: j.gates, n: (j.comparison_days || []).length,
      basis: T(j.comparison_basis, j.comparison_basis ? 'Median of ' + (j.comparison_days || []).length + ' weekdays in October 2025 with no show records and no evening (17–23h) rain, excluding the Chuseok holidays, the substitute holiday and Hangul Day. All 35 Saturdays with data in 2025 had a show, so a same-weekday comparison is not possible' : ''),
      cmpName: T('10월 공연 없고 비 오지 않은 평일 중앙값', 'Median of October weekdays with no show and no rain'),
      foot: T('자료가 있는 토요일에는 모두 공연이 있어 평일 ' + (j.comparison_days || []).length + '일과 비교', 'Every Saturday with data had a show, so the comparison uses ' + (j.comparison_days || []).length + ' weekdays'),
      by: j.gates.reduce(function (o, g) { o[g] = j.series.map(function (x) { return x.by_gate[g] || 0; }); return o; }, {}),
      cmp: (j.comparison_days || []).length ? { all: j.series.map(function (x) { return x.baseline_median || 0; }) } : null,
      start: j.exit_start && j.exit_start.t, peak: j.exit_peak && j.exit_peak.t, notes: lang === 'en' ? EN_NOTES : j.notes || []
    };
    var gs = j.gates || Object.keys(j.event_day.counts), c = j.comparison, sum = function (o) { return j.bins.map(function (_, i) { return gs.reduce(function (s, g) { return s + ((o[g] || [])[i] || 0); }, 0); }); };
    return { raw: j, date: j.event_day.date, bins: j.bins, gates: gs, by: j.event_day.counts, n: c ? c.dates.length : 0, basis: '', cmpName: c ? T('비교일 ' + c.dates.length + '일 중앙값', 'Median of ' + c.dates.length + ' comparison days') : '',
      cmp: c ? Object.assign({ all: sum(c.counts) }, c.counts) : null, start: j.markers && j.markers.surge_start, peak: j.markers && j.markers.peak, notes: lang === 'en' ? [] : j.notes || [] };
  }
  function car() {
    $('view').innerHTML = '<button type="button" class="back" data-go="#/">' + T('← 돌아가기', '← Back') + '</button><h1 tabindex="-1">' + T('공연일 게이트별 출차 (운영 참고)', 'Car exits by gate on show day (for operations)') + '</h1><p class="lead">' +
      T('관람객: 어느 게이트가 몰렸는지 · 운영자: 안내 인력 배치 참고', 'Visitors: which gates got busy · Operators: for planning guide staff') + '</p><div class="pad" id="car"><p class="note">' + T('불러오는 중…', 'Loading…') + '</p></div>';
    if (exitData) return chart();
    fetch('data/exit_counts.json', { cache: 'no-store' }).then(function (r) { if (!r.ok) throw 0; return r.json(); })
      .then(function (j) { exitData = norm(j); chart(); })
      .catch(function () {
        if ($('car')) $('car').innerHTML = '<p class="state">' + T('집계 준비 중', 'Being tallied') + '</p><p class="note">' + T('한국체육산업개발 ‘올림픽공원 입출차정보(전체구역)’ 원자료를 받는 중입니다. 집계가 끝나면 2025년 11월 1일의 출차를 출구 게이트(동2문·남2문·북2문)별로 10분 단위로 보여 줍니다.',
          'The KSPO&CO Olympic Park vehicle entry/exit records are being downloaded. Once tallied, this shows exits on Nov 1, 2025 by exit gate in 10-minute slots.') + '</p>';
      });
  }
  function nice(v) { var p = Math.pow(10, Math.floor(Math.log10(v))), f = v / p; return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 3 ? 3 : f <= 5 ? 5 : 10) * p; }
  function interval(t) { return t + T('~', '–') + t.slice(0, 4) + '9'; }
  function chart() {
    var box = $('car'), d = exitData; if (!box) return;
    var v = d.bins.map(function (_, i) { return gate === 'all' ? d.gates.reduce(function (s, g) { return s + (d.by[g][i] || 0); }, 0) : d.by[gate][i] || 0; });
    var c = d.cmp && d.cmp[gate], top = nice(Math.max.apply(null, v.concat(c || [], [1]))), eve = function (i) { return d.bins[i] >= '19:00'; }, late = v.map(function (n, i) { return eve(i) ? n : -1; });
    // 강조하는 막대는 19시 이후 최고(전체는 집계 파일의 exit_peak). 17시대 낮 출차가 더 많을 수 있어 하루 최고와 구분한다.
    var pk = gate === 'all' && d.bins.indexOf(d.peak) >= 0 ? d.bins.indexOf(d.peak) : late.indexOf(Math.max.apply(null, late));
    var scope = gate === 'all' ? T('공원 전체', 'Whole park') : gateName(gate), cars = function (n) { return T(n + '대', n + (n === 1 ? ' car' : ' cars')); };
    var peaks = d.bins.filter(function (_, i) { return eve(i) && v[i] === v[pk]; }).map(interval).join(', ');
    var sum19 = v.reduce(function (s, n, i) { return s + (eve(i) ? n : 0); }, 0);
    var W = 343, H = 220, l = 34, r = 4, t = 34, b = 24, pw = W - l - r, ph = H - t - b, sl = pw / d.bins.length;
    var y = function (n) { return t + ph - n / top * ph; }, X = function (i) { return l + i * sl; },
      s = '<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="' + T('10분 단위 출차 대수. 19시 이후 가장 많은 구간 ' + interval(d.bins[pk]) + ', ' + v[pk] + '대', 'Car exits per 10 minutes. Busiest slot after 19:00: ' + interval(d.bins[pk]) + ', ' + v[pk] + ' cars') + '">';
    [0, .5, 1].forEach(function (f) { s += '<line class="grid" x1="' + l + '" x2="' + (W - r) + '" y1="' + y(top * f) + '" y2="' + y(top * f) + '"/><text x="' + (l - 5) + '" y="' + (y(top * f) + 4) + '" text-anchor="end">' + top * f + '</text>'; });
    d.bins.forEach(function (k, i) {
      s += '<rect class="b' + (i === pk ? ' hi' : '') + '" x="' + (X(i) + .75) + '" y="' + y(v[i]) + '" width="' + Math.max(1, sl - 1.5) + '" height="' + (t + ph - y(v[i])) + '"/>';
      if (k.slice(3) === '00' && +k.slice(0, 2) % 2 === 0) s += '<text x="' + (X(i) + sl / 2) + '" y="' + (H - 6) + '" text-anchor="' + (i ? 'middle' : 'start') + '">' + T(+k.slice(0, 2) + '시', k) + '</text>';
    });
    if (c) s += '<polyline class="cmp" points="' + d.bins.map(function (_, i) { return X(i) + ',' + y(c[i] || 0) + ' ' + X(i + 1) + ',' + y(c[i] || 0); }).join(' ') + '"/>';
    if (gate === 'all') [[d.start, T('출차가 크게 늘어난 첫 10분', 'Sharp rise begins'), 12], [d.peak, T('가장 많은 10분', 'Busiest 10 min'), 26]].forEach(function (m) {
      var i = d.bins.indexOf(m[0]); if (i < 0) return;
      var x = X(i) + sl / 2, e = m[2] === 12 ? x > 130 : x > W - 100;
      s += '<line class="mk" x1="' + x + '" x2="' + x + '" y1="' + (m[2] - 8) + '" y2="' + (t + ph) + '"/><text x="' + (e ? x - 4 : x + 4) + '" y="' + m[2] + '" text-anchor="' + (e ? 'end' : 'start') + '">' + m[1] + '</text>';
    });
    d.bins.forEach(function (_, i) { s += '<rect data-b="' + i + '" x="' + X(i) + '" y="0" width="' + sl + '" height="' + H + '" fill="transparent"/>'; });
    box.innerHTML = '<div class="chips">' + ['all'].concat(d.gates).map(function (g) { return '<button type="button" data-gate="' + esc(g) + '" aria-pressed="' + (g === gate) + '">' + (g === 'all' ? T('전체', 'All') : esc(gateName(g))) + '</button>'; }).join('') + '</div>' +
      '<p class="note">' + (gate === 'all' && d.start && d.peak
        ? T('출차가 크게 늘어난 첫 10분: ' + interval(d.start) + ' · 공원 전체 ' + v[d.bins.indexOf(d.start)] + '대. 19시 이후 가장 많은 10분: ' + peaks + ' · 각 구간 공원 전체 <b>' + v[pk] + '대</b>.',
          'Sharp rise begins: ' + interval(d.start) + ' · ' + v[d.bins.indexOf(d.start)] + ' cars park-wide. Busiest 10 minutes after 19:00: ' + peaks + ' · <b>' + v[pk] + ' cars</b> park-wide in each.')
        : T(scope + ' 19시 이후 <b>' + sum19.toLocaleString('ko-KR') + '대</b>가 나갔고, <b>' + interval(d.bins[pk]) + '</b>에 10분당 <b>' + v[pk] + '대</b>로 가장 많았습니다.',
          '<b>' + sum19.toLocaleString('en-US') + ' cars</b> left via ' + esc(scope) + ' after 19:00; the busiest was <b>' + interval(d.bins[pk]) + '</b> with <b>' + cars(v[pk]) + '</b> in 10 minutes.')) + '</p>' +
      '<div class="chart">' + s + '</svg><div class="tip"></div></div><p class="legend"><span><i></i>' + esc(d.date) + T(' 10분당 출차 대수', ' cars per 10 min') + '</span>' + (c ? '<span><i class="c"></i>' + esc(d.cmpName) + '</span>' : '') + '</p>' +
      (d.foot ? '<p class="small">' + esc(d.foot) + (c ? '' : T(' (비교선은 전체에만 있습니다)', ' (the comparison line is for the whole park only)')) + '</p>' : '') +
      '<p class="small">' + T('자료: 한국체육산업개발 올림픽공원 입출차정보(전체구역)', 'Data: KSPO&amp;CO (한국체육산업개발), Olympic Park vehicle entry/exit records (all areas)') + '</p>' +
      '<details><summary>' + T('집계 방법', 'Method') + '</summary>' + (d.basis ? '<p>' + T('비교 기준: ', 'Comparison: ') + esc(d.basis) + '.</p>' : '') + d.notes.map(function (n) { return '<p>' + esc(n) + '.</p>'; }).join('') +
      (d.foot ? '<p>' + T('비교일은 평일이라 18시 전후에 퇴근 시간 출차가 섞여 있습니다.', 'The comparison days are weekdays, so commuter exits around 18:00 are mixed in.') + '</p>' : '') + '<p>' + T('공연의 실제 종료 시각은 확인되지 않아 가로축은 시계 시각입니다.', 'The actual end time of the show is unconfirmed, so the horizontal axis is clock time.') + '</p></details>' +
      '<details><summary>' + T('표로 보기', 'View as table') + '</summary><table><thead><tr><th>' + T('시각', 'Time') + '</th><th>' + T('출차', 'Exits') + '</th>' + (c ? '<th>' + T('비교', 'Comparison') + '</th>' : '') + '</tr></thead><tbody>' + d.bins.map(function (k, i) { return '<tr><td>' + interval(k) + '</td><td>' + v[i] + '</td>' + (c ? '<td>' + c[i] + '</td>' : '') + '</tr>'; }).join('') + '</tbody></table></details>';
    var ch = box.querySelector('.chart'), tip = box.querySelector('.tip');
    var show = function (e) {
      var k = e.target.dataset && e.target.dataset.b; if (k == null) return;
      var rc = ch.getBoundingClientRect(), tr = e.target.getBoundingClientRect();
      tip.textContent = interval(d.bins[k]) + ' · ' + scope + ' ' + cars(v[k]) + (c ? T(' (비교 ' + c[k] + '대)', ' (comparison ' + c[k] + ')') : '');
      tip.style.display = 'block'; tip.style.top = '60px';
      tip.style.left = Math.max(70, Math.min(rc.width - 70, tr.left - rc.left + tr.width / 2)) + 'px';
    };
    ch.addEventListener('pointermove', show); ch.addEventListener('pointerdown', show);
    ch.addEventListener('pointerleave', function () { tip.style.display = 'none'; });
  }

  // ---------- 주요 버튼 ----------
  function cta() {
    var b = $('cta'), x = opts[sel], t = '', g = '';
    if (view === 'home') { t = x.kind === 'bus' ? T(x.o.ars_id + ' 정류장으로 가기', 'Go to Stop ' + x.o.ars_id) : T(x.name + ' ' + x.exit + '로 가기', 'Go to ' + NAME[x.name] + ' ' + exitName(x)); g = '#/go/' + x.id; }
    else if (view === 'event') { t = T('이 공연으로 보기', 'View this show'); g = '#/'; }
    else if (view === 'car') { t = T('대중교통으로 가기', 'Go by public transit'); g = '#/'; }
    else if (x.kind === 'bus' && arrival(x).status === 'ended') { t = T('올림픽공원역으로 가기', 'Go to ' + NAME['올림픽공원역']); g = '#/go/subway-olympic'; }
    else { t = folded ? T('안내 다시 보기', 'Show the guide again') : at && at !== 'none' && at !== x.o.ars_id ? T('건너는 길 지도에서 보기', 'See the crossing on the map') : T('지도에서 길 보기', 'See the route on the map'); g = 'fold'; }
    b.hidden = false; b.textContent = t; b.dataset.act = g;
  }
  $('cta').addEventListener('click', function () {
    var g = this.dataset.act;
    if (g === 'fold') fold(!folded); else nav(g);
  });

  // ---------- 화면 바꾸기 ----------
  function nav(h) { if ((location.hash || '#/') === h) route(); else location.hash = h; }
  // 정류소 확인 결과로 시트를 내린다: 확인 영역이 시트 맨 위에 오게
  function toCheck() {
    var v = $('view'), c = $('chk') && $('chk').querySelector('.pick'); if (!c) return;
    v.scrollTop += c.getBoundingClientRect().top - v.getBoundingClientRect().top - 8;
  }
  function route(moved) {
    if (!D) return;
    var parts = (location.hash || '').split('?'), h = parts[0], hp = new URLSearchParams(parts[1] || ''), i = -1;
    view = h === '#/event' ? 'event' : h === '#/car' ? 'car' : 'home';
    if (h.indexOf('#/go/') === 0) opts.forEach(function (x, k) { if (x.id === h.slice(5)) i = k; });
    if (i >= 0) { sel = i; view = 'go'; }
    at = view === 'go' && opts[sel].kind === 'bus' && AT[hp.get('at')] ? hp.get('at') : null;
    $('sheet').dataset.view = view;
    clock(); setDown(0);
    if (view === 'home') home(); else if (view === 'go') go(opts[sel]); else if (view === 'event') eventView(); else car();
    $('view').scrollTop = 0;
    if (at) { toCheck(); if (document.fonts) document.fonts.ready.then(function () { if (at && view === 'go') toCheck(); }); }
    cta(); fit();
    if (moved === true) { var t = $('view').querySelector('h1'); if (t) t.focus({ preventScroll: true }); }
  }
  function setAt(v) {
    var x = opts[sel];
    at = AT[v] ? v : null;
    history.replaceState(null, '', location.pathname + location.search + '#/go/' + x.id + (at ? '?at=' + at : ''));
    go(x); toCheck(); cta(); fit();
    var r = $('verdict'); if (r && at) r.setAttribute('tabindex', '-1');
  }
  addEventListener('hashchange', function () { route(true); });
  $('view').addEventListener('click', function (e) {
    var t = e.target.closest('[data-i],[data-go],[data-sc],[data-retry],[data-gate],[data-at]'); if (!t) return;
    var d = t.dataset;
    if (d.go) nav(d.go);
    else if (d.at != null) setAt(d.at);
    else if (d.i != null) { sel = +d.i; list(); cta(); fit(); $('list').children[sel].scrollIntoView({ block: 'nearest' }); }
    else if (d.sc) {
      sc = d.sc; params(); clock(); update(); cta();
      if (view === 'go' && at && $('verdict')) $('verdict').innerHTML = verdict(opts[sel]);
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
  function addAttr() {
    attr = L.control.attribution({ position: 'bottomleft', prefix: false }).addAttribution('© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> ' + T('기여자', 'contributors')).addTo(map);
  }

  function initMap() {
    map = L.map('map', { zoomControl: false, attributionControl: false, zoomSnap: 0, minZoom: 14, maxZoom: 19, preferCanvas: true,
      maxBounds: [[37.48, 127.09], [37.54, 127.165]] });
    addAttr();
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
  function dist(a, b) { return Math.hypot((a[0] - b[0]) * 111320, (a[1] - b[1]) * 111320 * Math.cos(a[0] * Math.PI / 180)); }
  function plen(p) { var s = 0; for (var i = 1; i < p.length; i++) s += dist(p[i - 1], p[i]); return s; }
  // 길 건너 정류장으로 가는 길: 강변역 방면 보행선(신호 횡단보도 포함) 중 24244에 가장 가까운 점부터 24245까지.
  // 반대 방향(24245 → 24244)은 같은 길을 거꾸로 걷는다. 목적지 정류장(k)에서 끝난다.
  function crossPath(k) {
    var g = opts.filter(function (o) { return o.k === 'gangbyeon'; })[0].line.map(ll), n = 0;
    g.forEach(function (p, i) { if (dist(p, ST.machon) < dist(g[n], ST.machon)) n = i; });
    var p = [ST.machon].concat(g.slice(n), [ST.gangbyeon]);
    return k === 'gangbyeon' ? p : p.reverse();
  }
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
    var x = opts[sel], path = x.line.map(ll), z = map.getZoom(), checked = x.kind === 'bus' && at && at !== 'none', right = checked && at === x.o.ars_id;
    var venue = mark([37.51915, 127.12735], 'm-text venue', 'KSPO DOME').addTo(over);
    mark([37.5199, 127.1330], 'm-text road', T('양재대로', 'Yangjae-daero')).addTo(over);
    mark([37.5161, 127.1272], 'm-text', T('올림픽홀', 'Olympic Hall')).setZIndexOffset(-1000).addTo(over);
    // 도보 점선. 정류소를 확인한 뒤에는 광장에서 오는 길을 흐리게 한다.
    var sv = L.svg({ padding: 0.5 }), dim = checked ? .3 : 1;
    L.polyline(path, { renderer: sv, color: css('--walk-case'), weight: 9, opacity: .55 * dim, lineCap: 'round', interactive: false }).addTo(over);
    L.polyline(path, { renderer: sv, color: css('--walk'), weight: 6, opacity: dim, dashArray: '0.1 10', lineCap: 'round', interactive: false }).addTo(over);
    var st = path[0];
    var from = [mark(st, 'm-start').addTo(over), mark(st, 'm-text m-from at-l', T('88서울올림픽<br>조각 앞', '88 Olympics<br>sculpture')).addTo(over)];
    // 멀리 축소하면 출발점 라벨이 KSPO DOME 라벨에 닿는다. 겹치면 출발점을 남기고 KSPO DOME을 숨긴다.
    var vr = venue.getElement().firstChild.getBoundingClientRect();
    if (from.some(function (m) { var r = m.getElement().firstChild.getBoundingClientRect(); return vr.left < r.right + 4 && r.left < vr.right + 4 && vr.top < r.bottom + 2 && r.top < vr.bottom + 2; }))
      venue.getElement().style.display = 'none';
    var exits = { '4': [37.516432, 127.130784] };
    if (x.name === '올림픽공원역') mark(exits['4'], 'm-exit on', '4').addTo(over);
    if (x.kind === 'bus') {
      var h = heading(x.k), other = x.k === 'machon' ? 'gangbyeon' : 'machon', c = css('--bus-text');
      // 틀린 쪽에 섰을 때: 길 건너는 길을 굵은 점선으로
      if (checked && !right) {
        var cp = crossPath(x.k);
        L.polyline(cp, { renderer: sv, color: css('--walk-case'), weight: 11, opacity: .6, lineCap: 'round', lineJoin: 'round', interactive: false }).addTo(over);
        L.polyline(cp, { renderer: sv, color: css('--walk'), weight: 7, dashArray: '0.1 12', lineCap: 'round', interactive: false }).addTo(over);
      }
      L.polyline([h[0], h[1]], { renderer: sv, color: c, weight: 5, lineCap: 'round', interactive: false }).addTo(over);
      // 화살촉은 화면 픽셀 기준으로 그린다
      var p1 = map.project(h[1], z), p0 = map.project(h[2], z), an = Math.atan2(p1.y - p0.y, p1.x - p0.x);
      var wing = function (d) { return map.unproject([p1.x - Math.cos(an + d) * 13, p1.y - Math.sin(an + d) * 13], z); };
      L.polyline([wing(.6), h[1], wing(-.6)], { renderer: sv, color: c, weight: 5, lineCap: 'round', lineJoin: 'round', interactive: false }).addTo(over);
      var oSide = other === 'machon' ? 'at-l' : 'at-r';
      if (checked && !right) {
        mark(ST[other], 'm-me').addTo(over);
        mark(ST[other], 'm-tag me ' + oSide, T('지금 여기 ', 'You are here ') + '<b>' + at + '</b>').addTo(over);
      } else {
        mark(ST[other], 'm-dot off').addTo(over);
        mark(ST[other], 'm-tag off ' + oSide, other === 'machon' ? T('24244 마천동', '24244 Macheon-dong') : T('24245 강변역', '24245 Gangbyeon')).addTo(over);
      }
      if (right) mark(ST[x.k], 'm-ring').addTo(over);
      mark(ST[x.k], 'm-dot').addTo(over);
      mark(ST[x.k], 'm-tag on ' + (x.k === 'machon' ? 'at-bl' : 'at-r'), '<b>' + x.o.ars_id + '</b>' + (right ? ' ' + T('여기서 타세요', 'Board here') : checked ? ' ' + T('여기서 타요', 'Board here') : '')).addTo(over);
    } else {
      var e = x.name === '올림픽공원역' ? exits['4'] : path[path.length - 1];
      if (x.name !== '올림픽공원역') mark(e, 'm-exit on', '2').addTo(over);
      mark(e, 'm-tag plain at-b', T(x.name + ' ' + x.exit, NAME[x.name] + ' ' + exitName(x))).addTo(over);
    }
  }
  // 출발점~목적지가 상단 띠와 시트 사이에 들어오게 맞춘다. 정류소를 확인했으면 두 정류장 둘레만 크게 본다.
  // 애니메이션을 쓰지 않는다: 가려진 탭에서는 끝나지 않아 지도가 처음 위치에 남는다.
  function fit() {
    if (!map || !opts.length) return;
    map.stop();
    map.invalidateSize({ animate: false, pan: false });
    var x = opts[sel], wide = innerWidth >= 768, s = $('sheet'), near = x.kind === 'bus' && at && at !== 'none';
    var b = near ? L.latLngBounds(crossPath(x.k)) : L.latLngBounds(x.line.map(ll));
    if (x.kind === 'bus') b.extend(ST.machon).extend(ST.gangbyeon).extend(heading(x.k)[1]);
    var sh = s.offsetHeight - down;
    if (!wide) sh = Math.min(sh, innerHeight * .7);
    map.getContainer().querySelector('.leaflet-bottom').style.cssText = wide ? 'left:440px' : 'bottom:' + sh + 'px';
    // 정류장 라벨이 양옆으로 나가므로 확인 화면은 좌우 여백을 같게, 화면 폭에 맞춰 둔다
    var side = Math.min(T(150, 190), (innerWidth - 40) / 2);
    map.fitBounds(b, { animate: false, maxZoom: 18.5,
      paddingTopLeft: [wide ? 520 : near ? side : x.kind === 'sub' ? T(92, 112) : 92, 112],
      paddingBottomRight: [wide ? 80 : near ? side : x.kind === 'bus' ? T(116, 140) : 84, wide ? 40 : sh + (x.kind === 'bus' ? 30 : 54)] });
    overlay();
  }
})();
