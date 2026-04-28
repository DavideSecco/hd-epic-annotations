#!/usr/bin/env python3
"""
Extract compact hand-mask JSON for one or more videos from contours_preds.zip.

Usage:
    python3 extract_hand_masks.py P01-20240204-152537
    python3 extract_hand_masks.py all          # extract every video in the zip

Output: hand-masks/<video_id>.json
Format: {"<frame>": {"l": "<rle_counts>", "r": "<rle_counts>"}, ...}
Only non-empty frames are stored; only hands that are actually present.
The RLE counts string is the raw COCO compressed-RLE string (no size field —
always 1408×1408).
"""

import zipfile
import json
import os
import sys
import argparse

ZIP_PATH = '/mnt/bocconi_hpc_video_datasets/HD-EPIC/Hands-Masks/contours_preds.zip'
OUT_DIR  = os.path.join(os.path.dirname(__file__), 'hand-masks')


def extract_video(z, zip_name, video_id):
    out_path = os.path.join(OUT_DIR, f'{video_id}.json')
    with z.open(zip_name) as f:
        data = json.load(f)

    compact = {}
    for frame_str, masks in data.items():
        if not masks:
            continue
        entry = {}
        if 'left'  in masks: entry['l'] = masks['left']['counts']
        if 'right' in masks: entry['r'] = masks['right']['counts']
        if entry:
            compact[frame_str] = entry

    # Sort by frame number
    sorted_compact = {k: compact[k] for k in sorted(compact, key=lambda x: int(x))}

    with open(out_path, 'w') as f:
        json.dump(sorted_compact, f, separators=(',', ':'))

    size_mb = os.path.getsize(out_path) / 1024 / 1024
    print(f'  {video_id}: {len(sorted_compact)} frames  →  {out_path}  ({size_mb:.1f} MB)')


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('video_id', help='Video ID (e.g. P01-20240204-152537) or "all"')
    args = parser.parse_args()

    os.makedirs(OUT_DIR, exist_ok=True)

    with zipfile.ZipFile(ZIP_PATH) as z:
        entries = {
            entry.split('/')[-1].replace('.json', ''): entry
            for entry in z.namelist()
            if entry.endswith('.json')
        }

        if args.video_id == 'all':
            print(f'Extracting {len(entries)} videos…')
            for vid, zip_name in sorted(entries.items()):
                extract_video(z, zip_name, vid)
        else:
            vid = args.video_id
            if vid not in entries:
                print(f'ERROR: {vid} not found in zip. Available:', sorted(entries)[:5], '...')
                sys.exit(1)
            extract_video(z, entries[vid], vid)

    print('Done.')


if __name__ == '__main__':
    main()
