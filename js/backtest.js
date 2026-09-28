/*
 * backtest.js — 포트폴리오 백테스트 계산만 담당하는 파일 (화면/차트 코드는 app.js)
 *
 * 입력 데이터(티커별):
 *   close: 배당을 재투자했을 때의 총수익 지수. 이 값의 변화율이 곧 "세전 총수익률"이다.
 *   divs:  [날짜, 배당수익률] 목록. 배당소득세를 뗄 때 사용한다.
 *   ETF 자체 운용보수(QQQ 0.20%, SCHD 0.06%, SPY 0.0945%)는 이미 가격에 반영돼 있다.
 *   그래서 여기서 말하는 "비용"은 그 외의 추가 비용(증권사 수수료, 환전 비용 등)이다.
 *
 * 세금 (한국 거주자가 일반 계좌로 미국 ETF에 직접 투자하는 경우를 단순화):
 *   - 배당소득세: 배당을 받을 때 원천징수(기본 15%), 세후 배당을 재투자
 *   - 양도소득세: 1년 동안 매도로 생긴 이익(손실과 상계)에서 기본공제(250만원)를 뺀 금액의 22%
 *                 실제 납부는 다음 해 5월이지만, 여기서는 다음 해 첫 거래일에 보유 자산을 팔아 낸다고 가정
 *                 취득가는 평균단가 방식으로 계산
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
   * 반환: { dates: [...], prices: { QQQ: [...] }, divs: { QQQ: [...] } }
   *   divs[t][i] = 그날의 배당수익률 (배당이 없으면 0)
   */
  function alignPrices(data, tickers, startDate, endDate) {
    const maps = {};
    const divMaps = {};
    tickers.forEach(function (t) {
      const m = new Map();
      data[t].dates.forEach(function (d, i) { m.set(d, data[t].close[i]); });
      maps[t] = m;
      divMaps[t] = new Map(data[t].divs || []);
    });
    // 기준 날짜 목록: 첫 번째 티커의 날짜 중 나머지에도 모두 있는 날짜
    const base = data[tickers[0]].dates;
    const dates = [];
    const prices = {};
    const divs = {};
    tickers.forEach(function (t) { prices[t] = []; divs[t] = []; });
    base.forEach(function (d) {
      if (startDate && d < startDate) return;
      if (endDate && d > endDate) return;
      for (let k = 0; k < tickers.length; k++) {
        if (!maps[tickers[k]].has(d)) return;
      }
      dates.push(d);
      tickers.forEach(function (t) {
        prices[t].push(maps[t].get(d));
        divs[t].push(divMaps[t].get(d) || 0);
      });
    });
    return { dates: dates, prices: prices, divs: divs };
  }

  /*
   * 백테스트 본체.
   * options = {
   *   weights:   { QQQ: 0.4, SCHD: 0.3, SPY: 0.3 },   // 합이 1
   *   costs:     { QQQ: 0.002, ... },                 // 연간 추가 비용 (0.002 = 0.2%/년)
   *   rebalance: 'none' | 'monthly' | 'quarterly' | 'yearly',
   *   tradeCost: 0.001,                               // 매수·매도 금액에 붙는 거래비용 (0.1%)
   *   initial:   10000000,                            // 처음 넣는 돈
   *   monthly:   500000,                              // 매월 추가로 넣는 돈 (0이면 거치식)
   *   tax: { enabled, dividend: 0.15, capital: 0.22, deduction: 2500000, liquidate: true },
   *   start, end                                      // 'YYYY-MM-DD' (선택)
   * }
   *
   * 반환값 중 중요한 것
   *   values    : 날짜별 계좌 금액 (적립금 포함)
   *   principal : 날짜별 누적 투자원금
   *   index     : 날짜별 "수익률 지수" (1에서 시작). 적립금 입금 효과를 뺀 순수 운용 성과로,
   *               펀드 기준가와 같은 개념이다. CAGR·MDD·연도별 수익률은 이것으로 계산한다.
   */
  function runBacktest(data, options) {
    const tickers = Object.keys(options.weights).filter(function (t) {
      return options.weights[t] > 0;
    });
    if (tickers.length === 0) return null;

    const aligned = alignPrices(data, tickers, options.start, options.end);
    const dates = aligned.dates;
    const P = aligned.prices;
    const D = aligned.divs;
    if (dates.length < 2) return null;

    const w = options.weights;
    const initial = options.initial || 0;
    const monthly = options.monthly || 0;
    const tc = options.tradeCost || 0;
    const freq = options.rebalance || 'none';
    const tax = options.tax || {};
    const taxOn = !!tax.enabled;
    const divRate = taxOn ? (tax.dividend || 0) : 0;
    const capRate = taxOn ? (tax.capital || 0) : 0;
    const deduction = tax.deduction || 0;

    // 상태 변수
    const holdings = {};  // 종목별 평가금액
    const basis = {};     // 종목별 취득원가 (양도세 계산용)
    tickers.forEach(function (t) { holdings[t] = 0; basis[t] = 0; });
    let realizedYTD = 0;  // 올해 매도로 확정된 이익(손실은 음수)
    const paid = { fee: 0, extraCost: 0, dividendTax: 0, capitalTax: 0 };
    let invested = 0;
    let rebalanceCount = 0;
    const flows = [];     // IRR 계산용 입출금 기록 [{date, amount}]

    // 목표 비중대로 amount만큼 매수
    function buy(amount, date) {
      tickers.forEach(function (t) {
        holdings[t] += amount * w[t] * (1 - tc);
        basis[t] += amount * w[t];      // 수수료도 취득가에 포함
      });
      paid.fee += amount * tc;
      invested += amount;
      flows.push({ date: date, amount: -amount });
    }

    // 모든 종목을 같은 비율 frac만큼 매도하고 그 금액을 빼냄 (세금 납부용)
    function sellProRata(frac) {
      tickers.forEach(function (t) {
        realizedYTD += frac * (holdings[t] - basis[t]);
        holdings[t] *= 1 - frac;
        basis[t] *= 1 - frac;
      });
    }

    buy(initial, dates[0]);
    const values = [total()];
    const principal = [invested];
    const index = [1];

    for (let i = 1; i < dates.length; i++) {
      const dt = daysBetween(dates[i - 1], dates[i]);
      const newYear = dates[i].slice(0, 4) !== dates[i - 1].slice(0, 4);
      const newMonth = dates[i].slice(0, 7) !== dates[i - 1].slice(0, 7);

      // 1) 가격 변화(배당 재투자 포함) + 배당소득세 + 연간 추가 비용
      tickers.forEach(function (t) {
        const prev = holdings[t];
        let h = prev * P[t][i] / P[t][i - 1];
        const y = D[t][i];              // 오늘 배당락이면 배당수익률, 아니면 0
        if (y > 0) {
          const dividend = prev * y;
          const divTax = dividend * divRate;
          h -= divTax;                  // 세금만큼 재투자 금액이 줄어듦
          paid.dividendTax += divTax;
          basis[t] += dividend - divTax; // 재투자한 배당은 새로 산 것이므로 취득가에 더함
        }
        const cost = (options.costs && options.costs[t]) || 0;
        const after = h * Math.pow(1 - cost, dt / 365);
        paid.extraCost += h - after;
        holdings[t] = after;
      });

      // 2) 해가 바뀌면 지난해 양도소득세 납부
      if (newYear && taxOn) {
        const taxable = realizedYTD - deduction;
        realizedYTD = 0;
        if (taxable > 0) {
          const due = taxable * capRate;
          const v = total();
          sellProRata(Math.min(due / v, 1));
          paid.capitalTax += due;
        }
      }

      // 3) 새 월/분기/연도의 첫 거래일이면 목표 비중으로 리밸런싱
      if (freq !== 'none' && tickers.length > 1 &&
          periodKey(dates[i], freq) !== periodKey(dates[i - 1], freq)) {
        rebalance();
        rebalanceCount++;
      }

      // 4) 수익률 지수 갱신 (오늘 적립금이 들어오기 "전" 금액으로 계산)
      const before = total();
      index.push(index[i - 1] * (values[i - 1] > 0 ? before / values[i - 1] : 1));

      // 5) 매월 첫 거래일에 적립
      if (monthly > 0 && newMonth) buy(monthly, dates[i]);

      values.push(total());
      principal.push(invested);
    }

    // 목표 비중보다 많은 종목은 팔고(이익 확정) 적은 종목은 산다
    function rebalance() {
      const v = total();
      let turnover = 0;
      tickers.forEach(function (t) {
        const target = v * w[t];
        const diff = target - holdings[t];
        turnover += Math.abs(diff);
        if (diff < 0 && holdings[t] > 0) {          // 매도
          const frac = -diff / holdings[t];
          const soldBasis = basis[t] * frac;
          realizedYTD += -diff * (1 - tc) - soldBasis;
          basis[t] -= soldBasis;
        } else if (diff > 0) {                     // 매수
          basis[t] += diff;
        }
      });
      const fee = turnover * tc;
      paid.fee += fee;
      tickers.forEach(function (t) { holdings[t] = (v - fee) * w[t]; });
    }

    function total() {
      let s = 0;
      tickers.forEach(function (t) { s += holdings[t]; });
      return s;
    }

    // 마지막 날: 아직 안 낸 올해 양도세 + (선택) 전량 매도 시 양도세
    const endValue = values[values.length - 1];
    let unrealized = 0;
    tickers.forEach(function (t) { unrealized += holdings[t] - basis[t]; });
    let finalTax = 0;
    if (taxOn) {
      const gains = realizedYTD + (tax.liquidate ? unrealized : 0);
      finalTax = Math.max(0, gains - deduction) * capRate;
    }
    const finalValue = endValue - finalTax;
    flows.push({ date: dates[dates.length - 1], amount: finalValue });

    return {
      dates: dates,
      values: values,
      principal: principal,
      index: index,
      tickers: tickers,
      invested: invested,
      endValue: endValue,           // 세금 정산 전 계좌 금액
      finalValue: finalValue,       // 최종 양도세까지 뺀 금액
      unrealized: unrealized,
      paid: {
        fee: paid.fee,
        extraCost: paid.extraCost,
        dividendTax: paid.dividendTax,
        capitalTax: paid.capitalTax + finalTax
      },
      irr: xirr(flows),
      rebalanceCount: rebalanceCount
    };
  }

  /*
   * IRR(내부수익률): 돈을 넣은 시점과 금액을 모두 고려한 "내 돈 기준" 연수익률.
   * 적금 이자율처럼, 넣은 돈 각각이 매년 몇 %씩 불어났다고 봐야 최종 금액이 되는지 역산한다.
   * 이분법(bisection)으로 NPV(현재가치 합) = 0 이 되는 연이율을 찾는다.
   */
  function xirr(flows) {
    if (flows.length < 2) return null;
    const t0 = Date.parse(flows[0].date);
    function npv(r) {
      let s = 0;
      flows.forEach(function (f) {
        const yrs = (Date.parse(f.date) - t0) / (365 * 86400000);
        s += f.amount / Math.pow(1 + r, yrs);
      });
      return s;
    }
    let lo = -0.99, hi = 10;
    if (npv(lo) * npv(hi) > 0) return null;
    for (let k = 0; k < 200; k++) {
      const mid = (lo + hi) / 2;
      if (npv(lo) * npv(mid) <= 0) hi = mid; else lo = mid;
    }
    return (lo + hi) / 2;
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
   * 성과 지표 계산 (values에는 보통 수익률 지수 index를 넣는다)
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
   * 반환: [{ years, total, cagr, mdd }] — 기간이 데이터보다 길면 null
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
    xirr: xirr,
    drawdownSeries: drawdownSeries,
    computeStats: computeStats,
    annualReturns: annualReturns,
    trailingReturns: trailingReturns
  };

  // 브라우저에서는 window.Backtest 로, Node(테스트)에서는 require 로 사용
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Backtest = api;
})(this);
