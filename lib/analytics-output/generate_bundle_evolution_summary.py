#!/usr/bin/env python3
"""Generate a markdown numbers summary for the Clean Code bundles evolution graph.

Reuses the same data loading as generate_bundle_evolution_graph.py so the
figures in the .md always match what is plotted in the .svg.
"""
import csv
from pathlib import Path

from generate_bundle_evolution_graph import (
    BUNDLES,
    HERE,
    date_label,
    load_downloads,
    load_releases,
    snapshot_date,
)

OUTPUT = HERE / "clean-code-bundle-evolution-summary.md"


def latest_detailed_csv() -> Path:
    candidates = list(HERE.glob("hub-analytics-*-detailed.csv"))
    return max(candidates, key=snapshot_date)


def load_version_numbers(csv_path: Path):
    """Per (bundle, version) numbers as of the latest snapshot."""
    numbers = {}
    with csv_path.open(newline="") as file:
        for row in csv.DictReader(file):
            bundle_id = row["Bundle ID"]
            if bundle_id not in BUNDLES:
                continue
            numbers.setdefault(bundle_id, []).append({
                "tag": row["Release Tag"],
                "downloads": int(row["Downloads"]),
                "asset_size": int(row["Asset Size"]),
                "released_at": row["Release Date"],
            })
    return numbers


def build_markdown(downloads, snapshots, releases, version_numbers) -> str:
    lines = [
        "# Clean Code in the Cloud bundles: evolution numbers",
        "",
        f"Snapshots covered: {', '.join(date_label(value) for value in snapshots)} "
        f"(source: `hub-analytics-*-by-bundle.csv` and `hub-analytics-*-detailed.csv`).",
        "",
        "## Overview",
        "",
        "| Bundle ID | Latest downloads | Versions | First release | Latest release |",
        "|---|---:|---:|---|---|",
    ]

    ordered_bundle_ids = sorted(BUNDLES, key=lambda bundle_id: releases[bundle_id][0][1])

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
    downloads, snapshots = load_downloads()
    releases = load_releases()
    version_numbers = load_version_numbers(latest_detailed_csv())
    OUTPUT.write_text(build_markdown(downloads, snapshots, releases, version_numbers))
    print(f"Saved {OUTPUT.name}")


if __name__ == "__main__":
    main()
