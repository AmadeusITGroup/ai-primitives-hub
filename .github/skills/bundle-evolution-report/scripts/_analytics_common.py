"""Shared CSV loading helpers for bundle-evolution-report scripts.

Reads the `hub-analytics-*-by-bundle.csv` and `hub-analytics-*-detailed.csv`
snapshots produced by `lib/bin/hub-release-analyzer.js` into
`lib/analytics-output/`.
"""
import csv
import re
from collections import defaultdict
from datetime import datetime
from pathlib import Path

SNAPSHOT_RE = re.compile(r"hub-analytics-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2})")

# Cycled automatically across the requested bundles; add more if you routinely
# chart more than 8 bundles at once.
PALETTE = [
    "#4056A1", "#D1495B", "#007C91", "#E06C2F", "#548235",
    "#8E44AD", "#C9A227", "#2E86AB",
]


def snapshot_date(path: Path) -> datetime:
    match = SNAPSHOT_RE.search(path.name)
    if not match:
        raise ValueError(f"Cannot determine snapshot date from {path.name}")
    return datetime.strptime(match.group(1), "%Y-%m-%dT%H-%M-%S")


def date_label(value: datetime) -> str:
    return value.strftime("%b %d").replace(" 0", " ")


def load_downloads(analytics_dir: Path, bundle_ids):
    """Cumulative downloads per bundle at each dated snapshot, oldest first."""
    downloads = defaultdict(list)
    snapshots = []
    for path in sorted(analytics_dir.glob("hub-analytics-*-by-bundle.csv"), key=snapshot_date):
        recorded_at = snapshot_date(path)
        snapshots.append(recorded_at)
        with path.open(newline="") as file:
            for row in csv.DictReader(file):
                bundle_id = row["Bundle ID"]
                if bundle_id in bundle_ids:
                    downloads[bundle_id].append((recorded_at, int(row["Total Downloads"])))
    return downloads, snapshots


def load_releases(analytics_dir: Path, bundle_ids):
    """Every published version per bundle, deduped across snapshots, oldest first.

    Detailed CSVs are cumulative captures (each snapshot repeats prior
    releases), so the first-seen release date per (bundle, tag) is kept.
    """
    releases = {}
    for path in analytics_dir.glob("hub-analytics-*-detailed.csv"):
        with path.open(newline="") as file:
            for row in csv.DictReader(file):
                bundle_id = row["Bundle ID"]
                if bundle_id not in bundle_ids:
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
        for bundle_id in bundle_ids
    }


def latest_detailed_csv(analytics_dir: Path) -> Path:
    candidates = list(analytics_dir.glob("hub-analytics-*-detailed.csv"))
    if not candidates:
        raise FileNotFoundError(f"No hub-analytics-*-detailed.csv found in {analytics_dir}")
    return max(candidates, key=snapshot_date)


def load_version_numbers(csv_path: Path, bundle_ids):
    """Per-version downloads/asset size as captured by the latest snapshot."""
    numbers = defaultdict(list)
    with csv_path.open(newline="") as file:
        for row in csv.DictReader(file):
            bundle_id = row["Bundle ID"]
            if bundle_id not in bundle_ids:
                continue
            numbers[bundle_id].append({
                "tag": row["Release Tag"],
                "downloads": int(row["Downloads"]),
                "asset_size": int(row["Asset Size"]),
                "released_at": row["Release Date"],
            })
    return numbers


def parse_labels(label_args):
    """Parse repeated --label id:Display Name args into a dict."""
    labels = {}
    for item in label_args or []:
        if ":" not in item:
            raise ValueError(f"--label must be 'bundle-id:Display Name', got: {item}")
        bundle_id, label = item.split(":", 1)
        labels[bundle_id.strip()] = label.strip()
    return labels


def scale(value, minimum, maximum, output_minimum, output_maximum):
    if maximum == minimum:
        return (output_minimum + output_maximum) / 2
    return output_minimum + (value - minimum) * (output_maximum - output_minimum) / (maximum - minimum)
