"""Create a survey ledger from a small OpenStreetMap area or a saved .osm file."""

import argparse
import csv
import json
import math
from pathlib import Path
import urllib.parse
import urllib.request
from xml.etree import ElementTree


SOURCE = "© OpenStreetMap contributors (ODbL), https://www.openstreetmap.org/copyright"
FIELDS = ("id", "country", "region", "name", "lat", "lon", "source", "route", "direction")
WORLD = (-180, -90, 180, 90)


def directed_nodes(way):
    tags, nodes = way
    direction = tags.get("oneway", "yes" if tags["highway"] == "motorway" else "")
    if direction in {"yes", "true", "1", "no", "false", "0"}:
        yield nodes
    if direction in {"-1", "no", "false", "0"}:
        yield nodes[::-1]


def heading(start, end):
    lat, lon = start
    north = end[0] - lat
    east = (end[1] - lon) * math.cos(math.radians(lat))
    angle = math.degrees(math.atan2(east, north))
    names = ("北", "北東", "東", "南東", "南", "南西", "西", "北西")
    return names[round(angle / 45) % len(names)] + "方向"


def candidates(root, args):
    locations = {
        n.attrib["id"]: (float(n.attrib["lat"]), float(n.attrib["lon"]))
        for n in root.findall("node")
    }
    mainline = {}
    ramps = {}
    for element in root.findall("way"):
        tags = {tag.attrib["k"]: tag.attrib["v"] for tag in element.findall("tag")}
        nodes = [node.attrib["ref"] for node in element.findall("nd")]
        if len(nodes) < 2:
            continue
        if tags.get("highway") == "motorway":
            for sequence in directed_nodes((tags, nodes)):
                route = tags.get("ref", "")
                for origin, destination in zip(sequence, sequence[1:]):
                    if origin in locations and destination in locations:
                        direction = heading(locations[origin], locations[destination])
                        mainline.setdefault(origin, set()).add((route, direction))
        elif tags.get("highway") == "motorway_link":
            ramps[element.attrib["id"]] = (tags, nodes)

    return build_rows(locations, mainline, ramps, args)


def build_rows(locations, mainline, ramps, args):
    west, south, east, north = args.bbox or WORLD
    rows = []
    unknown = 0
    for ramp_id, ramp in sorted(ramps.items(), key=lambda pair: int(pair[0])):
        directions = list(directed_nodes(ramp))
        if not directions and any(node in mainline for node in (ramp[1][0], ramp[1][-1])):
            unknown += 1
        for node in dict.fromkeys(sequence[-1] for sequence in directions):
            if node not in mainline:
                continue
            lat, lon = locations[node]
            if not (west <= lon <= east and south <= lat <= north):
                continue
            successors = mainline[node]
            route, direction = next(iter(successors)) if len(successors) == 1 else ("", "")
            rows.append(dict(
                id=f"OSM-{ramp_id}-{node}", country=args.country, region=args.region,
                name=args.name, lat=lat, lon=lon, source=SOURCE, route=route,
                direction=direction,
            ))
    return rows, unknown


def osmium_module():
    try:
        import osmium
    except ImportError:
        raise ValueError("PBFの読み取りには python -m pip install osmium が必要です。") from None
    return osmium


def extract_pbf(path, args):
    osmium = osmium_module()
    ramps = {}
    endpoints = set()
    links = osmium.filter.TagFilter(("highway", "motorway_link"))
    for way in osmium.FileProcessor(path, osmium.osm.WAY).with_filter(links):
        nodes = [node.ref for node in way.nodes]
        if len(nodes) >= 2:
            ramps[str(way.id)] = (dict(way.tags), nodes)
            endpoints.update((nodes[0], nodes[-1]))

    neighbors = {}
    node_ids = set(endpoints)
    motorways = osmium.filter.TagFilter(("highway", "motorway"))
    for way in osmium.FileProcessor(path, osmium.osm.WAY).with_filter(motorways):
        tags = dict(way.tags)
        nodes = [node.ref for node in way.nodes]
        route = tags.get("ref", "")
        for sequence in directed_nodes((tags, nodes)):
            for origin, destination in zip(sequence, sequence[1:]):
                if origin in endpoints:
                    neighbors.setdefault(origin, set()).add((route, destination))
                    node_ids.add(destination)

    locations = {
        node.id: (node.lat, node.lon)
        for node in osmium.FileProcessor(path, osmium.osm.NODE).with_filter(osmium.filter.IdFilter(node_ids))
    }
    mainline = {
        origin: {(route, heading(locations[origin], locations[destination]))
                 for route, destination in edges if destination in locations}
        for origin, edges in neighbors.items() if origin in locations
    }
    return build_rows(locations, {node: exits for node, exits in mainline.items() if exits}, ramps, args)


