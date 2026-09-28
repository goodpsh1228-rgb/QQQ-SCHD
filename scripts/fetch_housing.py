"""
KB부동산 월간 주택가격동향의 매매가격지수를 받아 data/housing.json 으로 저장하는 스크립트.
(API 키 없이 공개된 KB부동산 데이터 API 사용)

저장하는 시계열:
  SEOUL_APT : 서울 아파트 매매가격지수
  SEOUL_ALL : 서울 주택종합 매매가격지수
  KOREA_APT : 전국 아파트 매매가격지수

실행 방법:
    pip install requests
    python scripts/fetch_housing.py
"""
import json
from datetime import date
from pathlib import Path

import requests

URL = "https://data-api.kbland.kr/bfmstat/weekMnthlyHuseTrnd/priceIndex"
HEADERS = {"User-Agent": "Mozilla/5.0 (compatible; portfolio-backtest/1.0)"}
OUT_PATH = Path(__file__).resolve().parent.parent / "data" / "housing.json"

# (저장 이름, 화면 표시 이름, 매물종별구분 코드, 찾을 지역명)
SERIES = [
    ("SEOUL_APT", "서울 아파트", "01", "서울"),
    ("SEOUL_ALL", "서울 주택종합", "98", "서울"),
    ("KOREA_APT", "전국 아파트", "01", "전국"),
]


def fetch_table(kind: str) -> dict:
    """매물종별(kind)의 월간 매매가격지수 전체 지역 표를 받아온다."""
    # 기간: 최근 몇 년치를 받을지 (기본값은 2년). 99 → 조사 시작(1986년)부터 전부
    params = {"월간주간구분코드": "01", "매물종별구분": kind, "매매전세코드": "01", "기간": "99"}
    res = requests.get(URL, params=params, headers=HEADERS, timeout=60)
    res.raise_for_status()
    body = res.json()["dataBody"]
    if str(body.get("resultCode")) != "11000":
        raise RuntimeError(f"KB API 오류: {body}")
    return body["data"]


def pick_region(table: dict, region: str) -> dict:
    """표에서 원하는 지역 한 줄을 찾아 {months, values}로 변환한다."""
    dates = table["날짜리스트"]  # 예: ["198601", "198602", ...]
    rows = table["데이터리스트"]
    names = [r["지역명"] for r in rows]
    matches = [r for r in rows if r["지역명"] == region] or \
              [r for r in rows if r["지역명"].startswith(region)]
    if not matches:
        raise RuntimeError(f"'{region}' 지역을 찾지 못했습니다. 지역 목록: {names[:40]}")
    values = matches[0]["dataList"][: len(dates)]

    months, out = [], []
    for d, v in zip(dates, values):
        if v in (None, "", "-"):
            continue
        months.append(f"{d[:4]}-{d[4:6]}")
        out.append(round(float(v), 4))
    return {"months": months, "values": out}


def main() -> None:
    result = {
        "updated": date.today().isoformat(),
        "source": "KB부동산 월간 주택가격동향 (매매가격지수)",
        "series": {},
    }
    tables = {}
    for key, name, kind, region in SERIES:
        if kind not in tables:
            tables[kind] = fetch_table(kind)
        s = pick_region(tables[kind], region)
        s["name"] = name
        result["series"][key] = s
        print(f"{name}: {len(s['months'])}개월 ({s['months'][0]} ~ {s['months'][-1]}), 최근 {s['values'][-1]}")

    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUT_PATH.write_text(json.dumps(result, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"저장 완료: {OUT_PATH}")


if __name__ == "__main__":
    main()
