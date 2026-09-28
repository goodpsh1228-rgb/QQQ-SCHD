"""
QQQ, SCHD, SPY의 일별 가격과 배당 데이터를 Yahoo Finance에서 받아
data/prices.json 으로 저장하는 스크립트.

저장 내용 (티커별):
  - close: 배당을 재투자했을 때의 "총수익 지수" (수정종가와 같은 의미)
  - divs:  배당락일과 그날의 배당수익률 [["2024-03-20", 0.0085], ...]
           (배당금 ÷ 전날 종가. 배당소득세 계산에 사용)

실행 방법:
    pip install yfinance
    python scripts/fetch_data.py

GitHub Actions(.github/workflows/update-data.yml)가 매주 자동으로 실행한다.
"""
import json
from datetime import date
from pathlib import Path

import yfinance as yf

TICKERS = ["QQQ", "SCHD", "SPY"]
OUT_PATH = Path(__file__).resolve().parent.parent / "data" / "prices.json"


def fetch(ticker: str) -> dict:
    # auto_adjust=False → Close는 분할만 반영된 실제 종가, Dividends는 주당 배당금
    df = yf.Ticker(ticker).history(period="max", interval="1d", auto_adjust=False)
    df = df.dropna(subset=["Close"])
    if df.empty:
        raise RuntimeError(f"{ticker}: 데이터를 받지 못했습니다")

    close = df["Close"].astype(float).tolist()
    divs = df["Dividends"].astype(float).tolist() if "Dividends" in df else [0.0] * len(close)
    dates = [d.strftime("%Y-%m-%d") for d in df.index]

    # 총수익 지수: 오늘 지수 = 어제 지수 × (오늘 종가 + 오늘 배당금) ÷ 어제 종가
    tr = [100.0]
    div_list = []
    for i in range(1, len(close)):
        tr.append(tr[-1] * (close[i] + divs[i]) / close[i - 1])
        if divs[i] > 0:
            div_list.append([dates[i], round(divs[i] / close[i - 1], 6)])

    return {
        "dates": dates,
        "close": [round(v, 4) for v in tr],
        "divs": div_list,
    }


def main() -> None:
    result = {
        "updated": date.today().isoformat(),
        "source": "Yahoo Finance (dividends reinvested)",
        "tickers": {},
    }
    for t in TICKERS:
        result["tickers"][t] = fetch(t)
        s = result["tickers"][t]
        print(f"{t}: {len(s['dates'])}일 ({s['dates'][0]} ~ {s['dates'][-1]}), 배당 {len(s['divs'])}회")

    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    # separators로 공백을 없애 파일 크기를 줄인다
    OUT_PATH.write_text(json.dumps(result, separators=(",", ":")), encoding="utf-8")
    print(f"저장 완료: {OUT_PATH}")


if __name__ == "__main__":
    main()
