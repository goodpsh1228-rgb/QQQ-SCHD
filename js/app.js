/*
 * app.js — 화면 입력을 읽어 백테스트를 돌리고, 차트와 표를 그리는 파일
 *
 * 흐름:  데이터 로드(loadData) → 입력값 읽기(readSettings) → 계산(Backtest.*) → 그리기(render*)
 * 입력이 바뀔 때마다 update()가 다시 실행된다.
 */
(function () {
  'use strict';

  const TICKERS = ['QQQ', 'SCHD', 'SPY'];
  const DEFAULT_WEIGHTS = { QQQ: 40, SCHD: 30, SPY: 30 };
  const PERIODS = [1, 3, 5, 10];   // 기간별 수익률 표에 쓸 "최근 N년"
  const MAX_POINTS = 2000;         // 차트에 그릴 최대 점 개수 (많으면 느려져서 솎아냄)

  let DATA = null;                 // prices.json 내용
  let activePreset = 0;            // 선택된 기간 프리셋(0=전체, N=최근 N년). 날짜를 직접 고르면 null
  const charts = {};               // 생성된 Chart.js 객체 보관 (다시 그릴 때 파괴하기 위해)

  const $ = function (id) { return document.getElementById(id); };

  // ───────────────────────── 1. 입력 UI 만들기 ─────────────────────────

  // 티커별 비중 슬라이더와 비용 입력칸 생성
  function buildInputs() {
    TICKERS.forEach(function (t, i) {
      const color = 'var(--series-' + (i + 2) + ')';
      $('weightRows').insertAdjacentHTML('beforeend',
        '<div class="ticker-row">' +
          '<span class="ticker-name"><span class="dot" style="background:' + color + '"></span>' + t + '</span>' +
          '<input type="range" id="w-range-' + t + '" min="0" max="100" step="1" aria-label="' + t + ' 비중">' +
          '<input type="number" id="w-' + t + '" min="0" max="100" step="1" aria-label="' + t + ' 비중 %">' +
        '</div>');
      $('costRows').insertAdjacentHTML('beforeend',
        '<div class="ticker-row">' +
          '<span class="ticker-name"><span class="dot" style="background:' + color + '"></span>' + t + '</span>' +
          '<span class="muted" style="font-size:.8rem">추가 비용</span>' +
          '<input type="number" id="c-' + t + '" value="0" min="0" max="10" step="0.05" aria-label="' + t + ' 연간 추가 비용 %">' +
        '</div>');
      setWeight(t, DEFAULT_WEIGHTS[t]);

      // 슬라이더와 숫자칸을 서로 동기화
      $('w-range-' + t).addEventListener('input', function (e) { setWeight(t, e.target.value); scheduleUpdate(); });
      $('w-' + t).addEventListener('input', function (e) { $('w-range-' + t).value = e.target.value; scheduleUpdate(); });
    });

    // 비중 프리셋 버튼
    $('weightPresets').addEventListener('click', function (e) {
      const w = e.target.dataset.w;
      if (!w) return;
      w.split(',').forEach(function (v, i) { setWeight(TICKERS[i], v); });
      scheduleUpdate();
    });

    // 기간 프리셋 버튼 (전체 / 최근 N년)
    $('periodPresets').addEventListener('click', function (e) {
      const years = e.target.dataset.years;
      if (years === undefined) return;
      applyPeriodPreset(Number(years));
      scheduleUpdate();
    });

    // 나머지 입력칸들: 값이 바뀌면 다시 계산
    ['tradeCost', 'rebalance', 'initial', 'logScale', 'showBench'].concat(
      TICKERS.map(function (t) { return 'c-' + t; })
    ).forEach(function (id) {
      $(id).addEventListener('input', scheduleUpdate);
    });
    ['startDate', 'endDate'].forEach(function (id) {
      $(id).addEventListener('change', function () { markPreset(null); scheduleUpdate(); });
    });

    // 시스템 다크모드가 바뀌면 차트 색을 다시 칠함
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', update);
  }

  function setWeight(t, v) {
    $('w-' + t).value = v;
    $('w-range-' + t).value = v;
  }

  function markPreset(years) {
    activePreset = years;
    Array.prototype.forEach.call($('periodPresets').children, function (b) {
      b.classList.toggle('active', years !== null && Number(b.dataset.years) === years);
    });
  }

  // ───────────────────────── 2. 기간 처리 ─────────────────────────

  // 비중이 0보다 큰 종목들이 "모두" 데이터를 가진 기간 = 백테스트 가능한 기간
  function availableRange(activeTickers) {
    let start = '0000-00-00', end = '9999-99-99';
    activeTickers.forEach(function (t) {
      const d = DATA.tickers[t].dates;
      if (d[0] > start) start = d[0];
      if (d[d.length - 1] < end) end = d[d.length - 1];
    });
    return { start: start, end: end };
  }

  function applyPeriodPreset(years) {
    const range = availableRange(activeTickers(readWeights()));
    $('endDate').value = range.end;
    if (years === 0) {
      $('startDate').value = range.start;
    } else {
      const d = new Date(range.end + 'T00:00:00Z');
      d.setUTCFullYear(d.getUTCFullYear() - years);
      const s = d.toISOString().slice(0, 10);
      $('startDate').value = s < range.start ? range.start : s;
    }
    markPreset(years);
  }

  // ───────────────────────── 3. 입력값 읽기 ─────────────────────────

  function readWeights() {
    const w = {};
    TICKERS.forEach(function (t) { w[t] = Math.max(0, Number($('w-' + t).value) || 0); });
    return w;
  }

  function activeTickers(w) {
    return TICKERS.filter(function (t) { return w[t] > 0; });
  }

  function readSettings() {
    const raw = readWeights();
    const total = TICKERS.reduce(function (s, t) { return s + raw[t]; }, 0);
    // 합계가 100이 아니어도 비율대로 환산해서 계산 (예: 1:1:1 → 33.3%씩)
    const weights = {};
    const costs = {};
    TICKERS.forEach(function (t) {
      weights[t] = total > 0 ? raw[t] / total : 0;
      costs[t] = (Number($('c-' + t).value) || 0) / 100;
    });
    return {
      rawTotal: total,
      weights: weights,
      costs: costs,
      tradeCost: (Number($('tradeCost').value) || 0) / 100,
      rebalance: $('rebalance').value,
      initial: Number($('initial').value) || 10000000,
      start: $('startDate').value,
      end: $('endDate').value
    };
  }

  // ───────────────────────── 4. 계산 + 그리기 ─────────────────────────

  let timer = null;
  function scheduleUpdate() {
    clearTimeout(timer);
    timer = setTimeout(update, 120); // 슬라이더를 끄는 동안 너무 자주 계산하지 않도록 잠깐 기다림
  }

  function update() {
    if (!DATA) return;
    // 프리셋이 선택돼 있으면 종목 구성이 바뀌어도 그 프리셋 기준으로 기간을 다시 맞춤
    if (activePreset !== null && activeTickers(readWeights()).length) {
      applyPeriodPreset(activePreset);
    }
    const s = readSettings();

    // 비중 합계 안내
    const sumEl = $('weightSum');
    sumEl.textContent = '합계 ' + s.rawTotal + '%' +
      (s.rawTotal !== 100 && s.rawTotal > 0 ? ' → 비율대로 환산해 계산합니다' : '');
    sumEl.classList.toggle('warn', s.rawTotal !== 100);
    if (s.rawTotal === 0) { setStatus('비중을 하나 이상 입력하세요.', true); return; }

    // 선택한 종목의 데이터가 있는 기간으로 날짜 제한
    const range = availableRange(activeTickers(s.weights));
    $('startDate').min = $('endDate').min = range.start;
    $('startDate').max = $('endDate').max = range.end;
    if (!s.start || s.start < range.start) s.start = $('startDate').value = range.start;
    if (!s.end || s.end > range.end) s.end = $('endDate').value = range.end;
    $('rangeNote').textContent = '선택한 종목의 데이터 기간: ' + range.start + ' ~ ' + range.end;

    const port = Backtest.runBacktest(DATA.tickers, s);
    if (!port) { setStatus('해당 기간에 데이터가 부족합니다. 기간을 넓혀주세요.', true); return; }
    setStatus('');

    // 비교용: 각 ETF 100% 보유 (같은 기간·같은 비용 조건)
    const series = [{ name: '내 포트폴리오', color: cssVar('--series-1'), res: port, main: true }];
    const skipped = [];
    TICKERS.forEach(function (t, i) {
      const w = {}; w[t] = 1;
      const r = Backtest.runBacktest(DATA.tickers, {
        weights: w, costs: s.costs, tradeCost: s.tradeCost, rebalance: 'none',
        initial: s.initial, start: port.dates[0], end: port.dates[port.dates.length - 1]
      });
      if (r && r.dates[0] === port.dates[0]) {
        series.push({ name: t + ' 100%', ticker: t, color: cssVar('--series-' + (i + 2)), res: r });
      } else {
        skipped.push(t);
      }
    });
    series.forEach(function (x) {
      x.stats = Backtest.computeStats(x.res.dates, x.res.values);
      x.dd = Backtest.drawdownSeries(x.res.values);
      x.annual = Backtest.annualReturns(x.res.dates, x.res.values);
      x.trailing = Backtest.trailingReturns(x.res.dates, x.res.values, PERIODS);
    });

    const showBench = $('showBench').checked;
    const visible = showBench ? series : series.slice(0, 1);

    renderTiles(series[0], s);
    renderValueChart(port.dates, visible);
    renderDrawdownChart(port.dates, visible);
    renderAnnualChart(visible);
    renderStatsTable(series);
    renderPeriodTable(series);

    $('foot').textContent =
      '데이터: ' + DATA.source + ' · 갱신일 ' + DATA.updated +
      (skipped.length ? ' · ' + skipped.join(', ') + '는 이 기간 데이터가 없어 비교에서 제외' : '') +
      ' · 리밸런싱 ' + port.rebalanceCount + '회 · 세금은 반영하지 않았습니다. 과거 성과가 미래 수익을 보장하지 않습니다.';
  }

  // ───────────────────────── 5. 결과 표시 함수들 ─────────────────────────

  function renderTiles(p, s) {
    const st = p.stats;
    const tiles = [
      { label: '최종 금액', value: fmtMoneyKo(st.finalValue), detail: '초기 ' + fmtMoneyKo(s.initial) },
      { label: '총수익률', value: fmtPct(st.totalReturn), detail: st.years.toFixed(1) + '년' },
      { label: '연평균 수익률 (CAGR)', value: fmtPct(st.cagr), detail: '매년 이만큼 복리로 불어난 셈' },
      { label: '최대낙폭 (MDD)', value: fmtPct(st.mdd), detail: st.mddPeak + ' → ' + st.mddTrough },
      { label: '변동성 (연)', value: fmtPct(st.volatility, false), detail: '샤프 ' + st.sharpe.toFixed(2) }
    ];
    $('tiles').innerHTML = tiles.map(function (t) {
      return '<div class="tile"><div class="label">' + t.label + '</div>' +
        '<div class="value">' + t.value + '</div><div class="detail">' + t.detail + '</div></div>';
    }).join('');
  }

  // 점이 너무 많으면 일정 간격으로 솎아서 차트 속도를 유지 (마지막 점은 항상 포함)
  function thinIndices(n) {
    const step = Math.max(1, Math.ceil(n / MAX_POINTS));
    const idx = [];
    for (let i = 0; i < n; i += step) idx.push(i);
    if (idx[idx.length - 1] !== n - 1) idx.push(n - 1);
    return idx;
  }

  // 날짜 기준으로 각 계열 값을 맞춰 뽑기
  function pick(dates, idx, res, arr) {
    const m = new Map();
    res.dates.forEach(function (d, i) { m.set(d, arr[i]); });
    return idx.map(function (i) { const v = m.get(dates[i]); return v === undefined ? null : v; });
  }

  function renderValueChart(dates, series) {
    const idx = thinIndices(dates.length);
    const labels = idx.map(function (i) { return dates[i]; });
    const datasets = series.map(function (x) {
      return lineDataset(x, pick(dates, idx, x.res, x.res.values));
    });
    drawChart('valueChart', 'line', labels, datasets, {
      yType: $('logScale').checked ? 'logarithmic' : 'linear',
      yFormat: fmtMoneyShort,
      tipFormat: fmtMoney
    });
  }

  function renderDrawdownChart(dates, series) {
    const idx = thinIndices(dates.length);
    const labels = idx.map(function (i) { return dates[i]; });
    const datasets = series.map(function (x) {
      const ds = lineDataset(x, pick(dates, idx, x.res, x.dd));
      if (x.main) { ds.fill = 'origin'; ds.backgroundColor = withAlpha(x.color, 0.15); }
      return ds;
    });
    drawChart('ddChart', 'line', labels, datasets, {
      yFormat: function (v) { return Math.round(v * 100) + '%'; },
      tipFormat: function (v) { return fmtPct(v); },
      yMax: 0
    });
  }

  function renderAnnualChart(series) {
    const years = series[0].annual.map(function (a) { return a.year + (a.partial ? '*' : ''); });
    const datasets = series.map(function (x) {
      const map = new Map(x.annual.map(function (a) { return [a.year, a.ret]; }));
      return {
        label: x.name,
        data: series[0].annual.map(function (a) { return map.has(a.year) ? map.get(a.year) : null; }),
        backgroundColor: x.color,
        borderColor: cssVar('--surface'),
        borderWidth: { left: 1, right: 1 },   // 막대 사이 얇은 간격
        borderRadius: 3,
        maxBarThickness: 28
      };
    });
    drawChart('annualChart', 'bar', years, datasets, {
      yFormat: function (v) { return Math.round(v * 100) + '%'; },
      tipFormat: function (v) { return fmtPct(v); },
      dateAxis: false
    });
  }

  function renderStatsTable(series) {
    const head = '<thead><tr><th>구분</th><th>최종 금액</th><th>총수익률</th><th>CAGR</th>' +
      '<th>MDD</th><th>MDD 고점→저점</th><th>MDD 회복</th><th>변동성</th><th>샤프</th></tr></thead>';
    const rows = series.map(function (x) {
      const st = x.stats;
      return '<tr><td>' + nameCell(x) + '</td>' +
        '<td>' + fmtMoney(st.finalValue) + '</td>' +
        '<td>' + colored(st.totalReturn) + '</td>' +
        '<td>' + colored(st.cagr) + '</td>' +
        '<td>' + colored(st.mdd) + '</td>' +
        '<td class="muted">' + st.mddPeak + ' → ' + st.mddTrough + '</td>' +
        '<td class="muted">' + (st.mddRecovery || '미회복') + '</td>' +
        '<td>' + fmtPct(st.volatility, false) + '</td>' +
        '<td>' + st.sharpe.toFixed(2) + '</td></tr>';
    }).join('');
    $('statsTable').innerHTML = head + '<tbody>' + rows + '</tbody>';
  }

  function renderPeriodTable(series) {
    const head = '<thead><tr><th>구분</th>' +
      PERIODS.map(function (y) { return '<th>최근 ' + y + '년</th>'; }).join('') +
      '<th>선택 기간 전체</th></tr></thead>';
    const cell = function (cagr, mdd) {
      if (cagr === null) return '<td class="muted">—</td>';
      return '<td>' + colored(cagr) + ' <span class="muted">/ ' + fmtPct(mdd) + '</span></td>';
    };
    const rows = series.map(function (x) {
      return '<tr><td>' + nameCell(x) + '</td>' +
        x.trailing.map(function (r) { return cell(r.cagr, r.mdd); }).join('') +
        cell(x.stats.cagr, x.stats.mdd) + '</tr>';
    }).join('');
    $('periodTable').innerHTML = head + '<tbody>' + rows + '</tbody>';
  }

  // ───────────────────────── 6. Chart.js 공통 설정 ─────────────────────────

  function lineDataset(x, data) {
    return {
      label: x.name,
      data: data,
      borderColor: x.color,
      backgroundColor: x.color,
      borderWidth: x.main ? 2.5 : 1.5,
      pointRadius: 0,
      pointHoverRadius: 4,
      pointHoverBorderWidth: 2,
      pointHoverBorderColor: cssVar('--surface'),
      spanGaps: true,
      tension: 0
    };
  }

  // 마우스 위치에 세로 안내선을 그리는 작은 플러그인
  const crosshair = {
    id: 'crosshair',
    afterDatasetsDraw: function (chart) {
      const active = chart.tooltip && chart.tooltip.getActiveElements();
      if (!active || !active.length || chart.config.type !== 'line') return;
      const x = active[0].element.x;
      const ctx = chart.ctx;
      ctx.save();
      ctx.strokeStyle = cssVar('--axis');
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, chart.chartArea.top);
      ctx.lineTo(x, chart.chartArea.bottom);
      ctx.stroke();
      ctx.restore();
    }
  };

  function drawChart(canvasId, type, labels, datasets, opt) {
    if (charts[canvasId]) charts[canvasId].destroy(); // 이전 차트 지우고 새로 그림
    const text = cssVar('--text-secondary');
    const muted = cssVar('--text-muted');
    const grid = cssVar('--grid');
    const dateAxis = opt.dateAxis !== false;

    charts[canvasId] = new Chart($(canvasId), {
      type: type,
      data: { labels: labels, datasets: datasets },
      plugins: [crosshair],
      options: {
        animation: false,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: {
            position: 'top', align: 'start',
            labels: { color: text, boxWidth: 12, boxHeight: 12, usePointStyle: true, pointStyle: 'rectRounded' }
          },
          tooltip: {
            callbacks: {
              label: function (c) {
                return ' ' + c.dataset.label + ': ' + (c.raw === null ? '—' : opt.tipFormat(c.raw));
              }
            }
          }
        },
        scales: {
          x: {
            grid: { display: false },
            border: { color: cssVar('--axis') },
            ticks: {
              color: muted, maxRotation: 0, autoSkip: true, maxTicksLimit: dateAxis ? 8 : 20,
              // 날짜 축은 "2020-03" 처럼 연-월만 표시
              callback: function (v) {
                const l = this.getLabelForValue(v);
                return dateAxis ? l.slice(0, 7) : l;
              }
            }
          },
          y: {
            type: opt.yType || 'linear',
            max: opt.yMax,
            grid: { color: grid },
            border: { display: false },
            ticks: { color: muted, maxTicksLimit: 7, callback: function (v) { return opt.yFormat(v); } }
          }
        }
      }
    });
  }

  // ───────────────────────── 7. 작은 도우미 함수들 ─────────────────────────

  function cssVar(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }

  function withAlpha(hex, a) {
    const n = parseInt(hex.replace('#', ''), 16);
    return 'rgba(' + (n >> 16 & 255) + ',' + (n >> 8 & 255) + ',' + (n & 255) + ',' + a + ')';
  }

  function fmtPct(v, signed) {
    const s = (v * 100).toFixed(1) + '%';
    return signed !== false && v > 0 ? '+' + s : s;
  }

  function colored(v) {
    return '<span class="' + (v >= 0 ? 'pos' : 'neg') + '">' + fmtPct(v) + '</span>';
  }

  function fmtMoney(v) {
    return Math.round(v).toLocaleString('ko-KR') + '원';
  }

  // 큰 금액을 읽기 쉽게: 317,416,315 → "3억 1,742만원"
  function fmtMoneyKo(v) {
    const man = Math.round(v / 1e4);
    if (man < 1) return fmtMoney(v);
    const eok = Math.floor(man / 1e4);
    const rest = man % 1e4;
    if (eok === 0) return rest.toLocaleString('ko-KR') + '만원';
    return eok.toLocaleString('ko-KR') + '억' + (rest ? ' ' + rest.toLocaleString('ko-KR') + '만' : '') + '원';
  }

  // 축 눈금용 짧은 표기: 1.2억, 3,500만
  function fmtMoneyShort(v) {
    if (Math.abs(v) >= 1e8) return (v / 1e8).toFixed(v >= 1e9 ? 0 : 1) + '억';
    if (Math.abs(v) >= 1e4) return Math.round(v / 1e4).toLocaleString('ko-KR') + '만';
    return Math.round(v).toLocaleString('ko-KR');
  }

  function nameCell(x) {
    return '<span class="dot" style="background:' + x.color + '"></span>' + (x.main ? '<b>' + x.name + '</b>' : x.name);
  }

  function setStatus(msg, isError) {
    $('status').textContent = msg;
    $('status').classList.toggle('error', !!isError);
  }

  // ───────────────────────── 8. 시작 ─────────────────────────

  function loadData() {
    fetch('data/prices.json')
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function (json) {
        DATA = json;
        update(); // 처음엔 "전체 기간" (activePreset = 0)
      })
      .catch(function (err) {
        setStatus('data/prices.json을 불러오지 못했습니다 (' + err.message + '). ' +
          '로컬에서 파일을 직접 열었다면 README의 "내 컴퓨터에서 실행하기"를 참고하세요.', true);
      });
  }

  buildInputs();
  loadData();
})();
