"""OpenStreetMap 원자료 → public/data/basemap.json (화면 지도 밑그림)

지도 타일 서버를 쓰지 않고, 필요한 범위의 도형만 작게 뽑아 정적 파일로 둔다.
원자료 받기 (2026-11-24 조회):
  curl -H 'Accept: application/json' -o map.json \
    'https://api.openstreetmap.org/api/0.6/map.json?bbox=127.1080,37.5060,127.1450,37.5300'
사용: python3 scripts/make_basemap.py map.json
© OpenStreetMap 기여자, ODbL
"""
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "..", "public", "data", "basemap.json")
BASE = (127.10, 37.50)
KSPO_DOME_WAY = 75956855  # 올림픽체조경기장
# 작은 주거 건물까지 그리는 범위(그 밖은 생략해 용량을 줄인다)
CORE = (127.1125, 37.5110, 127.1380, 37.5245)

ROAD = {"primary": "a", "primary_link": "b", "secondary": "a", "secondary_link": "b", "tertiary": "b",
        "residential": "c", "unclassified": "c", "living_street": "c", "service": "d",
        "footway": "f", "path": "f", "cycleway": "f", "steps": "f", "pedestrian": "f"}


def main():
    el = json.load(open(sys.argv[1], encoding="utf-8"))["elements"]
    node = {e["id"]: (e["lon"], e["lat"]) for e in el if e["type"] == "node"}
    way = {e["id"]: [n for n in e["nodes"] if n in node] for e in el if e["type"] == "way"}

    def enc(ids):
        """경위도를 1e5 정수로 바꾸고 앞 점과의 차이만 남긴다."""
        out, px, py = [], 0, 0
        for n in ids:
            x, y = round((node[n][0] - BASE[0]) * 1e5), round((node[n][1] - BASE[1]) * 1e5)
            if out and x == px and y == py:
                continue
            out += [x - px, y - py]
            px, py = x, y
        return out

    def rings(rel):
        segs = [list(way[m["ref"]]) for m in rel["members"]
                if m["type"] == "way" and m.get("role") in ("outer", "") and way.get(m["ref"])]
        done = []
        while segs:
            r = segs.pop()
            joined = True
            while r[0] != r[-1] and joined:
                joined = False
                for i, s in enumerate(segs):
                    if s[0] == r[-1]: r += s[1:]
                    elif s[-1] == r[-1]: r += s[-2::-1]
                    elif s[-1] == r[0]: r = s[:-1] + r
                    elif s[0] == r[0]: r = s[:0:-1] + r
                    else: continue
                    segs.pop(i); joined = True
                    break
            if len(r) > 3: done.append(r)
        return done

    def kind(t):
        if t.get("natural") == "water": return "water"
        if t.get("building"): return "bldg"
        if t.get("leisure") in ("stadium", "track", "pitch", "golf_course"): return "pitch"
        if t.get("leisure") in ("park", "garden"): return "park"
        if t.get("landuse") in ("grass", "forest", "cemetery", "recreation_ground") or t.get("natural") in ("wood", "scrub", "grassland"): return "green"
        if t.get("place") == "square": return "square"
        return None

    out = {"park": [], "green": [], "pitch": [], "square": [], "water": [], "bldg": [], "venue": [], "stream": [], "road": []}

    def core(ids):
        x, y = node[ids[0]]
        return CORE[0] < x < CORE[2] and CORE[1] < y < CORE[3]

    for e in el:
        t = e.get("tags") or {}
        if e["type"] == "way":
            ids = way[e["id"]]
            if len(ids) < 2: continue
            if t.get("highway") in ROAD and t.get("area") != "yes":
                if ROAD[t["highway"]] in "df" and not core(ids): continue
                lanes = int(t["lanes"]) if str(t.get("lanes", "")).isdigit() else 0
                out["road"].append([ROAD[t["highway"]], lanes, enc(ids)])
                continue
            if t.get("waterway") in ("stream", "river"):
                out["stream"].append(enc(ids)); continue
            k = kind(t)
            if k and ids[0] == ids[-1] and len(ids) > 3:
                if e["id"] == KSPO_DOME_WAY: k = "venue"
                if k == "bldg" and not core(ids): continue
                out[k].append(enc(ids))
        elif e["type"] == "relation" and t.get("type") == "multipolygon":
            k = kind(t)
            for r in rings(e) if k else []:
                if k != "bldg" or core(r): out[k].append(enc(r))

    data = {"source": "© OpenStreetMap 기여자 (ODbL), api.openstreetmap.org 2026-11-24 조회", "base": BASE, "scale": 1e5, **out}
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, separators=(",", ":"))
    print({k: len(v) for k, v in out.items()}, os.path.getsize(OUT), "bytes")


main()
