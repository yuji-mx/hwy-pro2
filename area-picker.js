"use strict";

const element = id => document.getElementById(id);
const form = element("extract-form");
const dataset = element("dataset");
const submit = element("submit");
const mapScope = element("map-scope");
const mapHelp = element("map-help");
const result = element("result");
let map;
let firstCorner;
let box;
let marker;
let bbox;
let busy = false;

function update() {
  submit.disabled = busy || !dataset.value || (mapScope.checked && !bbox);
  if (!map) return;
  element("corners").disabled = !mapScope.checked || busy;
  element("viewport").disabled = !mapScope.checked || busy;
  mapHelp.textContent = !mapScope.checked ? "地図から範囲を絞る場合は「地図で指定」を選びます。"
    : bbox ? "青い枠が抽出範囲です。"
    : firstCorner ? "反対側の角をクリックします。"
    : "地図を拡大して四角形の最初の角をクリックします。";
}

function resetArea() {
  if (box) box.remove();
  if (marker) marker.remove();
  box = marker = firstCorner = bbox = null;
  update();
}

function choose(bounds) {
  const west = bounds.getWest();
  const south = bounds.getSouth();
  const east = bounds.getEast();
  const north = bounds.getNorth();
  if (!(west >= -180 && east <= 180 && west < east && south < north)) {
    result.textContent = "日付変更線をまたがない四角形を選んでください。";
    return;
  }
  resetArea();
  bbox = [west, south, east, north];
  box = L.rectangle(bounds, {color: "#166bb1", weight: 2, interactive: false}).addTo(map);
  result.textContent = "";
  update();
}

function focusDataset() {
  resetArea();
  result.textContent = "";
  if (!map) return;
  const views = {
    "shonan-example": [[35.335, 139.435], 12], japan: [[36.5, 138.7], 5],
    kanto: [[35.9, 139.5], 7], chubu: [[36, 137.5], 7],
    tohoku: [[39.3, 141], 7], kyushu: [[32.8, 130.6], 7],
    hokkaido: [[43.5, 142.4], 6], kansai: [[34.9, 135.5], 7],
    chugoku: [[34.7, 132.7], 7], shikoku: [[33.8, 133.4], 7],
    hawaii: [[20.75, -157], 7], alaska: [[61.2, -150], 5],
  };
  map.setView(...(views[dataset.value] ?? [[38.4, -97], 4]));
}

if (typeof L === "undefined") {
  mapHelp.textContent = "地図を読み込めませんでした。道路データ全域の抽出は利用できます。";
} else {
  map = L.map("map", {worldCopyJump: true}).setView([35.335, 139.435], 12);
  let tileFailure = false;
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    noWrap: true,
    attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a>',
  }).addTo(map).on("tileerror", () => {
    if (!tileFailure) result.textContent = "地図の画像を表示できません。道路データ全域の抽出は利用できます。";
    tileFailure = true;
  });
  mapScope.disabled = false;
  map.on("click", event => {
    if (!mapScope.checked || busy) return;
    if (firstCorner) {
      choose(L.latLngBounds(firstCorner, event.latlng));
    } else {
      resetArea();
      firstCorner = event.latlng;
      marker = L.circleMarker(firstCorner, {radius: 5, color: "#166bb1", interactive: false}).addTo(map);
      update();
    }
  });
  element("viewport").onclick = () => choose(map.getBounds());
  element("corners").onclick = resetArea;
}

async function loadDatasets() {
  try {
    const response = await fetch("/datasets");
    if (!response.ok) throw Error("道路データの一覧を取得できません。");
    const available = Object.entries(await response.json());
    for (const [key, label] of available) dataset.add(new Option(label, key));
    if (available.length === 1) {
      element("data-hint").textContent = "湘南サンプルを試せます。ほかの地域のPBFは pbf フォルダに保存し、ページを再読み込みします。";
    }
    focusDataset();
  } catch (error) {
    result.textContent = error.message;
  }
}
dataset.onchange = focusDataset;
form.querySelectorAll('input[name="scope"]').forEach(input => {
  input.onchange = () => {
    result.textContent = "";
    if (!mapScope.checked) resetArea();
    else update();
  };
});
form.onsubmit = async event => {
  event.preventDefault();
  if (submit.disabled) return;
  busy = true;
  dataset.disabled = true;
  update();
  result.textContent = "道路データを読み込み中です。処理が終わるまでお待ちください。";
  try {
    const response = await fetch("/extract", {
      method: "POST",
      headers: {"Content-Type": "application/json", "X-Lane-Survey": "local"},
      body: JSON.stringify({dataset: dataset.value, bbox: mapScope.checked ? bbox : null}),
    });
    const data = await response.json();
    if (!response.ok) throw Error(data.error);
    result.textContent = [`候補 ${data.count} 件`, data.path,
      data.count ? "台帳の「保存した台帳を開く」で、このJSONを選べます。"
        : "流入口を含む範囲と、PBFがその範囲をカバーするか確認してください。"].join("\n");
  } catch (error) {
    result.textContent = error.message;
  } finally {
    busy = false;
    dataset.disabled = false;
    update();
  }
};
loadDatasets();

