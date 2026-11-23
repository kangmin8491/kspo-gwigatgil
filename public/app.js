/* 공연 끝, 귀갓길 — 시연용 모바일 웹
 * 화면: #/ 공연 선택 → #/dir 방면 선택 → #/go/<id> 탑승 위치, #/car 자가용(출차 그래프)
 * 주소 인자: ?mode=live (실시간 모드), ?s=basic|hurry|ended|fail (시연 상황)
 */
(function () {
  'use strict';

  var HURRY_MARGIN_MIN = 2; // 도착 예정 − 도보 ≥ 2분이면 '탈 수 있음' (기획서 초기값)
  var LIVE_REFRESH_MS = 30000;
  var BUS_WEB = 'https://bus.go.kr/app/';
  var METRO_TIMETABLE = 'https://www.seoulmetro.co.kr/kr/cyberStation.do';

  // 동선표(소스/KSPO DOME 귀가 동선표.md)의 걷는 방법 문장
  var BUS_TEXT = {
    '24244': {
      key: 'machon',
      walk: '올림픽공원역으로 이동해 공원 쪽, 역 3번 출구와 같은 쪽에 섭니다.',
      walkNote: '지도 경로 기반 추정 · 신호 대기 제외'
    },
    '24245': {
      key: 'gangbyeon',
      walk: '올림픽공원역 쪽에서 양재대로의 신호 횡단보도를 건너, 역 1번 출구와 같은 쪽 정류장으로 갑니다.',
      walkNote: '지도 경로 기반 추정 · 신호 대기 별도'
    }
  };

  // 2026-11-24 서울시 버스도착정보 응답(소스/데이터/버스응답_20261124_0117.json)의 막차·배차.
  // 2025-11-01 당일 값은 확보하지 못했으므로 시연 모드에서는 조회일을 함께 표시한다.
  var KNOWN_SCHEDULE = {
    machon: { lastHHMM: '00:22', term: 13, checked: '2026-11-24' },
    gangbyeon: { lastHHMM: '23:39', term: 13, checked: '2026-11-24' }
  };

  // 시연 상황 — 모두 예시값. 실제 2025-11-01 도착 기록이 아니다.
  var SCENARIOS = {
    basic: {
      label: '기본',
      clock: '2025-11-01 20:50',
      buses: { machon: [9 * 60, 22 * 60], gangbyeon: [5 * 60, 18 * 60] }
    },
    hurry: {
      label: '서두르면 가능',
      clock: '2025-11-01 21:10',
      buses: { machon: [7 * 60, 20 * 60], gangbyeon: [9 * 60, 22 * 60] }
    },
    ended: { label: '막차 이후', clock: '2025-11-02 00:40', ended: true },
    fail: { label: '조회 실패', clock: '2025-11-01 20:50', fail: true }
  };

  var state = {
    mode: 'demo',
    scenario: 'basic',
    routes: null,
    subwayPaths: null,
    liveTimer: null,
    map: null
  };

  var app = document.getElementById('app');
  var topbar = document.getElementById('topbar');
  var modeLine = document.getElementById('modeLine');

  // ---------- 공통 ----------
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function exampleTag() {
    return state.mode === 'demo' ? '<span class="example">예시</span>' : '';
  }
  function readParams() {
    var p = new URLSearchParams(location.search);
    state.mode = p.get('mode') === 'live' ? 'live' : 'demo';
    var s = p.get('s');
    state.scenario = SCENARIOS[s] ? s : 'basic';
  }
  function writeParams() {
    var p = new URLSearchParams(location.search);
    if (state.mode === 'live') p.set('mode', 'live'); else p.delete('mode');
    if (state.mode === 'demo' && state.scenario !== 'basic') p.set('s', state.scenario); else p.delete('s');
    var q = p.toString();
    history.replaceState(null, '', location.pathname + (q ? '?' + q : '') + location.hash);
  }
  function stepsBar(n) {
    var names = ['공연', '방면', '탑승 위치'];
    return '<div class="steps" aria-label="단계">' + names.map(function (t, i) {
      return '<span class="' + (i + 1 === n ? 'on' : '') + '">' + (i + 1) + ' ' + t + '</span>';
    }).join('') + '</div>';
  }
  function backBtn(hash, label) {
    return '<button type="button" class="back" data-go="' + hash + '">← ' + esc(label) + '</button>';
  }

  function options() {
    var r = state.routes;
    var list = r.options.map(function (o) {
      var t = BUS_TEXT[o.ars_id];
      return {
        id: 'bus-' + t.key, kind: 'bus', key: t.key, data: o, text: t,
        name: '버스 ' + r.bus_number + ' · ' + o.direction + ' 방면',
        sub: '정류소 ' + o.ars_id + ' · 도보 약 ' + o.walking_minutes_estimate + '분' + (t.key === 'gangbyeon' ? ' + 신호 대기' : ''),
        badge: '<span class="badge bus">' + esc(r.bus_number) + '</span>'
      };
    });
    var so = r.subway_options;
    list.push({
      id: 'subway-olympic', kind: 'subway', data: so[0],
      name: '지하철 올림픽공원역', sub: '5·9호선 · 4번 출구 · 도보 약 ' + so[0].walking_minutes_estimate + '분',
      badge: '<span class="badge subway5">5·9<br>호선</span>',
      title: '올림픽공원역', lines: '5·9호선', exit: '4번 출구'
    });
    list.push({
      id: 'subway-hanseong', kind: 'subway', data: so[1], crowd: true,
      name: '지하철 한성백제역', sub: '9호선 · 2번 출구 · 도보 약 ' + so[1].walking_minutes_estimate + '분',
      badge: '<span class="badge subway9">9<br>호선</span>',
      title: '한성백제역', lines: '9호선', exit: '2번 출구'
    });
    return list;
  }
  function findOption(id) {
    return options().filter(function (o) { return o.id === id; })[0];
  }

  function setTopbar() {
    topbar.classList.toggle('is-demo', state.mode === 'demo');
    topbar.classList.toggle('is-live', state.mode === 'live');
    modeLine.textContent = state.mode === 'demo' ? '시연 모드 · 2025년 11월 1일 기준' : '실시간 모드 · 지금 버스 도착 조회';
    Array.prototype.forEach.call(document.querySelectorAll('.mode-switch button'), function (b) {
      b.setAttribute('aria-pressed', String(b.dataset.mode === state.mode));
    });
  }

  // ---------- 1. 공연 선택 ----------
  function renderEvent() {
    var e = state.routes.event;
    app.innerHTML =
      stepsBar(1) +
      '<h1>어떤 공연을 보고 나오셨나요?</h1>' +
      '<p class="lead">공연을 고르면 공연장 앞에서 걸어갈 정류장과 역을 알려 드려요.</p>' +
      '<button type="button" class="event-btn" data-go="#/dir">' +
        '<span class="venue">' + esc(e.venue) + '</span>' +
        '<div class="title">' + esc(e.title) + '</div>' +
        '<div class="when">2025년 11월 1일(토) 18:00 · 서울 ' + esc(e.session) + '회차</div>' +
        '<div class="go">이 공연 선택 →</div>' +
      '</button>' +
      '<div class="notice"><b>참고</b><span>같은 시각 올림픽홀에서도 공연(신승훈)이 열렸습니다.</span></div>' +
      '<p class="muted">공연 실제 종료 시각은 공개 자료로 확인되지 않았습니다.' +
        (state.mode === 'live' ? ' 실시간 모드에서도 공연은 시연 회차로 고정되며, 버스 도착만 지금 시각으로 조회합니다.' : '') + '</p>' +
      '<h2>자가용으로 오셨나요?</h2>' +
      '<button type="button" class="car-entry" data-go="#/car"><span>공연일 출구 게이트별 출차 그래프</span><span aria-hidden="true">→</span></button>' +
      '<div class="link-row"><a href="' + esc(e.source) + '" target="_blank" rel="noopener">공식 예매 공지</a>' +
      '<a href="https://www.ksponco.or.kr/menu.es?mid=a20301031400" target="_blank" rel="noopener">한얼광장 안내</a></div>';
  }

  // ---------- 2. 방면 선택 ----------
  function renderDirs() {
    app.innerHTML =
      backBtn('#/', '공연 다시 고르기') + stepsBar(2) +
      '<h1>어느 쪽으로 가세요?</h1>' +
      '<p class="lead">출발점: 한얼광장 ‘88서울올림픽’ 조각 앞</p>' +
      '<div class="dir-list">' + options().map(function (o) {
        return '<button type="button" class="dir-btn" data-go="#/go/' + o.id + '">' + o.badge +
          '<span class="name">' + esc(o.name) + (o.crowd ? '<span class="tag-crowd">혼잡 시</span>' : '') + '</span>' +
          '<span class="arrow" aria-hidden="true">›</span>' +
          '<span class="sub">' + esc(o.sub) + '</span></button>';
      }).join('') + '</div>' +
      '<p class="muted" style="margin-top:12px">도보 시간은 지도 경로 기반 추정이며 공연장 좌석에서 광장까지 걷는 시간은 빠져 있습니다.</p>';
  }

  // ---------- 3. 탑승 위치: 버스 ----------
  function renderBus(o) {
    var r = state.routes, d = o.data;
    var other = r.options.filter(function (x) { return x.ars_id !== d.ars_id; })[0];
    app.innerHTML =
      backBtn('#/dir', '방면 다시 고르기') + stepsBar(3) +
      '<section class="card">' +
        '<p class="dir-head">' + esc(r.bus_number) + '번 버스</p>' +
        '<p class="dir-title">' + esc(d.direction) + ' 방면</p>' +
        '<div class="big3">' +
          '<div class="cell"><div class="k">버스</div><div class="v bus">' + esc(r.bus_number) + '</div></div>' +
          '<div class="cell"><div class="k">정류소 번호</div><div class="v">' + esc(d.ars_id) + '</div></div>' +
          '<div class="cell wide"><div class="k">다음 정류장 (버스 안내판에서 확인)</div><div class="v">' + esc(d.next_stop) +
            ' <small>' + esc(d.next_ars_id) + '</small></div></div>' +
        '</div>' +
        '<dl class="kv">' +
          '<dt>정류장</dt><dd>' + esc(d.stop_name) + ' <span class="note">정류소 표지의 번호 ' + esc(d.ars_id) + '를 확인하세요</span></dd>' +
          '<dt>서는 쪽</dt><dd><b>' + esc(d.side) + '</b><span class="note">' + esc(o.text.walk) + '</span></dd>' +
          '<dt>도보</dt><dd><b>약 ' + esc(d.walking_m_estimate) + 'm · ' + esc(d.walking_minutes_estimate) + '분</b><span class="note">' + esc(o.text.walkNote) + '</span></dd>' +
        '</dl>' +
        '<div class="wrong-side"><b>길 건너 같은 이름 정류장 주의</b> — 정류소 ' + esc(other.ars_id) + '는 ' + esc(other.direction) + ' 방면입니다.</div>' +
      '</section>' +
      '<section class="card arrivals" id="arrivals" aria-live="polite"></section>' +
      mapCard() +
      scenarioBox() +
      '<p class="sources">출처: 서울시 버스 노선별 정류소 원자료(2025-10-02·2025-11-03·2026-09-02판 대조), 서울시 버스도착정보, ' +
        '도보 경로 OpenStreetMap 보행로(2026-11-24 조회, 현장 실측 아님). ' +
        '<a href="' + BUS_WEB + '" target="_blank" rel="noopener">서울시 버스정보</a></p>';

    loadArrivals(o);
    var line = d.walking_polyline_lon_lat;
    drawMap(line, r.start.coordinate_lon_lat, line[line.length - 1], '정류소 ' + d.ars_id);
  }

  function loadArrivals(o) {
    var box = document.getElementById('arrivals');
    if (!box) return;
    clearInterval(state.liveTimer);
    if (state.mode === 'demo') {
      box.innerHTML = renderArrivals(o, demoArrivals(o.key));
      return;
    }
    box.innerHTML = '<h3>3214번 도착 예정</h3><p class="muted">서울시 버스도착정보를 조회하는 중…</p>';
    var run = function () {
      fetchLive(o.key).then(function (res) {
        if (location.hash !== '#/go/' + o.id || state.mode !== 'live') return;
        var b = document.getElementById('arrivals');
        if (b) b.innerHTML = renderArrivals(o, res);
      });
    };
    run();
    state.liveTimer = setInterval(run, LIVE_REFRESH_MS);
  }

  function demoArrivals(key) {
    var sc = SCENARIOS[state.scenario];
    var sch = KNOWN_SCHEDULE[key];
    var base = { clock: sc.clock, lastHHMM: sch.lastHHMM, lastNote: sch.checked + ' 서울시 응답 기준', term: sch.term };
    if (sc.fail) return Object.assign(base, { status: 'fail' });
    if (sc.ended) return Object.assign(base, { status: 'ended' });
    return Object.assign(base, {
      status: 'ok',
      buses: sc.buses[key].map(function (sec) { return { sec: sec, msg: null, isLast: false }; })
    });
  }

  function fetchLive(key) {
    var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var t = setTimeout(function () { if (ctrl) ctrl.abort(); }, 12000);
    return fetch('/api/bus?dir=' + key, { signal: ctrl ? ctrl.signal : undefined, cache: 'no-store' })
      .then(function (r) { return r.json().catch(function () { return { ok: false }; }); })
      .then(function (j) {
        clearTimeout(t);
        if (!j || !j.ok) return { status: 'fail' };
        var age = j.mkTm ? Math.max(0, (Date.now() - Date.parse(j.mkTm)) / 1000) : 0;
        return {
          status: j.ended ? 'ended' : 'ok',
          clock: null,
          asOf: j.mkTm,
          lastHHMM: hhmm(j.lastTm),
          lastNote: '오늘 서울시 응답 기준',
          term: j.term,
          buses: (j.buses || []).map(function (b) {
            return { sec: b.sec == null ? null : Math.max(0, b.sec - age), msg: b.msg, isLast: b.isLast };
          })
        };
      })
      .catch(function () { clearTimeout(t); return { status: 'fail' }; });
  }

  function hhmm(ymdhms) {
    if (!ymdhms || ymdhms.length < 12) return null;
    return ymdhms.slice(8, 10) + ':' + ymdhms.slice(10, 12);
  }

  function judge(sec, walkMin) {
    if (sec == null) return { cls: 'unknown', label: '확인 필요' };
    var margin = sec / 60 - walkMin;
    if (margin >= HURRY_MARGIN_MIN) return { cls: 'ok', label: '탈 수 있음', margin: margin };
    if (margin >= 0) return { cls: 'hurry', label: '서두르면 가능', margin: margin };
    return { cls: 'miss', label: '놓칠 수 있음', margin: margin };
  }

  function etaText(sec) {
    if (sec == null) return '—';
    var m = Math.floor(sec / 60);
    return m < 1 ? '곧 도착' : m + '분 <small>후</small>';
  }

  function renderArrivals(o, a) {
    var walk = o.data.walking_minutes_estimate;
    var clockLine = a.clock
      ? '<p class="muted">시연 시각 ' + esc(a.clock.slice(11)) + exampleTag() + ' · ' + esc(a.clock.slice(0, 10)) + '</p>'
      : (a.asOf ? '<p class="muted">서울시 응답 ' + esc(a.asOf.slice(11, 19)) + ' 기준 · 30초마다 갱신</p>' : '');
    var head = '<h3><span>3214번 도착 예정</span>' + (state.mode === 'demo' && a.status === 'ok' ? '<span class="example">예시</span>' : '') + '</h3>' + clockLine;
    var last = a.lastHHMM
      ? '<div class="lastbus"><span>막차<br><span class="muted">' + esc(a.lastNote) + '</span></span><b>' + esc(a.lastHHMM) + '</b></div>'
      : '';

    if (a.status === 'fail') {
      return head +
        '<div class="state-box fail"><div class="head">조회 불가</div>' +
        '<p>지금은 버스 도착 정보를 불러올 수 없습니다. 정류장 위치와 방향은 위 안내 그대로입니다.</p>' +
        '<div class="btn-row"><a class="btn primary" href="' + BUS_WEB + '" target="_blank" rel="noopener">서울시 버스정보에서 확인</a>' +
        (state.mode === 'live' ? '<button type="button" class="btn" data-retry="1">다시 조회</button>' : '') + '</div></div>' + last;
    }
    if (a.status === 'ended') {
      return head +
        '<div class="state-box ended"><div class="head">운행 종료</div>' +
        '<p>3214번 ' + esc(o.data.direction) + ' 방면 운행이 끝났습니다' + (a.lastHHMM ? ' (막차 ' + esc(a.lastHHMM) + ')' : '') + '. 지하철로 가세요.</p>' +
        '<div class="btn-row"><button type="button" class="btn primary" data-go="#/go/subway-olympic">올림픽공원역 가는 길</button>' +
        '<button type="button" class="btn" data-go="#/go/subway-hanseong">한성백제역 가는 길</button></div>' +
        '<p class="muted">지하철 막차는 <a href="' + METRO_TIMETABLE + '" target="_blank" rel="noopener">서울교통공사 역별 시간표</a>에서 확인하세요.</p></div>' + last;
    }

    var buses = (a.buses || []).slice(0, 2);
    var js = buses.map(function (b) { return judge(b.sec, walk); });
    var focusIdx = js.findIndex(function (j) { return j.cls === 'ok' || j.cls === 'hurry'; });
    var rows = buses.map(function (b, i) {
      var j = js[i];
      var why = j.margin != null
        ? '도착 ' + Math.floor(b.sec / 60) + '분 − 도보 ' + walk + '분 = 여유 ' + (j.margin < 0 ? '없음' : Math.floor(j.margin) + '분')
        : (b.msg ? esc(b.msg) : '도착 예정 시간이 없습니다');
      if (j.margin != null && b.msg) why += ' · 서울시 안내 “' + esc(b.msg) + '”';
      return '<div class="arr ' + j.cls + (i === focusIdx ? ' focus' : '') + '">' +
        '<span class="which">' + (i === 0 ? '첫 버스' : '다음 버스') + (b.isLast ? ' · 막차' : '') + '</span>' +
        '<span class="verdict">' + j.label + '</span>' +
        '<span class="eta">' + etaText(b.sec) + '</span>' +
        '<span class="why">' + why + '</span></div>';
    }).join('');
    var allMiss = buses.length > 0 && focusIdx === -1 && js.every(function (j) { return j.cls === 'miss'; });
    var tail = allMiss
      ? '<p class="muted">두 버스 모두 걷는 동안 지나갈 수 있습니다. 그다음 차는 배차 간격(약 ' + esc(a.term || '?') + '분)을 참고하거나 지하철을 이용하세요.</p>'
      : '';
    if (!buses.length) rows = '<p class="muted">도착 예정 버스가 없습니다.</p>';
    return head + rows + tail +
      '<p class="muted">판정: 도착 예정 − 도보 ≥ ' + HURRY_MARGIN_MIN + '분 ‘탈 수 있음’, 0~' + HURRY_MARGIN_MIN + '분 ‘서두르면 가능’</p>' + last;
  }

  // ---------- 3. 탑승 위치: 지하철 ----------
  function renderSubway(o) {
    var d = o.data, r = state.routes;
    var p = state.subwayPaths && state.subwayPaths.paths[o.id];
    var olympic = o.id === 'subway-olympic';
    app.innerHTML =
      backBtn('#/dir', '방면 다시 고르기') + stepsBar(3) +
      '<section class="card">' +
        '<p class="dir-head">지하철 ' + esc(o.lines) + (o.crowd ? ' <span class="tag-crowd">올림픽공원역이 붐빌 때</span>' : '') + '</p>' +
        '<p class="dir-title">' + esc(o.title) + '</p>' +
        '<div class="big3">' +
          '<div class="cell"><div class="k">출구</div><div class="v">' + esc(o.exit) + '</div></div>' +
          '<div class="cell"><div class="k">도보</div><div class="v">' + esc(d.walking_minutes_estimate) + '<small>분</small></div></div>' +
        '</div>' +
        '<dl class="kv">' +
          '<dt>거리</dt><dd><b>약 ' + (d.walking_m_estimate >= 1000 ? (d.walking_m_estimate / 1000).toFixed(1) + 'km' : d.walking_m_estimate + 'm') + '</b>' +
            '<span class="note">' + (olympic ? '역 중심점까지 지도 경로 추정 · 출구 위치에 따라 달라짐' : '2번 출구 인근 따릉이 대여소까지 지도 경로 추정') + '</span></dd>' +
          '<dt>출구</dt><dd>' + esc(olympic
            ? '예매처 공연장 안내: 4번 출구로 나와 엄지 조각을 지나면 KSPO DOME. 돌아갈 때는 이 길을 거꾸로 걷습니다.'
            : '2번 출구. 예매처 안내는 공연 직후 올림픽공원역 혼잡을 피하려면 한성백제역(약 20분)이나 몽촌토성역(약 23분)을 권합니다.') + '</dd>' +
        '</dl>' +
        (olympic
          ? '<div class="line-warn"><b>5호선 방면 주의</b> — 5호선은 강동역에서 마천 방면과 하남 방면으로 갈라집니다. 타기 전에 열차 행선지를 확인하세요.</div>'
          : '') +
        '<div class="lastbus" style="margin-top:12px"><span>지하철 막차</span><a href="' + METRO_TIMETABLE + '" target="_blank" rel="noopener">서울교통공사 역별 시간표 →</a></div>' +
      '</section>' +
      mapCard() +
      '<p class="sources">출처: 도보 경로 OSRM 보행 경로(OpenStreetMap, 2026-11-24 조회, 현장 실측 아님). ' +
        d.sources.map(function (u, i) { return '<a href="' + esc(u) + '" target="_blank" rel="noopener">자료' + (i + 1) + '</a>'; }).join(' · ') + '</p>';

    if (p) drawMap(p.walking_polyline_lon_lat, r.start.coordinate_lon_lat, p.destination_lon_lat, olympic ? o.title + '(역 중심)' : o.exit + ' 인근');
  }

  // ---------- 지도 ----------
  function mapCard() {
    return '<section class="card"><h3 style="margin:0 0 8px;font-size:16px">걸어가는 길</h3>' +
      '<div class="map" id="map" role="img" aria-label="출발점에서 목적지까지 도보 경로 지도"></div>' +
      '<div class="map-legend"><span><i class="dot" style="background:#14284b"></i>출발: 88서울올림픽 조각 앞</span>' +
      '<span><i class="dot" style="background:#d9480f"></i>도착</span><span>파란 선: 지도 기반 추정 경로</span></div></section>';
  }

  function drawMap(lineLonLat, startLonLat, destLonLat, destLabel) {
    if (state.map) { state.map.remove(); state.map = null; }
    var el = document.getElementById('map');
    if (!el) return;
    if (typeof L === 'undefined') {
      el.innerHTML = '<p class="muted" style="padding:12px">지도를 불러오지 못했습니다. 위 안내 문장으로 이동하세요.</p>';
      return;
    }
    var ll = function (p) { return [p[1], p[0]]; };
    var map = L.map(el, { zoomControl: true, scrollWheelZoom: false, tap: true });
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> 기여자'
    }).addTo(map);
    var line = L.polyline(lineLonLat.map(ll), { color: '#2a78d6', weight: 5, opacity: .9 }).addTo(map);
    L.circleMarker(ll(startLonLat), { radius: 8, color: '#fff', weight: 2, fillColor: '#14284b', fillOpacity: 1 })
      .addTo(map).bindTooltip('출발: 88서울올림픽 조각 앞');
    L.circleMarker(ll(destLonLat), { radius: 9, color: '#fff', weight: 2, fillColor: '#d9480f', fillOpacity: 1 })
      .addTo(map).bindTooltip(destLabel, { permanent: true, direction: 'left', offset: [-8, 0] });
    map.fitBounds(line.getBounds().extend(ll(startLonLat)).extend(ll(destLonLat)), { paddingTopLeft: [80, 24], paddingBottomRight: [24, 24] });
    state.map = map;
  }

  // ---------- 시연 상황 전환 ----------
  function scenarioBox() {
    if (state.mode !== 'demo') return '';
    return '<div class="scenario"><div class="t">시연 상황 바꾸기 (예시값)</div><div class="chips">' +
      Object.keys(SCENARIOS).map(function (k) {
        return '<button type="button" data-scenario="' + k + '" aria-pressed="' + (k === state.scenario) + '">' + SCENARIOS[k].label + '</button>';
      }).join('') + '</div></div>';
  }

  // ---------- 자가용: 출차 그래프 ----------
  function renderCar() {
    app.innerHTML =
      backBtn('#/', '공연 선택으로') +
      '<h1>자가용 출차 그래프</h1>' +
      '<p class="lead">공연일에 어느 출구 게이트로, 몇 시에 차량이 몰렸는지 10분 단위로 보여 줍니다.</p>' +
      '<section class="card" id="carBody"><p class="muted">불러오는 중…</p></section>';
    fetch('data/exit_counts.json', { cache: 'no-store' })
      .then(function (r) { if (!r.ok) throw new Error('none'); return r.json(); })
      .then(function (j) { renderExitChart(document.getElementById('carBody'), j, null); })
      .catch(function () {
        var body = document.getElementById('carBody');
        if (!body) return;
        body.innerHTML =
          '<div class="placeholder"><div class="ph-bars" aria-hidden="true">' +
          [18, 22, 26, 30, 40, 58, 70, 52, 34, 24, 16, 12].map(function (h) { return '<i style="height:' + h + 'px"></i>'; }).join('') +
          '</div><b>집계 준비 중</b><p class="muted" style="margin:6px 0 0">한국체육산업개발 ‘올림픽공원 입출차정보(전체구역)’ 원자료를 받는 중입니다. ' +
          '집계가 끝나면 2025년 11월 1일 출구 게이트(동2문·남2문·북2문)별 10분 단위 출차를 이 자리에 표시합니다.</p></div>';
      });
  }

  function renderExitChart(box, j, gate) {
    if (!box) return;
    var gates = j.gates || Object.keys(j.event_day.counts);
    var sel = gate || 'all';
    var sum = function (counts) {
      return j.bins.map(function (_, i) {
        if (sel !== 'all') return (counts[sel] || [])[i] || 0;
        return gates.reduce(function (s, g) { return s + ((counts[g] || [])[i] || 0); }, 0);
      });
    };
    var ev = sum(j.event_day.counts);
    var cmp = j.comparison ? sum(j.comparison.counts) : null;
    var maxV = Math.max.apply(null, ev.concat(cmp || [0]).concat([1]));
    var nice = niceMax(maxV);
    var W = 340, H = 210, pl = 34, pr = 6, pt = 10, pb = 26;
    var pw = W - pl - pr, ph = H - pt - pb, n = j.bins.length, slot = pw / n, bw = Math.max(2, slot - 2);
    var y = function (v) { return pt + ph - (v / nice) * ph; };
    var svg = '<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="10분 단위 출차 대수 막대그래프">';
    [0, .5, 1].forEach(function (f) {
      var v = Math.round(nice * f), yy = y(v);
      svg += '<line x1="' + pl + '" x2="' + (W - pr) + '" y1="' + yy + '" y2="' + yy + '" stroke="var(--line)" stroke-width="1"/>' +
        '<text x="' + (pl - 4) + '" y="' + (yy + 4) + '" font-size="10" text-anchor="end" fill="var(--ink-3)">' + v + '</text>';
    });
    j.bins.forEach(function (b, i) {
      var x = pl + i * slot + 1, v = ev[i], top = y(v), h = pt + ph - top;
      if (h > 0) {
        var r = Math.min(4, bw / 2, h);
        svg += '<path d="M' + x + ',' + (pt + ph) + 'V' + (top + r) + 'Q' + x + ',' + top + ' ' + (x + r) + ',' + top +
          'H' + (x + bw - r) + 'Q' + (x + bw) + ',' + top + ' ' + (x + bw) + ',' + (top + r) + 'V' + (pt + ph) + 'Z" fill="var(--series-1)"/>';
      }
      if (cmp) svg += '<line x1="' + x + '" x2="' + (x + bw) + '" y1="' + y(cmp[i]) + '" y2="' + y(cmp[i]) + '" stroke="var(--series-cmp)" stroke-width="2"/>';
      if (b.slice(3) === '00' && (parseInt(b, 10) % 2 === 0)) {
        svg += '<text x="' + (x + bw / 2) + '" y="' + (H - 8) + '" font-size="10" text-anchor="middle" fill="var(--ink-3)">' + b.slice(0, 2) + '시</text>';
      }
      svg += '<rect data-i="' + i + '" x="' + (pl + i * slot) + '" y="' + pt + '" width="' + slot + '" height="' + ph + '" fill="transparent"/>';
    });
    if (j.markers) {
      [['surge_start', '출차 급증 시작'], ['peak', '최고']].forEach(function (m, k) {
        var i = j.bins.indexOf(j.markers[m[0]]);
        if (i < 0) return;
        var x = pl + i * slot + slot / 2, left = x > pl + pw * 0.6;
        svg += '<line x1="' + x + '" x2="' + x + '" y1="' + pt + '" y2="' + (pt + ph) + '" stroke="var(--ink-2)" stroke-dasharray="3 3"/>' +
          '<text x="' + (left ? x - 3 : x + 3) + '" y="' + (pt + 10 + k * 13) + '" font-size="10" text-anchor="' + (left ? 'end' : 'start') +
          '" fill="var(--ink-2)">' + m[1] + ' ' + j.markers[m[0]] + '</text>';
      });
    }
    svg += '</svg>';

    box.innerHTML =
      '<div class="gate-filter chips">' + ['all'].concat(gates).map(function (g) {
        return '<button type="button" data-gate="' + esc(g) + '" aria-pressed="' + (g === sel) + '">' + (g === 'all' ? '전체 게이트' : esc(g)) + '</button>';
      }).join('') + '</div>' +
      '<div class="legend"><span><i class="sw" style="background:var(--series-1)"></i>' + esc(j.event_day.label || j.event_day.date) + '</span>' +
      (cmp ? '<span><i class="sw cmp"></i>' + esc(j.comparison.label || '비교일') + '</span>' : '') + '</div>' +
      '<div class="chart">' + svg + '<div class="tip" id="tip"></div></div>' +
      '<p class="muted">집계: ' + esc(j.dataset && j.dataset.name) + ' · ' + esc(j.event_day.date) + ' · ' + j.bin_minutes + '분 단위' +
        (j.comparison ? ' · 비교일 ' + j.comparison.dates.length + '일 ' + esc(j.comparison.method === 'median' ? '중앙값' : j.comparison.method) : '') + '</p>' +
      (j.notes || []).map(function (t) { return '<p class="muted">' + esc(t) + '</p>'; }).join('') +
      '<details><summary>표로 보기</summary><table class="data"><thead><tr><th>시각</th><th>출차</th>' + (cmp ? '<th>비교일</th>' : '') + '</tr></thead><tbody>' +
      j.bins.map(function (b, i) { return '<tr><td>' + b + '</td><td>' + ev[i] + '</td>' + (cmp ? '<td>' + cmp[i] + '</td>' : '') + '</tr>'; }).join('') +
      '</tbody></table></details>';

    box.querySelectorAll('[data-gate]').forEach(function (b) {
      b.addEventListener('click', function () { renderExitChart(box, j, b.dataset.gate); });
    });
    var tip = box.querySelector('#tip'), chart = box.querySelector('.chart');
    var show = function (ev2) {
      var t = ev2.target.closest && ev2.target.closest('rect[data-i]');
      if (!t) { tip.style.display = 'none'; return; }
      var i = +t.dataset.i, rc = chart.getBoundingClientRect(), tr = t.getBoundingClientRect();
      tip.innerHTML = j.bins[i] + ' · 출차 ' + ev[i] + '대' + (cmp ? ' (비교일 ' + cmp[i] + ')' : '');
      tip.style.left = Math.min(rc.width - 60, Math.max(60, tr.left - rc.left + tr.width / 2)) + 'px';
      tip.style.top = (tr.top - rc.top + 30) + 'px';
      tip.style.display = 'block';
    };
    chart.addEventListener('pointermove', show);
    chart.addEventListener('pointerdown', show);
    chart.addEventListener('pointerleave', function () { tip.style.display = 'none'; });
  }

  function niceMax(v) {
    var p = Math.pow(10, Math.floor(Math.log10(v))), f = v / p;
    return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p;
  }

  // ---------- 라우팅 ----------
  function render() {
    clearInterval(state.liveTimer);
    if (state.map) { state.map.remove(); state.map = null; }
    setTopbar();
    var h = location.hash || '#/';
    if (h === '#/dir') renderDirs();
    else if (h === '#/car') renderCar();
    else if (h.indexOf('#/go/') === 0) {
      var o = findOption(h.slice(5));
      if (!o) { location.hash = '#/dir'; return; }
      if (o.kind === 'bus') renderBus(o); else renderSubway(o);
    } else renderEvent();
  }

  document.addEventListener('click', function (e) {
    var t = e.target.closest('[data-go],[data-mode],[data-scenario],[data-retry]');
    if (!t) return;
    if (t.dataset.go) {
      if (location.hash === t.dataset.go) render(); else location.hash = t.dataset.go;
      window.scrollTo(0, 0);
    } else if (t.dataset.mode) {
      state.mode = t.dataset.mode;
      writeParams(); render();
    } else if (t.dataset.scenario) {
      state.scenario = t.dataset.scenario;
      writeParams();
      var o = findOption((location.hash || '').slice(5));
      if (o) { loadArrivals(o); app.querySelectorAll('[data-scenario]').forEach(function (b) { b.setAttribute('aria-pressed', String(b.dataset.scenario === state.scenario)); }); }
    } else if (t.dataset.retry) {
      var o2 = findOption((location.hash || '').slice(5));
      if (o2) loadArrivals(o2);
    }
  });
  window.addEventListener('hashchange', function () { render(); app.focus({ preventScroll: true }); });

  readParams();
  Promise.all([
    fetch('data/routes.json').then(function (r) { return r.json(); }),
    fetch('data/subway_paths.json').then(function (r) { return r.json(); }).catch(function () { return null; })
  ]).then(function (res) {
    state.routes = res[0];
    state.subwayPaths = res[1];
    render();
  }).catch(function () {
    app.innerHTML = '<p>동선 데이터를 불러오지 못했습니다. 새로고침해 주세요.</p>';
  });
})();
