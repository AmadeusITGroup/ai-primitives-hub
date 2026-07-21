#!/usr/bin/env python3
"""Generate a version-aware download evolution graph for Clean Code bundles."""
import csv
import html
import math
import re
from collections import defaultdict
from datetime import datetime
from pathlib import Path


HERE = Path(__file__).parent
OUTPUT = HERE / "clean-code-bundle-evolution-2026-07-20.svg"
BUNDLES = {
    "cna-starter-app-bundle": "CNA starter app",
    "cnadocs": "CNA docs",
    "skubedocs": "Skube docs",
    "amadeus-microservice-coding-guidebook": "Microservice coding guidebook",
    "archreview": "Architecture review",
}
COLORS = {
    "cna-starter-app-bundle": "#D1495B",
    "cnadocs": "#007C91",
    "skubedocs": "#4056A1",
    "amadeus-microservice-coding-guidebook": "#E06C2F",
    "archreview": "#548235",
}


def snapshot_date(path: Path) -> datetime:
    match = re.search(r"hub-analytics-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2})", path.name)
    if not match:
        raise ValueError(f"Cannot determine snapshot date from {path.name}")
    return datetime.strptime(match.group(1), "%Y-%m-%dT%H-%M-%S")


def load_downloads():
    downloads = defaultdict(list)
    snapshots = []
    for path in sorted(HERE.glob("hub-analytics-*-by-bundle.csv")):
        recorded_at = snapshot_date(path)
        snapshots.append(recorded_at)
        with path.open(newline="") as file:
            for row in csv.DictReader(file):
                bundle_id = row["Bundle ID"]
                if bundle_id in BUNDLES:
                    downloads[bundle_id].append((recorded_at, int(row["Total Downloads"])))
    return downloads, sorted(snapshots)


def load_releases():
    releases = {}
    for path in HERE.glob("hub-analytics-*-detailed.csv"):
        with path.open(newline="") as file:
            for row in csv.DictReader(file):
                bundle_id = row["Bundle ID"]
                if bundle_id not in BUNDLES:
                    continue
                release_tag = row["Release Tag"]
                release_date = datetime.fromisoformat(row["Release Date"].replace("Z", "+00:00"))
                key = (bundle_id, release_tag)
                existing = releases.get(key)
                if existing is None or release_date < existing:
                    releases[key] = release_date
    return {
        bundle_id: sorted(
            [(tag, released_at) for (current_bundle, tag), released_at in releases.items()
             if current_bundle == bundle_id],
            key=lambda release: release[1],
        )
        for bundle_id in BUNDLES
    }


def scale(value, minimum, maximum, output_minimum, output_maximum):
    if maximum == minimum:
        return (output_minimum + output_maximum) / 2
    return output_minimum + (value - minimum) * (output_maximum - output_minimum) / (maximum - minimum)


def date_label(value: datetime) -> str:
    return value.strftime("%b %d").replace(" 0", " ")