def read_pbf(path, bbox):
    osmium = osmium_module()
    west, south, east, north = bbox
    ways = []
    node_ids = set()
    highways = osmium.filter.TagFilter(("highway", "motorway"), ("highway", "motorway_link"))
    for way in osmium.FileProcessor(path, osmium.osm.WAY).with_filter(highways):
        refs = [node.ref for node in way.nodes]
        ways.append((way.id, refs, dict(way.tags)))
        node_ids.update(refs)

    coordinates = {}
    inside = set()
    for node in osmium.FileProcessor(path, osmium.osm.NODE).with_filter(osmium.filter.IdFilter(node_ids)):
        lon, lat = node.lon, node.lat
        coordinates[node.id] = (lon, lat)
        if west <= lon <= east and south <= lat <= north:
            inside.add(node.id)

    root = ElementTree.Element("osm", version="0.6", generator="AccelLaneLite")
    ElementTree.SubElement(
        root, "bounds", minlon=str(west), minlat=str(south), maxlon=str(east), maxlat=str(north),
    )
    selected_ways = [(way_id, refs, tags) for way_id, refs, tags in ways if not inside.isdisjoint(refs)]
    selected_nodes = {ref for _, refs, _ in selected_ways for ref in refs}
    for node_id in sorted(selected_nodes.intersection(coordinates)):
        lon, lat = coordinates[node_id]
        ElementTree.SubElement(root, "node", id=str(node_id), lon=str(lon), lat=str(lat))
    for way_id, refs, tags in selected_ways:
        way = ElementTree.SubElement(root, "way", id=str(way_id))
        for ref in refs:
            ElementTree.SubElement(way, "nd", ref=str(ref))
        for key, value in tags.items():
            ElementTree.SubElement(way, "tag", k=key, v=value)
    return root


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    area = parser.add_mutually_exclusive_group()
    area.add_argument("--bbox", type=float, nargs=4,
                        metavar=("WEST", "SOUTH", "EAST", "NORTH"))
    area.add_argument("--area", type=Path, help="Load a rectangle saved using the area picker")
    parser.add_argument("--country", required=True, choices=("JP", "US"))
    parser.add_argument("--region", required=True)
    parser.add_argument("--name", required=True)
    parser.add_argument("--output", required=True, type=Path, help="Ledger .json or candidate .csv")
    parser.add_argument("--input", type=Path, help="Use a local .osm or .osm.pbf file instead of the API")
    parser.add_argument("--save-osm", type=Path, help="Save fetched or extracted XML for offline repeat runs")
    args = parser.parse_args()
    if args.area:
        try:
            args.bbox = [float(value) for value in json.loads(args.area.read_text(encoding="utf-8-sig"))["bbox"]]
            if len(args.bbox) != 4:
                raise ValueError("4 coordinates are required")
        except (OSError, ValueError, KeyError, TypeError) as error:
            parser.error(f"Invalid area file: {error}")
    if not args.input and not args.bbox:
        parser.error("Use --input for a complete local dataset, or select an area for Overpass")
    west, south, east, north = args.bbox or WORLD
    if not (-180 <= west < east <= 180 and -90 <= south < north <= 90):
        parser.error("--bbox must be west south east north in decimal degrees")
    if args.output.suffix.lower() not in {".csv", ".json"}:
        parser.error("--output must end in .csv or .json")
    pbf_input = args.input is not None and args.input.suffix.lower() == ".pbf"
    if args.save_osm and args.save_osm.resolve() == args.output.resolve():
        parser.error("--save-osm and --output must be separate paths")
    if args.save_osm and args.input and (
        not pbf_input or args.save_osm.resolve() == args.input.resolve()
    ):
        parser.error("--save-osm requires a download or PBF input and a separate path")
    if args.input and args.input.resolve() == args.output.resolve():
        parser.error("--input and --output must be separate paths")
    if pbf_input and args.save_osm and not args.bbox:
        parser.error("Select an area when exporting XML from a PBF")
    try:
        if pbf_input and not args.save_osm:
            rows, unknown = extract_pbf(args.input, args)
        elif pbf_input:
            data = ElementTree.tostring(read_pbf(args.input, args.bbox), encoding="utf-8")
        elif args.input:
            data = args.input.read_bytes()
        else:
            if (east - west) * (north - south) > 0.01:
                parser.error("For API requests, choose a small area around one interchange")
            bbox = ",".join(map(str, (south, west, north, east)))
            query = (
                f'[out:xml][timeout:20];way["highway"~"^(motorway|motorway_link)$"]({bbox});'
                "out body;>;out skel qt;"
            )
            request = urllib.request.Request(
                "https://overpass-api.de/api/interpreter?" + urllib.parse.urlencode({"data": query}),
                headers={"User-Agent": "AccelLaneLite/1.0 (interchange candidate export)"},
            )
            with urllib.request.urlopen(request, timeout=30) as response:
                data = response.read()
        if not pbf_input or args.save_osm:
            root = ElementTree.fromstring(data)
            if root.tag != "osm":
                parser.error("expected an OSM XML document")
            if root.findtext("remark"):
                parser.error(root.findtext("remark"))
            rows, unknown = candidates(root, args)
        if args.save_osm:
            args.save_osm.write_bytes(data)
        if args.output.suffix.lower() == ".csv":
            with args.output.open("w", newline="", encoding="utf-8-sig") as output:
                writer = csv.DictWriter(output, fieldnames=FIELDS)
                writer.writeheader()
                writer.writerows(rows)
        else:
            args.output.write_text(
                json.dumps({"version": 1, "sites": rows}, ensure_ascii=False, indent=2) + "\n",
                encoding="utf-8",
            )
    except (OSError, ElementTree.ParseError, ValueError, KeyError, RuntimeError) as error:
        parser.exit(1, f"{parser.prog}: {error}\n")
    print(f"{len(rows)} candidates written to {args.output}")
    if not rows:
        print("Check that the bbox contains a motorway entrance and the input covers that area.")
    if unknown:
        print(f"{unknown} links with unclear travel direction need manual review")


if __name__ == "__main__":
    main()
