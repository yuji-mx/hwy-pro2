"use strict";

const $ = id => document.getElementById(id);
const form = $("review");
const labels = {
  unreviewed: "未確認", measured: "測定済み", estimated: "概測", pending: "判定保留",
  lower_bound: "下限のみ", image_reference: "画像で計測値を確認",
  to_exit: "対象外・出口へ続く", continuation: "対象外・本線として続く", other: "対象外・その他",
};
const fields = ["id", "country", "region", "name", "route", "direction", "lat", "lon", "source"];
const reviewFields = [
  "status", "source", "imageryDate", "reviewer", "note", "low", "high", "rise", "gradeSource",
  "mainSpeed", "mainUnit", "mainSource", "rampSpeed", "rampUnit", "rampSource",
];
const storageKey = "accel-lane-lite-v1";
let sites = starter;
let includeBundledSites = true;
let selected;
let path;
let dirty = false;

const measured = status => status === "measured" || status === "estimated";
const hasPath = status => measured(status) || status === "lower_bound";
const lowerBound = review => review?.status === "lower_bound" ? Math.floor(length(review.path)) : null;
const numeric = value => value == null || String(value).trim() === "" ? null : Number(value);
const rounded = value => value == null ? "" : Number(value.toFixed(1));
const validPoint = point => Array.isArray(point) && point.length === 2 &&
  point.every(Number.isFinite) && Math.abs(point[0]) <= 180 && Math.abs(point[1]) <= 90;
const validPath = points => Array.isArray(points) && points.length >= 2 && points.every(validPoint);
const regionKey = s => s.country + " · " + s.region;
const statusOf = s => s.review?.status ?? "unreviewed";

function distance(a, b) {
  const rad = Math.PI / 180;
  const p = a[1] * rad;
  const q = b[1] * rad;
  const h = Math.sin((q - p) / 2) ** 2 +
    Math.cos(p) * Math.cos(q) * Math.sin((b[0] - a[0]) * rad / 2) ** 2;
  return 2 * 6371008.8 * Math.asin(Math.sqrt(Math.min(1, h)));
}

function length(points) {
  return points.slice(1).reduce((sum, b, i) => sum + distance(points[i], b), 0);
}

function checkPath(points) {
  if (!validPath(points) || length(points) <= 0) throw Error("有効な測定線が必要です。");
}

function checkReview(review) {
  if (!Object.hasOwn(labels, review.status)) throw Error("不明な判定です。");
  if (review.status !== "unreviewed" && !review.source) throw Error("判定に使った出典を入力してください。");
  if (["estimated", "pending", "lower_bound", "image_reference", "to_exit", "continuation", "other"].includes(review.status) && !review.note) {
    throw Error("判定の根拠を入力してください。");
  }
  if (hasPath(review.status)) {
    checkPath(review.path);
    const m = length(review.path);
    if (review.status === "estimated" &&
      !(Number.isFinite(review.low) && Number.isFinite(review.high) && review.low > 0 &&
        review.low <= m && m <= review.high && review.low < review.high)) {
      throw Error("概測の下限と上限には、測定線の距離を含む範囲を入力してください。");
    }
    if (review.rise !== null && (!Number.isFinite(review.rise) || !review.gradeSource)) {
      throw Error("標高差の出典を入力してください。");
    }
  }
  for (const side of ["main", "ramp"]) {
    const speed = review[side + "Speed"];
    if (speed !== null && (!Number.isFinite(speed) || speed <= 0 ||
        !["km/h", "mph"].includes(review[side + "Unit"]) || !review[side + "Source"])) {
      throw Error("制限速度は正の数で入力し、単位と出典を記録してください。");
    }
  }
}

function candidate(row) {
  const site = Object.fromEntries(fields.map(key => [key, String(row[key] ?? "").trim()]));
  site.lat = numeric(site.lat);
  site.lon = numeric(site.lon);
  if (!site.id || !["JP", "US"].includes(site.country) || !site.region || !site.name || !site.source ||
      !validPoint([site.lon, site.lat])) {
    throw Error("候補の ID・国（JP/US）・地域・施設名・緯度経度・出典を確認してください。");
  }
  return site;
}

