import argparse
import hashlib
from pathlib import Path
import re
import shutil
import sys
from tempfile import NamedTemporaryFile
from urllib.request import urlopen

ROOT = Path(__file__).resolve().parent
BASE = "https://download.geofabrik.de"
STATES = """
alabama alaska arizona arkansas california colorado connecticut delaware florida georgia
hawaii idaho illinois indiana iowa kansas kentucky louisiana maine maryland massachusetts
michigan minnesota mississippi missouri montana nebraska nevada new-hampshire new-jersey
new-mexico new-york north-carolina north-dakota ohio oklahoma oregon pennsylvania rhode-island
south-carolina south-dakota tennessee texas utah vermont virginia washington west-virginia
wisconsin wyoming
""".split()
US = {state: f"{BASE}/north-america/us/{state}/{state}-latest.osm.pbf"
      for state in [*STATES, "district-of-columbia"]}
JAPAN = {"japan": f"{BASE}/asia/japan/japan-latest.osm.pbf",
         **{part: f"{BASE}/asia/japan/{part}/{part}-latest.osm.pbf"
            for part in ("hokkaido", "tohoku", "kanto", "chubu", "kansai", "chugoku", "shikoku", "kyushu")}}
CATALOG = {**JAPAN, **US}


def download(url, output):
    if output.is_file() and output.stat().st_size:
        print(f"保存済み: {output.name}", flush=True)
        return
    temporary = None
    try:
        with urlopen(url + ".md5", timeout=30) as response:
            checksum = response.read(1024).decode("ascii").split()[0]
        if not re.fullmatch("[0-9a-fA-F]{32}", checksum):
            raise ValueError("配布元のMD5を読み取れません")
        print(f"取得中: {output.name}", flush=True)
        with urlopen(url, timeout=60) as response, NamedTemporaryFile(
            dir=output.parent, prefix=output.name + "-", suffix=".part", delete=False,
        ) as stream:
            temporary = Path(stream.name)
            shutil.copyfileobj(response, stream, 1024 * 1024)
        with temporary.open("rb") as stream:
            actual = hashlib.file_digest(stream, "md5").hexdigest()
        if actual.lower() != checksum.lower():
            raise ValueError("MD5不一致。配布元の更新や転送中断を確認し、再実行してください")
        temporary.replace(output)
        print(f"取得済み: {output.name}", flush=True)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def main():
    parser = argparse.ArgumentParser(description="GeofabrikのOSM PBFをpbfフォルダに保存")
    parser.add_argument("regions", nargs="+", choices=["all", "us-states", *CATALOG])
    parser.add_argument("--list", action="store_true", help="取得先URLを表示する")
    args = parser.parse_args()
    groups = {"all": ["japan", *STATES], "us-states": STATES}
    regions = dict.fromkeys(item for group in args.regions for item in groups.get(group, [group]))
    if args.list:
        for name in regions:
            print(CATALOG[name])
        return 0

    folder = ROOT / "pbf"
    folder.mkdir(exist_ok=True)
    failed = []
    for name in regions:
        try:
            download(CATALOG[name], folder / f"{name}-latest.osm.pbf")
        except (OSError, ValueError, IndexError) as error:
            print(f"{name}: {error}", file=sys.stderr)
            failed.append(name)
    if failed:
        print("未取得: " + " ".join(failed), file=sys.stderr)
    return int(bool(failed))


if __name__ == "__main__":
    sys.exit(main())

