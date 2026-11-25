# 加速車線調査 配布用プロジェクト

Windowsで道路データを選んで流入口候補を抽出し、航空写真で加速車線長を判読するための一式です。

## まず試す

1. このフォルダを展開し、PowerShellで開きます。Python 3.11以上を使います。
2. `python survey.py` を実行します。ブラウザーで「湘南サンプル」を選び、［候補JSONを作成］を押すと9件を抽出できます。サンプルの全域抽出は、PBFのダウンロードや追加のPythonパッケージなしで試せます。
3. ［測定台帳を開く］を押し、［保存した台帳を開く］から、画面に表示された `results` 内の `new-survey.json` を選びます。`examples/reviewed-example.json` を開くと、大分とオレゴンの判読結果4件も確認できます。

## 道路データを取得する

```powershell
python -m pip install osmium
python download_pbf.py all --list
python download_pbf.py all
```

`all` は日本全国と米国50州の計51ファイルです。日本だけなら `python download_pbf.py japan`、米国50州だけなら `python download_pbf.py us-states` を使います。少数の地域なら `python download_pbf.py kanto oregon` のように指定できます。ワシントンD.C.も対象にする場合は `python download_pbf.py district-of-columbia` を実行します。

データは `pbf` フォルダに保存します。全件取得には十数GBの空き容量と通信量を見込んでください。既に保存されているファイルは再取得を省略し、取得したファイルは配布元のMD5と照合します。失敗したファイルは同じコマンドで再取得できます。配布版の「latest」は更新されるので、再現に使ったPBFは取得日とともに残します。 [Geofabrik 日本](https://download.geofabrik.de/asia/japan.html) · [Geofabrik 米国・州別](https://download.geofabrik.de/north-america/us.html) · [OSMの出典とライセンス](https://www.openstreetmap.org/copyright)

## 流入口候補を抽出する

`python survey.py` を開いて道路データを選びます。日本全国や州全域なら［選んだ道路データの全域］を使います。IC周辺など一部なら［地図で指定］に切り替え、四角形の対角を2回クリックします。［地図の表示範囲を使う］でも指定できます。地図の背景を表示する際はインターネットを使い、候補抽出はローカルのPBFを読みます。保存した範囲は結果JSONと同じ場所の `.selection.json` に記録されます。日付変更線をまたぐ範囲は分けて指定するか、PBF全域で抽出します。

保存済みPBFをまとめて処理するコマンドです。日本全国のPBFがある場合は日本全国版を使い、日本の地方版との重複処理を省きます。米国は州ごとに1つの候補JSONを作ります。

```powershell
python survey.py --batch
```

従来のコマンドを使う場合は `--input` にローカルのファイルを指定します。全域なら `--bbox` は省略できます。`--region` と `--name` は台帳の表示ラベルです。一部の範囲で座標を再利用するときは、`--bbox` または範囲入りの `.selection.json` を `--area` で指定します。`--save-osm` を指定すると、範囲内の本線とランプを含む小さなOSM XMLを別PCへ渡せます。

```powershell
python accel-lane-lite/osm-candidates.py --input pbf/japan-latest.osm.pbf --country JP --region "日本全国" --name "高速道路流入口" --output japan-candidates.json
```

この抽出は、OSMの `motorway_link` の通行方向と、`motorway` 本線への直接接続を確認します。全国PBFには生活道路も含まれますが、候補計算に必要なランプ、本線との接続点、その近傍の点だけを保持します。入力PBFを読む時間と、全国の写真判読にかかる時間は別途必要です。区分・通行方向のタグ欠損、IC無名、州境で接続が分かれる事例は道路管理者のIC一覧などと照合します。州別結果をまとめる場合、同じ候補IDを重複計上しないようにします。

## 加速車線長を測る

生成した候補JSONを指定し、[Codexへの指示文](measure-instructions.md) をチャットに貼ります。日本は国土地理院の公開航空写真、米国本土48州はUSDA NAIP／USGSを利用します。背景地図は候補範囲の指定に使います。判読には座標と対応付けられる航空写真を使い、画像で端点を確認できる範囲で距離を記録します。アラスカ・ハワイは同じNAIPサービスによる判読を前提にせず、適切な公開画像が確認できなければ保留にします。

手作業では、候補KMLをQGISで開き、航空写真を表示します。始点から終点へ車線に沿って線を作り、1本の線をWGS 84のKMLとして保存します。台帳で該当候補の測定線を読み込むと水平距離を計算します。結果は台帳JSON、結果CSV、KMLで保存できます。 [QGIS](https://qgis.org/download/) · [地理院タイルの利用条件](https://maps.gsi.go.jp/help/use.html) · [USGS NAIP](https://imagery.nationalmap.gov/arcgis/rest/services/USGSNAIPImagery/ImageServer)

配布には、このフォルダと同梱サンプルを使えます。作業結果を引き継ぐ場合はJSON、KML、撮影日や画像の出典も渡します。PBFや画像は各PCで必要な地域だけ用意できます。候補抽出・台帳・QGISに有料APIは不要です。Codexを使う場合は利用プランが適用されます。

