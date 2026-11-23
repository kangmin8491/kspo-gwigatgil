"""출차_10분_게이트별.csv → public/data/exit_counts.json (자가용 출차 그래프용)

CSV 열: 출차일(YYYY-MM-DD), 10분구간(HH:M0), 출구게이트(동2문 등), 대수
CSV는 스크립트/수집.py가 만든다. 이 스크립트는 읽기만 한다.

사용 예:
  python3 scripts/make_exit_counts.py --date 2025-11-01 \
      --compare 2025-10-xx 2025-11-xx --from 16:00 --to 24:00
"""
import argparse
import csv
import json
import os
import statistics
from datetime import datetime, timedelta, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_CSV = os.path.join(HERE, "..", "..", "소스", "데이터", "출차_10분_게이트별.csv")
DEFAULT_OUT = os.path.join(HERE, "..", "public", "data", "exit_counts.json")


def bins(start, end):
    h, m = map(int, start.split(":"))
    eh, em = map(int, end.split(":"))
    t, stop = h * 60 + m, eh * 60 + em
    out = []
    while t < stop:
        out.append(f"{t // 60:02d}:{t % 60:02d}")
        t += 10
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--csv", default=DEFAULT_CSV)
    ap.add_argument("--out", default=DEFAULT_OUT)
    ap.add_argument("--date", default="2025-11-01")
    ap.add_argument("--label", default="2025-11-01 공연일 (KSPO DOME·올림픽홀)")
    ap.add_argument("--compare", nargs="*", default=[], help="비교일(공연 없는 날) 목록")
    ap.add_argument("--from", dest="start", default="16:00")
    ap.add_argument("--to", dest="end", default="24:00")
    ap.add_argument("--surge-ratio", type=float, default=2.0,
                    help="공연일 출차가 비교일 중앙값의 몇 배 이상인 첫 구간을 '급증 시작'으로 볼지")
    a = ap.parse_args()

    counts = {}  # (date, bin, gate) -> n
    with open(a.csv, encoding="utf-8-sig", newline="") as f:
        for row in csv.DictReader(f):
            k = (row["출차일"], row["10분구간"], row["출구게이트"])
            counts[k] = counts.get(k, 0) + int(row["대수"])

    b = bins(a.start, a.end)
    days = [a.date] + a.compare
    gates = sorted({g for (d, _, g) in counts if d in days and g})

    def series(d):
        return {g: [counts.get((d, t, g), 0) for t in b] for g in gates}

    event = series(a.date)
    comparison = None
    if a.compare:
        per_day = [series(d) for d in a.compare]
        comparison = {
            "dates": a.compare,
            "method": "median",
            "label": f"비교일 {len(a.compare)}일 중앙값",
            "counts": {g: [statistics.median(s[g][i] for s in per_day) for i in range(len(b))] for g in gates},
        }

    total = [sum(event[g][i] for g in gates) for i in range(len(b))]
    markers = {"peak": b[total.index(max(total))] if any(total) else None, "surge_start": None}
    if comparison:
        cmp_total = [sum(comparison["counts"][g][i] for g in gates) for i in range(len(b))]
        for i, (e, c) in enumerate(zip(total, cmp_total)):
            if c > 0 and e >= a.surge_ratio * c:
                markers["surge_start"] = b[i]
                break

    out = {
        "schema": "exit_counts/v1",
        "dataset": {"name": "올림픽공원 입출차정보(전체구역)", "provider": "한국체육산업개발", "id": "data.go.kr 15159093"},
        "generated_at": datetime.now(timezone(timedelta(hours=9))).isoformat(timespec="seconds"),
        "source_file": "출차_10분_게이트별.csv",
        "bin_minutes": 10,
        "bins": b,
        "gates": gates,
        "event_day": {"date": a.date, "label": a.label, "counts": event},
        "comparison": comparison,
        "markers": markers,
        "notes": [
            "가로축은 시계 시간입니다. 공연 실제 종료 시각은 확인되지 않았습니다.",
            "같은 시각 KSPO DOME·올림픽홀 공연이 함께 열려 한 공연만의 효과로 볼 수 없습니다.",
        ],
    }
    os.makedirs(os.path.dirname(a.out), exist_ok=True)
    with open(a.out, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=1)
    print(f"{a.out} 저장: 게이트 {gates}, 구간 {len(b)}개, 공연일 합계 {sum(total)}대")


if __name__ == "__main__":
    main()