function loadBackup(raw) {
  const data = JSON.parse(raw);
  if (data.version !== 1 || !Array.isArray(data.sites)) throw Error("形式が異なる台帳です。");
  const ids = new Set();
  return data.sites.map(row => {
    const site = candidate(row);
    if (ids.has(site.id)) throw Error("台帳内で ID が重複しています。");
    ids.add(site.id);
    const bundled = starter.find(item => item.id === site.id);
    const recheck = bundled?.recheck ?? row.recheck;
    const outdated = recheck && row.review && !row.review.recordedAt &&
      ((row.review.source === recheck.previous?.source &&
        recheck.previous && JSON.stringify(row.review.path) === JSON.stringify(recheck.previous.path)) ||
        (row.review.status === "pending" && row.review.source === recheck.previousPendingSource));
    const review = outdated ? bundled?.review : row.review;
    if (review) checkReview(review);
    return { ...site, review, reference: row.reference, recheck };
  });
}

function payload() {
  return JSON.stringify({ version: 1, sites }, null, 2);
}

function save() {
  try {
    localStorage.setItem(storageKey, JSON.stringify({ version: 1, sites, includeBundledSites }));
    $("notice").textContent = "このブラウザーに一時保存しました。共有・バックアップは台帳 JSON を保存してください。";
  } catch {
    $("notice").textContent = "このブラウザーでは一時保存できません。閉じる前に台帳 JSON を保存してください。";
  }
}

function metrics(site) {
  const r = site.review;
  const m = r && measured(r.status) ? length(r.path) : null;
  const grade = m !== null && r.rise !== null ? 100 * r.rise / m : null;
  const kmh = side => r?.[side + "Speed"] == null ? null :
    r[side + "Speed"] * (r[side + "Unit"] === "mph" ? 1.609344 : 1);
  return { m, grade, main: kmh("main"), ramp: kmh("ramp") };
}

function refreshRegions() {
  const select = $("region");
  const current = select.value;
  const regions = [...new Set(sites.map(regionKey))].sort();
  select.replaceChildren(new Option("すべて", ""), ...regions.map(r => new Option(r, r)));
  if (regions.includes(current)) select.value = current;
}

function visibleSites() {
  const region = $("region").value;
  const filter = $("status-filter").value;
  const term = $("search").value.trim().toLowerCase();
  return sites.filter(s => (!region || regionKey(s) === region) &&
    (!filter || (filter === "unreviewed") === (statusOf(s) === "unreviewed")) &&
    [s.id, s.name, s.route, s.direction, s.region].join(" ").toLowerCase().includes(term));
}

