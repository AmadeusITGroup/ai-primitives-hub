#!/usr/bin/env python3
"""Generate a markdown numbers summary for a list of bundles.

Usage:
  python3 generate_summary.py --bundle cnadocs --bundle skubedocs \\
      [--analytics-dir lib/analytics-output] [--output evolution.md]

Uses the same data loading as generate_graph.py so the figures in the .md
always match what is plotted in the .svg.
"""
import argparse
from pathlib import Path

from _analytics_common import (
    date_label,
    latest_detailed_csv,
    load_downloads,
    load_releases,
    load_version_numbers,
)


def build_markdown(bundle_ids, downloads, snapshots, releases, version_numbers) -> str:
    lines = [
        "# Bundle evolution numbers",
        "",
        f"Snapshots covered: {', '.join(date_label(value) for value in snapshots)} "
        f"(source: `hub-analytics-*-by-bundle.csv` and `hub-analytics-*-detailed.csv`).",
        "",
        "## Overview",
        "",
        "| Bundle ID | Latest downloads | Versions | First release | Latest release |",
        "|---|---:|---:|---|---|",
    ]

    ordered_bundle_ids = sorted(bundle_ids, key=lambda bundle_id: releases[bundle_id][0][1])

    for bundle_id in ordered_bundle_ids:
        latest_downloads = downloads[bundle_id][-1][1]
        first_release = releases[bundle_id][0][1]
        latest_release = releases[bundle_id][-1][1]
        lines.append(
            f"| {bundle_id} | {latest_downloads} | {len(releases[bundle_id])} | "
            f"{date_label(first_release.replace(tzinfo=None))} | "
            f"{date_label(latest_release.replace(tzinfo=None))} |"
        )

    for bundle_id in ordered_bundle_ids:
        lines += [
            "",
            f"## {bundle_id}",
            "",
            "### Cumulative downloads by snapshot",
            "",
            "| Snapshot | Total downloads |",
            "|---|---:|",
        ]
        for recorded_at, total in downloads[bundle_id]:
            lines.append(f"| {date_label(recorded_at)} | {total} |")

        lines += [
            "",
            "### Versions",
            "",
            "| Version | Released | Downloads (latest snapshot) | Asset size (bytes) |",
            "|---|---|---:|---:|",
        ]
        numbers_by_tag = {entry["tag"]: entry for entry in version_numbers.get(bundle_id, [])}
        for tag, released_at in releases[bundle_id]:
            entry = numbers_by_tag.get(tag)
            downloads_value = entry["downloads"] if entry else "-"
            asset_size = entry["asset_size"] if entry else "-"
            lines.append(
                f"| {tag} | {date_label(released_at.replace(tzinfo=None))} | "
                f"{downloads_value} | {asset_size} |"
            )

    return "\n".join(lines) + "\n"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bundle", action="append", dest="bundles", required=True,
                         help="Bundle ID to include; repeat for multiple bundles.")
    parser.add_argument("--analytics-dir", default="lib/analytics-output", type=Path,
                         help="Directory with hub-analytics-*-by-bundle.csv / -detailed.csv snapshots.")
    parser.add_argument("--output", type=Path, help="Output .md path (default: <analytics-dir>/bundle-evolution-summary.md).")
    args = parser.parse_args()

    bundle_ids = list(dict.fromkeys(args.bundles))  # de-dupe, preserve order
    output = args.output or (args.analytics_dir / "bundle-evolution-summary.md")

    downloads, snapshots = load_downloads(args.analytics_dir, bundle_ids)
    releases = load_releases(args.analytics_dir, bundle_ids)
    version_numbers = load_version_numbers(latest_detailed_csv(args.analytics_dir), bundle_ids)

    missing = [bundle_id for bundle_id in bundle_ids if not downloads[bundle_id] or not releases[bundle_id]]
    if missing:
        raise ValueError(f"Missing analytics for: {', '.join(missing)}")

    output.write_text(build_markdown(bundle_ids, downloads, snapshots, releases, version_numbers))
    print(f"Saved {output}")


if __name__ == "__main__":
    main()
