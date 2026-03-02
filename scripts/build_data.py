"""
Preprocess parquet player data into JSON for the frontend.
Run from project root: python scripts/build_data.py
"""
import json
import re
import shutil
from pathlib import Path

import pandas as pd
import pyarrow.parquet as pq

# Paths relative to project root (parent of scripts/)
PROJECT_ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = PROJECT_ROOT / "player_data"
OUT_DIR = PROJECT_ROOT / "public"
MINIMAP_SIZE = 1024

# Map config from README: scale, origin_x, origin_z
MAP_CONFIG = {
    "AmbroseValley": {"scale": 900, "origin_x": -370, "origin_z": -473},
    "GrandRift": {"scale": 581, "origin_x": -290, "origin_z": -290},
    "Lockdown": {"scale": 1000, "origin_x": -500, "origin_z": -500},
}

DATE_FOLDERS = ["February_10", "February_11", "February_12", "February_13", "February_14"]
EVENT_TYPES_FOR_MARKERS = {"Kill", "Killed", "BotKill", "BotKilled", "KilledByStorm", "Loot"}
POSITION_EVENTS = {"Position", "BotPosition"}

# UUID pattern: contains hyphens and is not all digits
UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.I)


def is_human(user_id: str) -> bool:
    return bool(UUID_RE.match(str(user_id).strip()))


def world_to_pixel(x: float, z: float, map_id: str) -> tuple[int, int]:
    cfg = MAP_CONFIG[map_id]
    u = (x - cfg["origin_x"]) / cfg["scale"]
    v = (z - cfg["origin_z"]) / cfg["scale"]
    px = int(round(u * MINIMAP_SIZE))
    py = int(round((1 - v) * MINIMAP_SIZE))
    # Clamp to image bounds
    px = max(0, min(MINIMAP_SIZE - 1, px))
    py = max(0, min(MINIMAP_SIZE - 1, py))
    return px, py


def decode_event(ev) -> str:
    if isinstance(ev, bytes):
        return ev.decode("utf-8")
    return str(ev)


def load_parquet(filepath: Path) -> pd.DataFrame | None:
    try:
        table = pq.read_table(filepath)
        df = table.to_pandas()
    except Exception:
        return None
    if "event" in df.columns:
        df["event"] = df["event"].apply(decode_event)
    df["is_human"] = df["user_id"].apply(is_human)
    return df


def add_pixel_coords(df: pd.DataFrame, map_id: str) -> pd.DataFrame:
    cfg = MAP_CONFIG[map_id]
    u = (df["x"] - cfg["origin_x"]) / cfg["scale"]
    v = (df["z"] - cfg["origin_z"]) / cfg["scale"]
    df = df.copy()
    df["px"] = (u * MINIMAP_SIZE).round().astype(int).clip(0, MINIMAP_SIZE - 1)
    df["py"] = ((1 - v) * MINIMAP_SIZE).round().astype(int).clip(0, MINIMAP_SIZE - 1)
    return df


def normalize_match_id(match_id: str) -> str:
    """Use a filesystem-safe match id (strip .nakama-0 and replace colons etc.)."""
    s = str(match_id).strip()
    if s.endswith(".nakama-0"):
        s = s[:-len(".nakama-0")]
    return s.replace(":", "_").replace("/", "_")