function render() {
  const shown = visibleSites();
  $("rows").replaceChildren(...shown.map(site => {
    const row = document.createElement("tr");
    if (site === selected) row.setAttribute("aria-current", "true");
    const link = document.createElement("button");
    link.textContent = [site.name, site.route, site.direction].filter(Boolean).join(" / ");
    link.onclick = () => {
      if (site !== selected && allowDiscard()) openSite(site, true);
    };
    const { m, grade, main, ramp } = metrics(site);
    const minimum = lowerBound(site.review);
    const distanceLabel = minimum !== null ? `${minimum}以上` :
      m === null ? (site.recheck?.referenceM == null ? "—" : `${site.recheck.referenceM}（画像参考）`) : statusOf(site) === "estimated"
      ? `${rounded(m)}［${site.review.low}–${site.review.high}］` : rounded(m);
    for (const value of [regionKey(site), link, labels[statusOf(site)], distanceLabel,
      grade === null ? "—" : rounded(grade), `${main === null ? "—" : rounded(main)} / ${ramp === null ? "—" : rounded(ramp)}`]) {
      const cell = row.insertCell();
      if (value instanceof Node) cell.append(value);
      else cell.textContent = value;
    }
    return row;
  }));
  for (const id of ["candidate-kml", "csv"]) $(id).disabled = !shown.length;
  const groups = new Map();
  for (const site of shown) {
    const key = regionKey(site);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(site);
  }
  const lines = [...groups].map(([key, rows]) => {
    const counts = s => rows.filter(r => statusOf(r) === s).length;
    const lengths = rows.filter(r => statusOf(r) === "measured").map(r => metrics(r).m).sort((a, b) => a - b);
    const quantile = q => {
      const i = (lengths.length - 1) * q;
      const a = Math.floor(i);
      return rounded(lengths[a] + (lengths[Math.ceil(i)] - lengths[a]) * (i - a));
    };
    const excluded = ["to_exit", "continuation", "other"].reduce((sum, s) => sum + counts(s), 0);
    const stats = lengths.length
      ? ` ／ 確認済み距離 最短 ${quantile(0)}・中央値 ${quantile(.5)}・最長 ${quantile(1)} m` : "";
    return `${key}：候補 ${rows.length}、測定済み ${lengths.length}、概測 ${counts("estimated")}、画像参考 ${counts("image_reference")}、下限のみ ${counts("lower_bound")}、保留 ${counts("pending")}、対象外 ${excluded}、未確認 ${counts("unreviewed")}${stats}`;
  });
  const summary = $("summary");
  summary.replaceChildren(...(lines.length ? lines : ["候補がありません。"]).map(line => {
    const p = document.createElement("p");
    p.textContent = line;
    return p;
  }));
  if (lines.length) summary.append("集計対象は一覧に表示中の候補です。");
}

function allowDiscard() {
  return !dirty || confirm("未記録の入力を破棄して移動しますか？");
}

function openSite(site, scroll = false) {
  selected = site;
  path = site?.review?.path ?? null;
  dirty = false;
  $("detail").hidden = !site;
  $("form-message").textContent = "";
  if (site) {
    const r = site.review ?? {};
    $("title").textContent = [site.name, site.route, site.direction].filter(Boolean).join(" / ");
    $("candidate-info").textContent = `${site.id} · ${site.lat}, ${site.lon} · ${site.source}`;
    $("recheck").hidden = !site.recheck;
    if (site.recheck) {
      const { referenceM, method, previous } = site.recheck;
      $("recheck").textContent = (referenceM == null ? "" : `利用者の画像判読 ${referenceM} m（${method}）。`) +
        (previous?.path ? `旧測定 ${rounded(length(previous.path))} m は再判定のため集計から除外。旧測定線は調査フォルダの同じIDのKMZを参照。` : "");
    }
    for (const field of reviewFields) {
      form.elements[field].value = r[field] ?? (
        field === "status" ? "unreviewed" : field.endsWith("Unit") ? (site.country === "US" ? "mph" : "km/h") : ""
      );
    }
    $("reference").hidden = !site.reference;
    $("reference").open = false;
    if (site.reference) {
      const { code, auto, reason, bounds, kind, note } = site.reference;
      const types = { to_exit: "出口へ続く", continuation: "本線として続く", uncertain: "判定保留" };
      $("reference-text").textContent =
        `${code} ／ OSM 自動値 ${auto == null ? (reason ?? "なし") : auto + " m"} ／ 過去の写真判読 ${bounds ? bounds.join("–") + " m" : types[kind]}。 ${note}`;
    }
    updateForm();
    if (scroll) $("detail").scrollIntoView({ block: "start" });
  }
  render();
}

function updateForm() {
  const status = form.elements.status.value;
  $("distance-box").hidden = !hasPath(status);
  $("bounds").hidden = status !== "estimated";
  $("path-length").textContent = path
    ? `${rounded(length(path))} m（${path.length} 点、進行方向順）` : "測定線なし";
  $("path-out").disabled = !selected?.review?.path;
}

function download(name, data, mime) {
  const url = URL.createObjectURL(new Blob([data], { type: mime }));
  const link = document.createElement("a");
  link.download = name;
  link.href = url;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const xml = value => String(value).replace(/[&<>"']/g, c => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;",
})[c]);
const placemark = (name, description, geometry) =>
  `<Placemark><name>${xml(name)}</name><description>${xml(description)}</description>${geometry}</Placemark>`;
