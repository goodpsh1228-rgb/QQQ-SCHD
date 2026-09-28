"""
QQQ, SCHD, SPY의 일별 수정종가(배당 재투자·분할 반영)를 Yahoo Finance에서 받아
data/prices.json 으로 저장하는 스크립트.

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
    # auto_adjust=True → Close 열이 배당·분할이 반영된 "수정종가"가 된다
    df = yf.Ticker(ticker).history(period="max", interval="1d", auto_adjust=True)
    df = df.dropna(subset=["Close"])
    if df.empty:
        raise RuntimeError(f"{ticker}: 데이터를 받지 못했습니다")
    return {
        "dates": [d.strftime("%Y-%m-%d") for d in df.index],
        "close": [round(float(c), 4) for c in df["Close"]],
    }


def main() -> None:
    result = {
        "updated": date.today().isoformat(),
        "source": "Yahoo Finance (auto-adjusted close, dividends reinvested)",
        "tickers": {},
    }
    for t in TICKERS:
        result["tickers"][t] = fetch(t)
        s = result["tickers"][t]
        print(f"{t}: {len(s['dates'])}일 ({s['dates'][0]} ~ {s['dates'][-1]})")

    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    # separators로 공백을 없애 파일 크기를 줄인다
    OUT_PATH.write_text(json.dumps(result, separators=(",", ":")), encoding="utf-8")
    print(f"저장 완료: {OUT_PATH}")


if __name__ == "__main__":
    main()