def collect_match_data(data_dir: Path) -> tuple[list, dict]:
    """Scan parquet files, group by match_id, return meta list and match_id -> payload."""
    matches_meta = []
    matches_data = {}

    for date in DATE_FOLDERS:
        folder = data_dir / date
        if not folder.is_dir():
            continue
        for f in folder.iterdir():
            if f.is_dir() or f.suffix not in (".0", "") and ".nakama-0" not in f.name:
                # nakama-0 files have no extension or end with .0
                if not f.name.endswith(".nakama-0") and ".nakama-0" not in f.name:
                    continue
            try:
                df = load_parquet(f)
            except Exception:
                continue
            if df is None or df.empty:
                continue
            map_id = df["map_id"].iloc[0]
            if map_id not in MAP_CONFIG:
                continue
            match_id_raw = df["match_id"].iloc[0]
            match_id = normalize_match_id(match_id_raw)
            df = add_pixel_coords(df, map_id)

            if match_id not in matches_data:
                matches_data[match_id] = {
                    "mapId": map_id,
                    "date": date,
                    "events": [],
                    "paths": {},
                }
                matches_meta.append({"matchId": match_id, "mapId": map_id, "date": date, "numPlayers": 0})

            rec = matches_data[match_id]

            # Position events -> paths
            pos = df[df["event"].isin(POSITION_EVENTS)].copy()
            pos = pos.sort_values("ts")
            for uid, grp in pos.groupby("user_id"):
                uid = str(uid)
                for _, r in grp.iterrows():
                    t = r["ts"]
                    try:
                        ts_ms = int(pd.Timestamp(t).value // 10**6)
                    except (TypeError, ValueError):
                        ts_ms = int(t) if pd.notna(t) else 0
                    rec["paths"].setdefault(uid, []).append({
                        "px": int(r["px"]),
                        "py": int(r["py"]),
                        "ts": ts_ms,
                    })

            # Non-position events -> events list
            ev = df[df["event"].isin(EVENT_TYPES_FOR_MARKERS)]
            for _, row in ev.iterrows():
                t = row["ts"]
                try:
                    ts_ms = int(pd.Timestamp(t).value // 10**6)
                except (TypeError, ValueError):
                    ts_ms = int(t) if pd.notna(t) else 0
                rec["events"].append({
                    "px": int(row["px"]),
                    "py": int(row["py"]),
                    "ts": ts_ms,
                    "event": row["event"],
                    "isHuman": bool(row["is_human"]),
                    "userId": str(row["user_id"]),
                })

    # Sort path points by ts per user and fix numPlayers
    for match_id, rec in matches_data.items():
        for uid in rec["paths"]:
            rec["paths"][uid] = sorted(rec["paths"][uid], key=lambda p: p["ts"])
        rec["events"].sort(key=lambda e: e["ts"])
        # numPlayers is already incremented per user; ensure it's set
        for m in matches_meta:
            if m["matchId"] == match_id:
                m["numPlayers"] = len(rec["paths"])
                break

    return matches_meta, matches_data


def build_heatmaps(data_dir: Path) -> dict:
    """Build per-map heatmap grids: kills, deaths, traffic. Returns dict of mapId -> { kills, deaths, traffic }."""
    grid_size = 64
    cell = MINIMAP_SIZE / grid_size
    heatmaps = {map_id: {"kills": [[0.0] * grid_size for _ in range(grid_size)],
                       "deaths": [[0.0] * grid_size for _ in range(grid_size)],
                       "traffic": [[0.0] * grid_size for _ in range(grid_size)]}
                for map_id in MAP_CONFIG}

    def cell_index(px: int, py: int) -> tuple[int, int]:
        i = int(px / cell)
        j = int(py / cell)
        i = max(0, min(grid_size - 1, i))
        j = max(0, min(grid_size - 1, j))
        return i, j

    for date in DATE_FOLDERS:
        folder = data_dir / date
        if not folder.is_dir():
            continue
        for f in folder.iterdir():
            if not f.name.endswith(".nakama-0") and ".nakama-0" not in f.name:
                continue
            try:
                df = load_parquet(f)
            except Exception:
                continue
            if df is None or df.empty:
                continue
            map_id = df["map_id"].iloc[0]
            if map_id not in MAP_CONFIG:
                continue
            df = add_pixel_coords(df, map_id)
            grid_k = heatmaps[map_id]["kills"]
            grid_d = heatmaps[map_id]["deaths"]
            grid_t = heatmaps[map_id]["traffic"]

            for _, row in df.iterrows():
                px, py = int(row["px"]), int(row["py"])
                i, j = cell_index(px, py)
                ev = row["event"]
                if ev in ("Kill", "BotKill"):
                    grid_k[j][i] += 1.0
                if ev in ("Killed", "BotKilled", "KilledByStorm"):
                    grid_d[j][i] += 1.0
                if ev in POSITION_EVENTS:
                    grid_t[j][i] += 1.0

    return heatmaps


def export_heatmap_json(heatmaps: dict, out_dir: Path) -> None:
    """Write heatmaps as JSON: heatmaps/<mapId>_<type>.json with 2D grid."""
    hm_dir = out_dir / "heatmaps"
    hm_dir.mkdir(parents=True, exist_ok=True)
    for map_id, grids in heatmaps.items():
        for kind in ("kills", "deaths", "traffic"):
            path = hm_dir / f"{map_id}_{kind}.json"
            with open(path, "w") as fp:
                json.dump(grids[kind], fp)


def main() -> None:
    data_dir = DATA_DIR
    if not data_dir.is_dir():
        raise SystemExit(f"Data directory not found: {data_dir}")

    out_dir = OUT_DIR
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "matches").mkdir(parents=True, exist_ok=True)

    print("Collecting match data...")
    matches_meta, matches_data = collect_match_data(data_dir)

    meta = {
        "dates": DATE_FOLDERS,
        "maps": list(MAP_CONFIG.keys()),
        "matches": matches_meta,
    }
    with open(out_dir / "meta.json", "w") as f:
        json.dump(meta, f, indent=2)
    print(f"Wrote meta.json ({len(matches_meta)} matches)")

    for match_id, rec in matches_data.items():
        # Convert paths keys to strings for JSON
        rec["paths"] = {str(k): v for k, v in rec["paths"].items()}
        path = out_dir / "matches" / f"{match_id}.json"
        with open(path, "w") as f:
            json.dump(rec, f)
    print(f"Wrote {len(matches_data)} match JSON files")

    print("Building heatmaps...")
    heatmaps = build_heatmaps(data_dir)
    export_heatmap_json(heatmaps, out_dir)
    print("Wrote heatmap JSON files")

    minimap_src = data_dir / "minimaps"
    minimap_dst = out_dir / "minimaps"
    if minimap_src.is_dir():
        minimap_dst.mkdir(parents=True, exist_ok=True)
        for f in minimap_src.iterdir():
            if f.is_file():
                shutil.copy2(f, minimap_dst / f.name)
        print(f"Copied minimaps to {minimap_dst}")
    else:
        print(f"Minimaps folder not found: {minimap_src}")

    print("Done.")


if __name__ == "__main__":
    main()