const coord = p => p.join(",") + ",0";
const point = p => `<Point><coordinates>${coord(p)}</coordinates></Point>`;
const pin = s => placemark([s.name, s.route, s.direction, s.id].filter(Boolean).join(" / "),
  s.source, point([s.lon, s.lat]));
const filename = id => id.replace(/[^a-zA-Z0-9_.-]/g, "_") || "site";
const kml = body => `<?xml version="1.0" encoding="UTF-8"?>\n<kml xmlns="http://www.opengis.net/kml/2.2"><Document>${body}</Document></kml>`;
const sendKml = (name, body) => download(name + ".kml", kml(body), "application/vnd.google-earth.kml+xml");

function readKml(text) {
  const doc = new DOMParser().parseFromString(text, "application/xml");
  const tags = (node, name) => [...node.getElementsByTagNameNS("*", name)];
  const lines = tags(doc, "LineString");
  if (tags(doc, "parsererror").length || lines.length !== 1) {
    throw Error("測定線（パス）を 1 本だけ含む KML / KMZ を選んでください。");
  }
  const coordinates = tags(lines[0], "coordinates")[0]?.textContent.trim();
  return coordinates?.split(/\s+/).map(value => value.split(",").slice(0, 2).map(numeric));
}

async function readKmz(file) {
  // KMZ is a ZIP. Read only the KML member using its central-directory entry.
  const maxSize = 5 * 1024 * 1024;
  if (file.size > maxSize) throw Error("測定線 1 本の小さな KMZ を選んでください。");
  const bytes = await file.arrayBuffer();
  const view = new DataView(bytes);
  const dword = offset => view.getUint32(offset, true);
  const word = offset => view.getUint16(offset, true);
  let footer = bytes.byteLength - 22;
  while (footer >= 0 && dword(footer) !== 0x06054b50) footer--;
  if (footer < 0) throw Error("KMZ の形式を確認してください。");
  let offset = dword(footer + 16);
  const entries = [];
  for (let i = 0; i < word(footer + 10); i++) {
    if (dword(offset) !== 0x02014b50) throw Error("KMZ の形式を確認してください。");
    const nameLength = word(offset + 28);
    const name = new TextDecoder().decode(bytes.slice(offset + 46, offset + 46 + nameLength));
    if (/\.kml$/i.test(name)) entries.push({ name, offset });
    offset += 46 + nameLength + word(offset + 30) + word(offset + 32);
  }
  const entry = entries.find(item => item.name.toLowerCase() === "doc.kml") ??
    (entries.length === 1 ? entries[0] : null);
  if (!entry) throw Error("KMZ から測定線を読めません。Google Earth Pro で KML として保存してください。");
  offset = entry.offset;
  const local = dword(offset + 42);
  if (dword(offset + 24) > maxSize || dword(local) !== 0x04034b50) throw Error("KMZ の形式を確認してください。");
  const start = local + 30 + word(local + 26) + word(local + 28);
  const blob = new Blob([bytes.slice(start, start + dword(offset + 20))]);
  if (word(offset + 10) === 0) return blob.text();
  if (word(offset + 10) !== 8) throw Error("Google Earth Pro で KML として保存してください。");
  const reader = blob.stream().pipeThrough(new DecompressionStream("deflate-raw")).getReader();
  let total = 0;
  const chunks = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxSize) {
      await reader.cancel();
      throw Error("測定線の KML が大きすぎます。");
    }
    chunks.push(value);
  }
  return new Blob(chunks).text();
}