def render_graph(downloads, snapshots, releases):
    width, height = 1800, 1480
    left, right, top, bottom = 330, 80, 190, 95
    row_height, row_gap = 205, 28
    chart_width = width - left - right
    minimum_date = min(
        [recorded_at for values in downloads.values() for recorded_at, _ in values]
        + [released_at.replace(tzinfo=None) for values in releases.values() for _, released_at in values]
    )
    maximum_date = max(snapshots)

    def x_position(value):
        return scale(value.timestamp(), minimum_date.timestamp(), maximum_date.timestamp(), left, left + chart_width)

    svg = [
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" viewBox="0 0 {width} {height}">',
        "<style>"
        ".title{font:700 34px Arial,sans-serif;fill:#14213D}.subtitle{font:18px Arial,sans-serif;fill:#52616B}"
        ".bundle{font:700 20px Arial,sans-serif;fill:#14213D}.metric{font:16px Arial,sans-serif;fill:#52616B}"
        ".axis{font:15px Arial,sans-serif;fill:#52616B}.release{font:12px Arial,sans-serif;fill:#293241}"
        ".note{font:14px Arial,sans-serif;fill:#52616B}.value{font:700 16px Arial,sans-serif;fill:#14213D}"
        "</style>",
        f'<rect width="{width}" height="{height}" fill="#F7F9FC"/>',
        f'<text x="{left}" y="62" class="title">Clean Code in the Cloud: bundle evolution</text>',
        f'<text x="{left}" y="94" class="subtitle">Each bundle line starts at its ★ first-release date (0 downloads); cumulative downloads and every published version are then plotted over time</text>',
        f'<text x="{left}" y="124" class="note">Snapshots: {", ".join(date_label(value) for value in snapshots)}.</text>',
    ]

    for snapshot in snapshots:
        x = x_position(snapshot)
        svg.append(f'<line x1="{x:.1f}" y1="{top - 12}" x2="{x:.1f}" y2="{height - bottom}" stroke="#D9E2EC" stroke-width="1"/>')
        svg.append(f'<text x="{x:.1f}" y="{height - 55}" text-anchor="middle" class="axis">{date_label(snapshot)}</text>')

    # Order rows chronologically by first release, oldest first, so the timeline
    # reads top-to-bottom the same way it reads left-to-right.
    ordered_bundle_ids = sorted(BUNDLES, key=lambda bundle_id: releases[bundle_id][0][1])

    for row_index, bundle_id in enumerate(ordered_bundle_ids):
        row_top = top + row_index * (row_height + row_gap)
        row_bottom = row_top + row_height
        color = COLORS[bundle_id]

        first_release_at = releases[bundle_id][0][1].replace(tzinfo=None)
        values = list(downloads[bundle_id])
        # Anchor the line at 0 downloads on the actual first-release date so the
        # start of every bundle's trend is explicit instead of floating in
        # mid-chart at whatever value its first snapshot happened to capture.
        if not values or first_release_at < values[0][0]:
            values = [(first_release_at, 0)] + values
        maximum_downloads = max(total for _, total in values) or 1
        y_position = lambda value: scale(value, 0, maximum_downloads, row_bottom - 18, row_top + 42)

        svg.append(f'<rect x="{left}" y="{row_top}" width="{chart_width}" height="{row_height}" rx="5" fill="#FFFFFF" stroke="#D9E2EC"/>')
        svg.append(f'<text x="{left - 20}" y="{row_top + 43}" text-anchor="end" class="bundle">{html.escape(BUNDLES[bundle_id])}</text>')
        svg.append(f'<text x="{left - 20}" y="{row_top + 68}" text-anchor="end" class="metric">{len(releases[bundle_id])} versions</text>')
        svg.append(f'<text x="{left - 20}" y="{row_top + 92}" text-anchor="end" class="metric">{maximum_downloads} downloads</text>')
        svg.append(f'<line x1="{left}" y1="{y_position(maximum_downloads):.1f}" x2="{left + chart_width}" y2="{y_position(maximum_downloads):.1f}" stroke="#E9EFF5"/>')
        svg.append(f'<text x="{left + 8}" y="{y_position(maximum_downloads) - 7:.1f}" class="axis">{maximum_downloads}</text>')

        points = " ".join(f"{x_position(recorded_at):.1f},{y_position(total):.1f}" for recorded_at, total in values)
        svg.append(f'<polyline points="{points}" fill="none" stroke="{color}" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>')
        for recorded_at, total in values:
            x, y = x_position(recorded_at), y_position(total)
            svg.append(f'<circle cx="{x:.1f}" cy="{y:.1f}" r="6" fill="{color}" stroke="#FFFFFF" stroke-width="2"/>')

        # Explicit "start" marker: bigger star at the true origin (first release,
        # 0 downloads), with its own callout, so it can never be confused with a
        # regular snapshot dot or mistaken for missing earlier data.
        start_x, start_y = x_position(first_release_at), y_position(0)
        star_points = star_path(start_x, start_y, outer=11, inner=4.5)
        svg.append(f'<polygon points="{star_points}" fill="#FFFFFF" stroke="{color}" stroke-width="2.5"/>')
        start_label_anchor = "start" if start_x - left < 90 else "middle"
        start_label_dx = 10 if start_label_anchor == "start" else 0
        svg.append(
            f'<text x="{start_x + start_label_dx:.1f}" y="{row_top + 26}" text-anchor="{start_label_anchor}" '
            f'class="metric" fill="{color}">&#9733; Launched {date_label(first_release_at)}</text>'
        )

        for release_index, (release_tag, released_at) in enumerate(releases[bundle_id]):
            x = x_position(released_at.replace(tzinfo=None))
            label = release_tag.removeprefix(f"{bundle_id}-")
            lane = release_index % 3
            label_y = row_bottom - 16 - lane * 18
            svg.append(f'<line x1="{x:.1f}" y1="{row_top + 104}" x2="{x:.1f}" y2="{row_bottom - 10}" stroke="{color}" stroke-width="1.5" stroke-dasharray="4 3" opacity="0.78"/>')
            svg.append(f'<text x="{x + 4:.1f}" y="{label_y}" class="release" fill="{color}">{html.escape(label)}</text>')

    svg.extend([
        f'<line x1="{left}" y1="{height - 38}" x2="{left + 32}" y2="{height - 38}" stroke="#4056A1" stroke-width="3"/>',
        f'<text x="{left + 42}" y="{height - 33}" class="note">Download trend</text>',
        f'<line x1="{left + 190}" y1="{height - 38}" x2="{left + 222}" y2="{height - 38}" stroke="#4056A1" stroke-width="2" stroke-dasharray="4 3"/>',
        f'<text x="{left + 232}" y="{height - 33}" class="note">Version release</text>',
        f'<polygon points="{star_path(left + 405, height - 41, outer=9, inner=3.7)}" fill="#FFFFFF" stroke="#4056A1" stroke-width="2"/>',
        f'<text x="{left + 425}" y="{height - 33}" class="note">First release (0 downloads)</text>',
        "</svg>",
    ])
    return "\n".join(svg)


def star_path(cx: float, cy: float, outer: float, inner: float) -> str:
    """Return polygon points for a 5-point star centered at (cx, cy)."""
    points = []
    for i in range(10):
        radius = outer if i % 2 == 0 else inner
        angle = math.pi / 2 + i * math.pi / 5
        points.append(f"{cx + radius * math.cos(angle):.1f},{cy - radius * math.sin(angle):.1f}")
    return " ".join(points)


def main():
    downloads, snapshots = load_downloads()
    releases = load_releases()
    missing = [bundle_id for bundle_id in BUNDLES if not downloads[bundle_id] or not releases[bundle_id]]
    if missing:
        raise ValueError(f"Missing analytics for: {', '.join(missing)}")
    OUTPUT.write_text(render_graph(downloads, snapshots, releases))
    print(f"Saved {OUTPUT.name} with {sum(len(values) for values in releases.values())} versions.")


if __name__ == "__main__":
    main()