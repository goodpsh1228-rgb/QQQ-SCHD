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
  let HOUSING = null;              // housing.json 내용 (없으면 주택 비교 생략)
  const housingCache = {};         // 월간 주택지수를 일별로 펼친 결과 보관
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
    ['tradeCost', 'rebalance', 'initial', 'monthly', 'logScale', 'showBench',
     'taxOn', 'account', 'taxDiv', 'taxCap', 'taxDeduction', 'taxLiquidate',
     'isaExempt', 'isaRate', 'creditRate', 'creditLimit', 'pensionRate', 'housing'].concat(
      TICKERS.map(function (t) { return 'c-' + t; })
    ).forEach(function (id) {
      $(id).addEventListener('input', scheduleUpdate);
    });
    ['startDate', 'endDate'].forEach(function (id) {
      $(id).addEventListener('change', function () { markPreset(null); scheduleUpdate(); });
    });

    // ISA 유형을 고르면 비과세 한도 칸을 그 값으로 채움
    $('isaType').addEventListener('input', function (e) {
      $('isaExempt').value = e.target.value;
      scheduleUpdate();
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
      initial: Math.max(0, Number($('initial').value) || 0),
      monthly: Math.max(0, Number($('monthly').value) || 0),
      tax: {
        enabled: $('taxOn').checked,
        dividend: (Number($('taxDiv').value) || 0) / 100,
        capital: (Number($('taxCap').value) || 0) / 100,
        deduction: Math.max(0, Number($('taxDeduction').value) || 0),
        liquidate: $('taxLiquidate').checked,
        account: $('account').value,
        isaExempt: Math.max(0, Number($('isaExempt').value) || 0),
        isaRate: (Number($('isaRate').value) || 0) / 100,
        creditRate: (Number($('creditRate').value) || 0) / 100,
        creditLimit: Math.max(0, Number($('creditLimit').value) || 0),
        pensionRate: (Number($('pensionRate').value) || 0) / 100
      },
      housing: $('housing').value,
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
    if (s.initial === 0 && s.monthly === 0) { setStatus('처음 넣는 돈이나 매월 적립금을 입력하세요.', true); return; }
    $('taxFields').hidden = !s.tax.enabled;
    // 선택한 계좌 종류의 입력칸만 보이기
    Array.prototype.forEach.call(document.querySelectorAll('[data-account]'), function (el) {
      el.hidden = el.dataset.account !== s.tax.account;
    });

    // 선택한 종목의 데이터가 있는 기간으로 날짜 제한
    const range = availableRange(activeTickers(s.weights));
    $('startDate').min = $('endDate').min = range.start;
    $('startDate').max = $('endDate').max = range.end;
    if (!s.start || s.start < range.start) s.start = $('startDate').value = range.start;
    if (!s.end || s.end > range.end) s.end = $('endDate').value = range.end;
    $('rangeNote').textContent = '선택한 종목의 데이터 기간: ' + range.start + ' ~ ' + range.end;

    const port = Backtest.runBacktest(DATA.tickers, s);
    if (!port) { setStatus('해당 기간에 데이터가 부족합니다. 기간을 넓혀주세요.', true); return; }
    setStatus(limitWarning(port, s));

    // 비교용: 각 ETF 100% 보유 (같은 기간·같은 비용·같은 적립금·같은 세금 조건)
    const series = [{ name: '내 포트폴리오', color: cssVar('--series-1'), res: port, main: true }];
    const skipped = [];
    TICKERS.forEach(function (t, i) {
      const w = {}; w[t] = 1;
      const r = Backtest.runBacktest(DATA.tickers, {
        weights: w, costs: s.costs, tradeCost: s.tradeCost, rebalance: 'none',
        initial: s.initial, monthly: s.monthly, tax: s.tax,
        start: port.dates[0], end: port.dates[port.dates.length - 1]
      });
      if (r && r.dates[0] === port.dates[0]) {
        series.push({ name: t + ' 100%', ticker: t, color: cssVar('--series-' + (i + 2)), res: r });
      } else {
        skipped.push(t);
      }
    });
    // 주택가격지수 비교선: 같은 돈을 같은 날짜에 넣었다고 가정 (세금·거래비용 없음)
    let housingMsg = '';
    if (s.housing && HOUSING && HOUSING.series[s.housing]) {
      const hs = HOUSING.series[s.housing];
      const r = Backtest.runBacktest({ HOUSE: housingDaily(s.housing) }, {
        weights: { HOUSE: 1 }, costs: {}, tradeCost: 0, rebalance: 'none',
        initial: s.initial, monthly: s.monthly, tax: { enabled: false },
        start: port.dates[0], end: port.dates[port.dates.length - 1]
      });
      if (r && r.dates[0] === port.dates[0]) {
        series.push({ name: hs.name, color: cssVar('--series-5'), res: r, housing: true });
      } else {
        housingMsg = hs.name + ' 지수는 ' + hs.months[0] + '부터 있어 이 기간 비교에서 제외';
      }
    } else if (s.housing && !HOUSING) {
      housingMsg = '주택가격 데이터(data/housing.json)가 아직 없습니다';
    }

    // 수익률 지표는 "수익률 지수(index)"로 계산 → 적립금이 들어와도 수익률이 부풀려지지 않음
    series.forEach(function (x) {
      x.stats = Backtest.computeStats(x.res.dates, x.res.index);
      x.dd = Backtest.drawdownSeries(x.res.index);
      x.annual = Backtest.annualReturns(x.res.dates, x.res.index);
      x.trailing = Backtest.trailingReturns(x.res.dates, x.res.index, PERIODS);
    });
    // IRR은 적립식이거나 세금을 반영할 때 의미가 있음 (거치식·세금 없음이면 CAGR과 같음)
    const showIrr = s.monthly > 0 || s.tax.enabled;

    const showBench = $('showBench').checked;
    const visible = showBench ? series : series.slice(0, 1);

    renderTiles(series[0], s, showIrr);
    renderValueChart(port.dates, visible, s.monthly > 0);
    $('ddHint').textContent = s.monthly > 0 ? '(적립금 효과를 뺀 수익률 기준)' : '';
    renderDrawdownChart(port.dates, visible);
    renderAnnualChart(visible);
    renderStatsTable(series, s, showIrr);
    renderPeriodTable(series);

    const noDivData = s.tax.enabled && TICKERS.some(function (t) { return !DATA.tickers[t].divs; });
    $('foot').textContent =
      '데이터: ' + DATA.source + ' · 갱신일 ' + DATA.updated +
      (skipped.length ? ' · ' + skipped.join(', ') + '는 이 기간 데이터가 없어 비교에서 제외' : '') +
      (housingMsg ? ' · ' + housingMsg : '') +
      (HOUSING ? ' · 주택: ' + HOUSING.source + ' (' + HOUSING.updated + ')' : '') +
      ' · 리밸런싱 ' + port.rebalanceCount + '회' +
      ' · 거래비용 ' + fmtMoneyKo(port.paid.fee) + ', 추가 비용 ' + fmtMoneyKo(port.paid.extraCost) +
      (s.tax.enabled ? '' : ' · 세금 미반영') +
      (noDivData ? ' · ⚠ 배당 데이터가 없어 배당소득세를 계산하지 못했습니다 (데이터 갱신 필요)' : '') +
      ' · 과거 성과가 미래 수익을 보장하지 않습니다.';
  }

  // ───────────────────────── 5. 결과 표시 함수들 ─────────────────────────

  function renderTiles(p, s, showIrr) {
    const st = p.stats;
    const r = p.res;
    const profit = r.totalWealth - r.invested;
    const months = s.monthly > 0 ? Math.round((r.invested - s.initial) / s.monthly) : 0;
    const taxTotal = r.paid.dividendTax + r.paid.capitalTax + r.paid.exitTax;
    const acc = s.tax.enabled ? s.tax.account : 'none';
    const tiles = [
      { label: '투자원금', value: fmtMoneyKo(r.invested),
        detail: s.monthly > 0 ? '처음 ' + fmtMoneyKo(s.initial) + ' + 월 ' + fmtMoneyKo(s.monthly) + ' × ' + months + '회'
                              : st.years.toFixed(1) + '년 거치' },
      { label: '최종 금액', value: fmtMoneyKo(r.finalValue),
        detail: {
          none: '세전 평가금액',
          overseas: s.tax.liquidate ? '전부 매도·양도세 정산 후' : '보유 중 평가금액 (미실현 이익 세금 전)',
          isa: '종료일 해지·세금 정산 후',
          pension: '종료일 전액 인출·세금 정산 후'
        }[acc] },
      { label: '수익금', value: (profit >= 0 ? '+' : '−') + fmtMoneyKo(Math.abs(profit)),
        detail: '원금 대비 ' + fmtPct(r.invested > 0 ? profit / r.invested : 0) +
          (acc === 'pension' ? ' · 세액공제 환급 포함' : '') },
      { label: '연평균 수익률 (CAGR)', value: fmtPct(st.cagr),
        detail: s.monthly > 0 ? '운용 성과 기준 (적립 시점 영향 제외)' : '매년 이만큼 복리로 불어난 셈' }
    ];
    if (showIrr && r.irr !== null) {
      tiles.push({ label: '실제 연수익률 (IRR)', value: fmtPct(r.irr),
        detail: s.monthly > 0 ? '돈 넣은 시점' + (s.tax.enabled ? '·세금' : '') + '까지 반영' : '세금까지 반영' });
    }
    tiles.push({ label: '최대낙폭 (MDD)', value: fmtPct(st.mdd), detail: st.mddPeak + ' → ' + st.mddTrough });
    if (s.tax.enabled) {
      tiles.push({ label: '낸 세금 합계', value: fmtMoneyKo(taxTotal),
        detail: acc === 'overseas'
          ? '배당세 ' + fmtMoneyKo(r.paid.dividendTax) + ' · 양도세 ' + fmtMoneyKo(r.paid.capitalTax)
          : '배당 원천징수 ' + fmtMoneyKo(r.paid.dividendTax) + ' · ' + (acc === 'isa' ? '해지 시 ' : '인출 시 ') + fmtMoneyKo(r.paid.exitTax) });
    }
    if (acc === 'pension') {
      tiles.push({ label: '세액공제 환급', value: fmtMoneyKo(r.refund), detail: '계좌 밖으로 받은 돈 (최종 금액과 별도)' });
    }
    tiles.push({ label: '변동성 (연)', value: fmtPct(st.volatility, false), detail: '샤프 ' + st.sharpe.toFixed(2) });

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

  function renderValueChart(dates, series, showPrincipal) {
    const idx = thinIndices(dates.length);
    const labels = idx.map(function (i) { return dates[i]; });
    const log = $('logScale').checked;
    // 로그 스케일에서는 0을 그릴 수 없으므로 빈칸(null) 처리
    const clean = function (arr) { return arr.map(function (v) { return log && !(v > 0) ? null : v; }); };
    const datasets = series.map(function (x) {
      return lineDataset(x, clean(pick(dates, idx, x.res, x.res.values)));
    });
    if (showPrincipal) {
      // 투자원금 누적선 (회색 점선): 이 선과 계좌 금액의 차이가 수익금
      const main = series[0].res;
      datasets.push({
        label: '투자원금',
        data: clean(pick(dates, idx, main, main.principal)),
        borderColor: cssVar('--text-muted'),
        backgroundColor: cssVar('--text-muted'),
        borderWidth: 1.5,
        borderDash: [5, 4],
        pointRadius: 0,
        pointHoverRadius: 3,
        stepped: true
      });
    }
    drawChart('valueChart', 'line', labels, datasets, {
      yType: log ? 'logarithmic' : 'linear',
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

  function renderStatsTable(series, s, showIrr) {
    const taxOn = s.tax.enabled;
    const pension = taxOn && s.tax.account === 'pension';
    const head = '<thead><tr><th>구분</th><th>최종 금액' + (pension ? ' (환급 포함)' : '') + '</th><th>수익률(원금 대비)</th><th>CAGR</th>' +
      (showIrr ? '<th>IRR</th>' : '') +
      '<th>MDD</th><th>MDD 고점→저점</th><th>MDD 회복</th><th>변동성</th><th>샤프</th>' +
      (taxOn ? '<th>세금 합계</th>' : '') + '</tr></thead>';
    const rows = series.map(function (x) {
      const st = x.stats;
      const r = x.res;
      return '<tr><td>' + nameCell(x) + '</td>' +
        '<td>' + fmtMoney(r.totalWealth) + '</td>' +
        '<td>' + colored(r.invested > 0 ? r.totalWealth / r.invested - 1 : 0) + '</td>' +
        '<td>' + colored(st.cagr) + '</td>' +
        (showIrr ? '<td>' + (r.irr === null ? '—' : colored(r.irr)) + '</td>' : '') +
        '<td>' + colored(st.mdd) + '</td>' +
        '<td class="muted">' + st.mddPeak + ' → ' + st.mddTrough + '</td>' +
        '<td class="muted">' + (st.mddRecovery || '미회복') + '</td>' +
        // 주택지수는 월간 데이터라 일별 변동성·샤프를 계산하면 왜곡되므로 표시하지 않음
        '<td>' + (x.housing ? '<span class="muted">—</span>' : fmtPct(st.volatility, false)) + '</td>' +
        '<td>' + (x.housing ? '<span class="muted">—</span>' : st.sharpe.toFixed(2)) + '</td>' +
        (taxOn ? '<td>' + (x.housing ? '<span class="muted">미반영</span>' : fmtMoney(r.paid.dividendTax + r.paid.capitalTax + r.paid.exitTax)) + '</td>' : '') + '</tr>';
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

  // ───────────────────────── 7. 주택지수·납입한도 ─────────────────────────

  /*
   * 월간 주택가격지수를 ETF와 같은 일별 달력에 맞춰 펼친다.
   * KB 월간 지수는 매월 중순 기준으로 조사되므로, 각 달의 값은 그달 15일부터 다음 달 14일까지 유지.
   */
  function housingDaily(key) {
    if (housingCache[key]) return housingCache[key];
    const hs = HOUSING.series[key];
    const calendar = DATA.tickers.SPY.dates; // 가장 긴 거래일 달력
    const dates = [], close = [];
    let k = -1;
    calendar.forEach(function (d) {
      while (k + 1 < hs.months.length && hs.months[k + 1] + '-15' <= d) k++;
      if (k >= 0) { dates.push(d); close.push(hs.values[k]); }
    });
    housingCache[key] = { dates: dates, close: close };
    return housingCache[key];
  }

  // ISA·연금저축 납입 한도를 넘으면 경고 문구 반환
  function limitWarning(res, s) {
    if (!s.tax.enabled) return '';
    const years = Object.keys(res.contribByYear).sort();
    if (s.tax.account === 'pension') {
      const over = years.filter(function (y) { return res.contribByYear[y] > 18000000; });
      if (over.length) return '⚠ ' + over[0] + '년부터 연금저축 납입 한도(연 1,800만원, IRP 합산)를 넘습니다' +
        '. 실제로는 넣을 수 없는 금액이니 적립금을 줄여 보세요.';
    }
    if (s.tax.account === 'isa') {
      // 연 2,000만원, 안 쓴 한도는 이월, 총 1억원
      let cum = 0;
      const over = years.filter(function (y, i) {
        cum += res.contribByYear[y];
        return cum > 20000000 * (i + 1) || cum > 100000000;
      });
      if (over.length) return '⚠ ' + over[0] + '년부터 ISA 납입 한도(연 2,000만원·이월 가능, 총 1억원)를 넘습니다' +
        '. 실제로는 넣을 수 없는 금액이니 투자금을 줄여 보세요.';
    }
    return '';
  }

  // ───────────────────────── 8. 작은 도우미 함수들 ─────────────────────────

  function cssVar(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }

  function withAlpha(hex, a) {
    const n = parseInt(hex.replace('#', ''), 16);
    return 'rgba(' + (n >> 16 & 255) + ',' + (n >> 8 & 255) + ',' + (n & 255) + ',' + a + ')';
  }

  function fmtPct(v, signed) {
    if (Math.abs(v) < 0.0005) v = 0;   // -0.0% 같은 표기 방지
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

  // ───────────────────────── 9. 시작 ─────────────────────────

  function loadData() {
    fetch('data/prices.json')
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function (json) {
        DATA = json;
        // 주택가격 데이터는 선택 사항: 없거나 실패해도 ETF 백테스트는 그대로 동작
        return fetch('data/housing.json')
          .then(function (r) { return r.ok ? r.json() : null; })
          .catch(function () { return null; });
      })
      .then(function (housing) {
        HOUSING = housing;
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