function readCsv(text) {
  const records = [];
  let row = [];
  let value = "";
  let quoted = false;
  let closed = false;
  const endField = () => {
    row.push(value);
    value = "";
    closed = false;
  };
  const endRow = () => {
    endField();
    if (row.some(cell => cell.trim())) records.push(row);
    row = [];
  };
  text = text.replace(/^\uFEFF/, "");
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c !== '"') value += c;
      else if (text[i + 1] === '"') {
        value += c;
        i++;
      } else {
        quoted = false;
        closed = true;
      }
    } else if (c === ",") endField();
    else if (c === "\r" || c === "\n") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      endRow();
    } else if (c === '"' && !value && !closed) quoted = true;
    else if (c === '"' || closed) throw Error("CSV の引用符の位置を確認してください。");
    else value += c;
  }
  if (quoted) throw Error("CSV の引用符が閉じられていません。");
  endRow();
  const header = records.shift()?.map(v => v.trim());
  const required = fields.filter(field => !["route", "direction"].includes(field));
  if (!header || required.some(name => !header.includes(name)) || new Set(header).size !== header.length) {
    throw Error("候補 CSV の列名を確認してください。");
  }
  return records.map((record, i) => {
    try {
      if (record.length !== header.length) throw Error("列数が見出しと一致しません。");
      return candidate(Object.fromEntries(header.map((name, j) => [name, record[j]])));
    } catch (error) {
      throw Error(`データ行 ${i + 1}：${error.message}`);
    }
  });
}

function csvCell(value) {
  if (value == null) return '""';
  const str = String(value);
  const safe = typeof value === "string" && /^[\s]*[=+\-@]/.test(str) ? "'" + str : str;
  return '"' + safe.replaceAll('"', '""') + '"';
}

function exportCsv() {
  const columns = [...fields, "status", "length_m", "range_low_m", "range_high_m", "average_grade_pct",
    "elevation_change_m", "grade_source", "mainline_speed_kmh", "mainline_speed", "mainline_speed_unit",
    "mainline_speed_source", "ramp_speed_kmh", "ramp_speed", "ramp_speed_unit", "ramp_speed_source",
    "start_lat", "start_lon", "end_lat", "end_lon", "path_lon_lat_json", "measurement_source",
    "imagery_date", "reviewer", "review_recorded_at", "note", "user_reference_m", "user_reference_method",
    "superseded_length_m", "confirmed_minimum_m", "last_visible_lat", "last_visible_lon"];
  const rows = visibleSites().map(site => {
    const r = site.review ?? {};
    const { m, grade, main, ramp } = metrics(site);
    const [startLon, startLat] = r.path?.[0] ?? [];
    const [endLon, endLat] = r.path?.at(-1) ?? [];
    return [...fields.map(f => site[f]), statusOf(site), rounded(m), r.low, r.high, rounded(grade), r.rise,
      r.gradeSource, rounded(main), r.mainSpeed, r.mainSpeed == null ? "" : r.mainUnit, r.mainSource,
      rounded(ramp), r.rampSpeed, r.rampSpeed == null ? "" : r.rampUnit, r.rampSource,
      startLat, startLon, measured(r.status) ? endLat : "", measured(r.status) ? endLon : "", r.path ? JSON.stringify(r.path) : "",
      r.source, r.imageryDate, r.reviewer, r.recordedAt, r.note,
      site.recheck?.referenceM, site.recheck?.method,
      site.recheck?.previous?.path ? rounded(length(site.recheck.previous.path)) : "",
      lowerBound(r), r.status === "lower_bound" ? endLat : "", r.status === "lower_bound" ? endLon : ""];
  });
  download("accel-lane-results.csv", "\uFEFF" + [columns, ...rows].map(row => row.map(csvCell).join(",")).join("\r\n"),
    "text/csv;charset=utf-8");
}

function bindFile(id, button, onFile, onError) {
  $(button).onclick = () => $(id).click();
  $(id).onchange = async event => {
    const file = event.target.files[0];
    event.target.value = "";
    if (!file) return;
    try {
      await onFile(file);
    } catch (error) {
      $(onError).textContent = error.message;
    }
  };
}

bindFile("candidate-file", "import-button", async file => {
  const incoming = readCsv(await file.text());
  const ids = new Set();
  for (const site of incoming) {
    if (ids.has(site.id)) throw Error(`CSV 内で ID が重複しています：${site.id}`);
    ids.add(site.id);
  }
  const existing = new Set(sites.map(s => s.id));
  const newSites = incoming.filter(s => !existing.has(s.id));
  sites = [...sites, ...newSites];
  refreshRegions();
  render();
  save();
  $("notice").textContent = `${newSites.length} 件追加、既存 ID ${incoming.length - newSites.length} 件はそのまま。\n` +
    $("notice").textContent;
}, "notice");

