import argparse
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import subprocess
import sys
from tempfile import mkdtemp
from threading import Lock
import webbrowser
from download_pbf import US

ROOT = Path(__file__).resolve().parent
SAMPLE = "shonan-example"
JAPAN = {
    "japan": "日本全国", "hokkaido": "北海道", "tohoku": "東北", "kanto": "関東",
    "chubu": "中部", "kansai": "近畿", "chugoku": "中国", "shikoku": "四国", "kyushu": "九州",
}
SUFFIX = "-latest.osm.pbf"
EXPORTS = ROOT / "results"
EXTRACTOR = ROOT / "accel-lane-lite" / "osm-candidates.py"


def datasets():
    result = {SAMPLE: {"label": "湘南サンプル", "country": "JP", "path": ROOT / "examples" / "shonan.osm"}}
    for file in sorted((ROOT / "pbf").glob("*" + SUFFIX)):
        key = file.name.removesuffix(SUFFIX)
        if key not in JAPAN and key not in US:
            continue
        label = JAPAN.get(key, key.replace("-", " ").title())
        country = "JP" if key in JAPAN else "US"
        result[key] = {"label": label, "country": country, "path": file}
    return result


def extract(item, output, area=None):
    command = [
        sys.executable, "-X", "utf8", str(EXTRACTOR), "--input", str(item["path"]),
        "--country", item["country"], "--region", item["label"], "--name", item["label"],
        "--output", str(output),
    ]
    if area is not None:
        command.extend(["--bbox", *(str(value) for value in area)])
    result = subprocess.run(command, cwd=ROOT, capture_output=True, text=True, encoding="utf-8")
    if result.returncode == 0:
        selection = {
            "input": item["path"].relative_to(ROOT).as_posix(),
            "input_bytes": item["path"].stat().st_size,
            "bbox": area,
        }
        output.with_suffix(".selection.json").write_text(
            json.dumps(selection, ensure_ascii=False, indent=2) + "\n", encoding="utf-8",
        )
    return result


def output_folder(prefix):
    EXPORTS.mkdir(exist_ok=True)
    return Path(mkdtemp(prefix=prefix + datetime.now().strftime("%Y%m%d-%H%M%S-"), dir=EXPORTS))


class SurveyServer(ThreadingHTTPServer):
    extraction_lock = Lock()


class Handler(BaseHTTPRequestHandler):
    def send_data(self, body, media, status=200):
        self.send_response(status)
        self.send_header("Content-Type", media)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def json(self, data, status=200):
        self.send_data(json.dumps(data, ensure_ascii=False).encode("utf-8"), "application/json", status)

    def local_host(self):
        return self.headers.get("Host") == f"127.0.0.1:{self.server.server_port}"

    def do_GET(self):
        if not self.local_host():
            self.send_error(403)
            return
        if self.path == "/datasets":
            self.json({key: item["label"] for key, item in datasets().items()})
            return
        files = {
            "/": ("area-picker.html", "text/html"),
            "/area-picker.js": ("area-picker.js", "text/javascript"),
            "/area-picker.css": ("area-picker.css", "text/css"),
            "/vendor/leaflet/leaflet.js": ("vendor/leaflet/leaflet.js", "text/javascript"),
            "/vendor/leaflet/leaflet.css": ("vendor/leaflet/leaflet.css", "text/css"),
            "/accel-lane-lite/index.html": ("accel-lane-lite/index.html", "text/html"),
            "/accel-lane-lite/app.js": ("accel-lane-lite/app.js", "text/javascript"),
            "/accel-lane-lite/starter.js": ("accel-lane-lite/starter.js", "text/javascript"),
            "/accel-lane-lite/style.css": ("accel-lane-lite/style.css", "text/css"),
        }
        if self.path not in files:
            self.send_error(404)
            return
        file, mime = files[self.path]
        self.send_data((ROOT / file).read_bytes(), mime + "; charset=utf-8")

    def do_POST(self):
        if not self.local_host() or self.headers.get("X-Lane-Survey") != "local":
            self.send_error(403)
            return
        if self.path != "/extract":
            self.send_error(404)
            return
        try:
            count = int(self.headers.get("Content-Length", "0"))
            if not 0 < count <= 4096:
                raise ValueError("要求のサイズが不正です。")
            request = json.loads(self.rfile.read(count))
            if not isinstance(request, dict):
                raise ValueError("要求の形式が不正です。")
            item = datasets()[request["dataset"]]
            area = request.get("bbox")
            if area is not None:
                west, south, east, north = area
                if not (-180 <= west < east <= 180 and -90 <= south < north <= 90):
                    raise ValueError("日付変更線をまたがない範囲を選んでください。全域なら範囲指定を解除します。")
        except (ValueError, KeyError, TypeError) as error:
            self.json({"error": str(error)}, 400)
            return

        if not self.server.extraction_lock.acquire(blocking=False):
            self.json({"error": "別の抽出が進行中です。完了後に実行してください。"}, 409)
            return
        try:
            output = output_folder("survey-") / "new-survey.json"
            result = extract(item, output, area)
            if result.returncode:
                self.json({"error": result.stderr.strip()}, 500)
                return
            count = len(json.loads(output.read_text(encoding="utf-8"))["sites"])
            self.json({"path": str(output), "count": count, "log": result.stdout.strip()})
        except OSError as error:
            self.json({"error": str(error)}, 500)
        finally:
            self.server.extraction_lock.release()


def main():
    parser = argparse.ArgumentParser(description="地図で候補範囲を選択、または保存済みPBFを一括処理")
    parser.add_argument("--batch", action="store_true", help="保存済みPBFを全域で順に処理する")
    parser.add_argument("--no-browser", action="store_true", help="ブラウザーを自動で開かない")
    parser.add_argument("--port", type=int, default=8765, help="ローカル画面のポート")
    args = parser.parse_args()
    if args.batch:
        items = datasets()
        items.pop(SAMPLE)
        if "japan" in items:
            items = {key: item for key, item in items.items() if key == "japan" or key not in JAPAN}
        if not items:
            parser.exit(1, "pbf フォルダにPBFを置いてください。\n")
        output = output_folder("batch-")
        failed = []
        for key, item in items.items():
            print(f"抽出中: {item['label']}", flush=True)
            result = extract(item, output / f"{key}-candidates.json")
            if result.returncode:
                print(result.stderr, file=sys.stderr)
                failed.append(key)
            else:
                print(result.stdout, end="", flush=True)
        print(f"保存先: {output}")
        if failed:
            print("抽出失敗: " + " ".join(failed), file=sys.stderr)
        return int(bool(failed))
    try:
        server = SurveyServer(("127.0.0.1", args.port), Handler)
    except OSError as error:
        parser.exit(1, f"ローカル画面を開始できません。既に起動中ならその画面を使ってください。{error}\n")
    with server:
        url = f"http://127.0.0.1:{server.server_port}/"
        print(url, flush=True)
        if not args.no_browser:
            webbrowser.open(url)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass
    return 0


if __name__ == "__main__":
    sys.exit(main())

