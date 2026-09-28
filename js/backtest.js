/*
 * backtest.js — 포트폴리오 백테스트 계산만 담당하는 파일 (화면/차트 코드는 app.js)
 *
 * 입력 데이터: 티커별 "수정종가(adjusted close)" 일별 시계열.
 *   수정종가는 배당을 재투자하고 분할을 반영한 가격이라, 이 값의 변화율이 곧 "총수익률"이다.
 *   ETF 자체 운용보수(QQQ 0.20%, SCHD 0.06%, SPY 0.0945%)는 이미 가격에 반영돼 있다.
 *   그래서 여기서 말하는 "비용"은 그 외의 추가 비용(증권사 수수료, 환전 비용 등)이다.
 */
(function (root) {
  'use strict';

  const TRADING_DAYS = 252; // 1년 거래일 수 (변동성 연율화에 사용)

  // "2024-03-15" 같은 문자열 사이의 날짜 수
  function daysBetween(a, b) {
    return (Date.parse(b) - Date.parse(a)) / 86400000;
  }

  // 리밸런싱 주기가 바뀌는 날인지 판단: 이전 거래일과 월/분기/연도가 다르면 true
  function periodKey(date, freq) {
    const y = date.slice(0, 4);
    const m = Number(date.slice(5, 7));
    if (freq === 'monthly') return y + '-' + m;
    if (freq === 'quarterly') return y + '-Q' + Math.ceil(m / 3);
    if (freq === 'yearly') return y;
    return null; // 'none' → 리밸런싱 안 함
  }

  /*
   * 여러 티커의 가격을 같은 날짜 기준으로 정렬한다.
   * tickers에 포함된 모든 종목의 가격이 있는 날짜만 남긴다 (교집합).
   * 반환: { dates: [...], prices: { QQQ: [...], ... } }
   */
  function alignPrices(data, tickers, startDate, endDate) {
    const maps = {};
    tickers.forEach(function (t) {
      const m = new Map();
      data[t].dates.forEach(function (d, i) { m.set(d, data[t].close[i]); });
      maps[t] = m;
    });
    // 기준 날짜 목록: 첫 번째 티커의 날짜 중 나머지에도 모두 있는 날짜
    const base = data[tickers[0]].dates;
    const dates = [];
    const prices = {};
    tickers.forEach(function (t) { prices[t] = []; });
    base.forEach(function (d) {
      if (startDate && d < startDate) return;
      if (endDate && d > endDate) return;
      for (let k = 0; k < tickers.length; k++) {
        if (!maps[tickers[k]].has(d)) return;
      }
      dates.push(d);
      tickers.forEach(function (t) { prices[t].push(maps[t].get(d)); });
    });
    return { dates: dates, prices: prices };
  }

  /*
   * 백테스트 본체.
   * options = {
   *   weights:   { QQQ: 0.4, SCHD: 0.3, SPY: 0.3 },   // 합이 1
   *   costs:     { QQQ: 0.002, ... },                 // 연간 추가 비용 (0.002 = 0.2%/년)
   *   rebalance: 'none' | 'monthly' | 'quarterly' | 'yearly',
   *   tradeCost: 0.001,                               // 리밸런싱 매매 금액에 붙는 거래비용 (0.1%)
   *   initial:   10000,                               // 초기 투자금
   *   start, end                                      // 'YYYY-MM-DD' (선택)
   * }
   * 반환: { dates, values(자산가치 배열), ... } 또는 데이터가 없으면 null
   */
  function runBacktest(data, options) {
    const tickers = Object.keys(options.weights).filter(function (t) {
      return options.weights[t] > 0;
    });
    if (tickers.length === 0) return null;

    const aligned = alignPrices(data, tickers, options.start, options.end);
    const dates = aligned.dates;
    const P = aligned.prices;
    if (dates.length < 2) return null;

    const initial = options.initial || 10000;
    const tradeCost = options.tradeCost || 0;
    const freq = options.rebalance || 'none';

    // 첫날: 목표 비중대로 매수 (최초 매수 거래비용도 반영)
    let holdings = {};
    tickers.forEach(function (t) {
      holdings[t] = initial * options.weights[t] * (1 - tradeCost);
    });

    const values = [sum(holdings)];
    let totalCostPaid = initial * tradeCost;
    let rebalanceCount = 0;

    for (let i = 1; i < dates.length; i++) {
      const dt = daysBetween(dates[i - 1], dates[i]);

      // 1) 가격 변화 반영 + 2) 연간 추가 비용을 경과 일수만큼 차감
      tickers.forEach(function (t) {
        const priceRatio = P[t][i] / P[t][i - 1];
        const cost = (options.costs && options.costs[t]) || 0;
        const before = holdings[t] * priceRatio;
        const after = before * Math.pow(1 - cost, dt / 365);
        totalCostPaid += before - after;
        holdings[t] = after;
      });

      // 3) 새 월/분기/연도의 첫 거래일이면 목표 비중으로 리밸런싱
      if (freq !== 'none' && tickers.length > 1 &&
          periodKey(dates[i], freq) !== periodKey(dates[i - 1], freq)) {
        const total = sum(holdings);
        // 사고파는 금액(회전율) = 목표 금액과 현재 금액 차이의 합
        let turnover = 0;
        tickers.forEach(function (t) {
          turnover += Math.abs(total * options.weights[t] - holdings[t]);
        });
        const fee = turnover * tradeCost;
        totalCostPaid += fee;
        const afterFee = total - fee;
        tickers.forEach(function (t) { holdings[t] = afterFee * options.weights[t]; });
        rebalanceCount++;
      }

      values.push(sum(holdings));
    }

    return {
      dates: dates,
      values: values,
      tickers: tickers,
      totalCostPaid: totalCostPaid,
      rebalanceCount: rebalanceCount
    };
  }

  function sum(obj) {
    let s = 0;
    Object.keys(obj).forEach(function (k) { s += obj[k]; });
    return s;
  }

  // 낙폭(drawdown) 시계열: 각 날짜에 "직전 최고점 대비 몇 % 빠져 있는가" (0 또는 음수)
  function drawdownSeries(values) {
    let peak = values[0];
    return values.map(function (v) {
      if (v > peak) peak = v;
      return v / peak - 1;
    });
  }

  /*
   * 성과 지표 계산
   *  - 총수익률: 마지막 / 처음 - 1
   *  - CAGR(연평균 복리수익률): 매년 같은 비율로 불어났다고 쳤을 때의 연 수익률
   *  - MDD(최대낙폭): 고점에서 저점까지 가장 크게 빠진 비율
   *  - 변동성: 일간 수익률의 표준편차 × √252 (1년 기준 흔들림 정도)
   *  - 샤프지수: CAGR / 변동성 (무위험수익률 0 가정, 위험 1단위당 수익)
   */
  function computeStats(dates, values) {
    const n = values.length;
    const years = daysBetween(dates[0], dates[n - 1]) / 365.25;
    const totalReturn = values[n - 1] / values[0] - 1;
    const cagr = years > 0 ? Math.pow(values[n - 1] / values[0], 1 / years) - 1 : 0;

    // MDD와 그 고점/저점/회복 날짜
    let peak = values[0], peakIdx = 0;
    let mdd = 0, mddPeakIdx = 0, mddTroughIdx = 0;
    for (let i = 1; i < n; i++) {
      if (values[i] > peak) { peak = values[i]; peakIdx = i; }
      const dd = values[i] / peak - 1;
      if (dd < mdd) { mdd = dd; mddPeakIdx = peakIdx; mddTroughIdx = i; }
    }
    let recoveryIdx = -1;
    for (let i = mddTroughIdx + 1; i < n; i++) {
      if (values[i] >= values[mddPeakIdx]) { recoveryIdx = i; break; }
    }

    // 일간 수익률의 표준편차 → 연율화
    const rets = [];
    for (let i = 1; i < n; i++) rets.push(values[i] / values[i - 1] - 1);
    const mean = rets.reduce(function (a, b) { return a + b; }, 0) / rets.length;
    const variance = rets.reduce(function (a, r) { return a + (r - mean) * (r - mean); }, 0) /
      Math.max(rets.length - 1, 1);
    const volatility = Math.sqrt(variance) * Math.sqrt(TRADING_DAYS);

    return {
      start: dates[0],
      end: dates[n - 1],
      years: years,
      finalValue: values[n - 1],
      totalReturn: totalReturn,
      cagr: cagr,
      mdd: mdd,
      mddPeak: dates[mddPeakIdx],
      mddTrough: dates[mddTroughIdx],
      mddRecovery: recoveryIdx >= 0 ? dates[recoveryIdx] : null,
      volatility: volatility,
      sharpe: volatility > 0 ? cagr / volatility : 0
    };
  }

  /*
   * 연도별 수익률: 각 해의 마지막 거래일 값 / 전년도 마지막 거래일 값 - 1
   * (첫 해·마지막 해는 기간 일부만 포함될 수 있음 → partial 표시)
   */
  function annualReturns(dates, values) {
    const out = [];
    let prevVal = values[0];
    let curYear = dates[0].slice(0, 4);
    let firstOfYear = dates[0];
    for (let i = 1; i <= dates.length; i++) {
      const y = i < dates.length ? dates[i].slice(0, 4) : null;
      if (y !== curYear) {
        const endVal = values[i - 1];
        out.push({
          year: curYear,
          ret: endVal / prevVal - 1,
          partial: firstOfYear.slice(5) > '01-07' || (y === null && dates[i - 1].slice(5) < '12-24')
        });
        prevVal = endVal;
        curYear = y;
        if (i < dates.length) firstOfYear = dates[i];
      }
    }
    return out;
  }

  /*
   * 최근 N년 수익률 (종료일 기준으로 거슬러 올라감)
   * 반환: [{ label: '최근 3년', total, cagr, mdd }] — 기간이 데이터보다 길면 null
   */
  function trailingReturns(dates, values, yearsList) {
    const n = values.length;
    const endDate = dates[n - 1];
    return yearsList.map(function (yrs) {
      const target = new Date(Date.parse(endDate));
      target.setUTCFullYear(target.getUTCFullYear() - yrs);
      const targetStr = target.toISOString().slice(0, 10);
      if (targetStr < dates[0]) return { years: yrs, total: null, cagr: null, mdd: null };
      // 목표 날짜 이후 첫 거래일
      let idx = 0;
      while (idx < n && dates[idx] < targetStr) idx++;
      const slice = values.slice(idx);
      const total = values[n - 1] / values[idx] - 1;
      const cagr = yrs >= 1 ? Math.pow(1 + total, 1 / yrs) - 1 : total;
      const dd = drawdownSeries(slice);
      return { years: yrs, total: total, cagr: cagr, mdd: Math.min.apply(null, dd) };
    });
  }

  const api = {
    alignPrices: alignPrices,
    runBacktest: runBacktest,
    drawdownSeries: drawdownSeries,
    computeStats: computeStats,
    annualReturns: annualReturns,
    trailingReturns: trailingReturns
  };

  // 브라우저에서는 window.Backtest 로, Node(테스트)에서는 require 로 사용
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Backtest = api;
})(this);