bindFile("backup-file", "restore-button", async file => {
  const incoming = loadBackup(await file.text());
  if (!confirm("現在表示している台帳を、選択した JSON の内容に切り替えますか？")) return;
  sites = incoming;
  includeBundledSites = false;
  refreshRegions();
  openSite(null);
  save();
}, "notice");

bindFile("path-file", "path-in", async file => {
  const site = selected;
  const text = /\.kmz$/i.test(file.name) ? await readKmz(file) : await file.text();
  if (selected !== site) return;
  const points = readKml(text);
  checkPath(points);
  path = points;
  dirty = true;
  updateForm();
  const matching = points.some(p => distance([site.lon, site.lat], p) <= 2000);
  $("form-message").textContent = matching
    ? "測定線を読み込みました。始点・終点と進行方向を確認して記録してください。"
    : "測定線が候補ピンから 2 km 以上離れています。測った場所と候補が一致するか確認してください。";
}, "form-message");

form.oninput = () => {
  dirty = true;
  updateForm();
};
form.onsubmit = event => {
  event.preventDefault();
  const r = Object.fromEntries(reviewFields.map(field => [field, form.elements[field].value.trim()]));
  for (const field of ["low", "high", "rise", "mainSpeed", "rampSpeed"]) r[field] = numeric(r[field]);
  if (r.status !== "estimated") r.low = r.high = null;
  if (hasPath(r.status)) r.path = path;
  if (!measured(r.status)) {
    r.rise = null;
    r.gradeSource = "";
  }
  try {
    checkReview(r);
    r.recordedAt = new Date().toISOString();
    selected.review = r;
    openSite(selected);
    save();
    $("form-message").textContent = "確認結果を記録しました。";
  } catch (error) {
    $("form-message").textContent = error.message;
  }
};

$("region").onchange = render;
$("status-filter").onchange = render;
$("search").oninput = render;
$("candidate-kml").onclick = () => sendKml("accel-lane-candidates", visibleSites().map(pin).join(""));
$("pin").onclick = () => sendKml(filename(selected.id) + "-candidate", pin(selected));
$("path-out").onclick = () => {
  const r = selected.review;
  const text = `${r.source} / ${r.imageryDate || "撮影日不明"} / ${rounded(length(r.path))} m\n${r.note}`;
  const line = `<LineString><tessellate>1</tessellate><coordinates>${r.path.map(coord).join(" ")}</coordinates></LineString>`;
  sendKml(filename(selected.id) + "-measurement",
    placemark(selected.id + " 測定線", text, line) +
    placemark("始点", selected.id, point(r.path[0])) +
    placemark(r.status === "lower_bound" ? "確認できた最後の点" : "終点", selected.id, point(r.path.at(-1))));
};
$("backup").onclick = () => {
  if (dirty) $("form-message").textContent = "入力中の内容も保存するには、先に「確認結果を記録」を押してください。";
  download("accel-lane-ledger.json", payload(), "application/json");
};
$("csv").onclick = exportCsv;
window.addEventListener("beforeunload", event => {
  if (dirty) {
    event.preventDefault();
    event.returnValue = "";
  }
});

try {
  const current = localStorage.getItem(storageKey);
  if (current) {
    sites = loadBackup(current);
    includeBundledSites = JSON.parse(current).includeBundledSites !== false;
    if (includeBundledSites) {
      const saved = new Map(sites.map(site => [site.id, site]));
      sites = starter.map(site => {
        const stored = saved.get(site.id);
        saved.delete(site.id);
        return stored ? { ...site, ...stored, review: stored.review ?? site.review } : site;
      });
      sites.push(...saved.values());
    }
  }
} catch {
  $("notice").textContent = "ブラウザーの保存を読み込めませんでした。台帳 JSON があれば開き直してください。";
}
refreshRegions();
render();
