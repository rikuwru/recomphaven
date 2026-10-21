#!/usr/bin/env python3
"""Makes the backdrop pictures the site shows: small and already blurred.

The pictures behind game pages and details windows are only ever seen out of focus. Blurring them
in the browser (a CSS filter) costs a lot on some devices, Chrome especially, because the blur is
redone on every frame while the picture drifts and zooms. So the blur is done here, once: each
picture in backdrop-sources/<game page name>/ listed in data/media.js is scaled down and blurred,
then written to media/backdrops/<game page name>/ (the media repository) with the same name.

    .venv/Scripts/python tools/blur_backdrops.py               # every listed picture
    .venv/Scripts/python tools/blur_backdrops.py --only doom

Needs Pillow.
"""
import argparse
import json
import os
import sys

from PIL import Image, ImageFilter

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from refresh_stats import ROOT  # noqa: E402

SRC = os.path.join(ROOT, 'backdrop-sources')
OUT = os.path.join(ROOT, 'media', 'backdrops')
WIDTH = 960    # plenty for a picture that's out of focus, even full screen
BLUR = 2.4     # Gaussian radius at that width: about the 5px blur the site used to apply when shown
QUALITY = 72   # WebP; the blur hides compression


def media_games():
    text = open(os.path.join(ROOT, 'data', 'media.js'), encoding='utf-8').read()
    return json.loads(text[text.index('{', text.index('RECOMPHAVEN_MEDIA')):].rstrip().rstrip(';'))['games']


def blur(src, dest):
    im = Image.open(src).convert('RGB')
    if im.width > WIDTH:
        im = im.resize((WIDTH, round(WIDTH * im.height / im.width)), Image.LANCZOS)
    im = im.filter(ImageFilter.GaussianBlur(BLUR * im.width / WIDTH))
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    im.save(dest, 'WEBP', quality=QUALITY, method=6)


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--only', help='one game page name')
    args = ap.parse_args()
    done = missing = 0
    before = after = 0
    for slug, game in media_games().items():
        if args.only and slug != args.only:
            continue
        for pic in game.get('backdrop') or []:
            src = os.path.join(SRC, slug, pic['file'])
            dest = os.path.join(OUT, slug, pic['file'])
            if not os.path.isfile(src):
                print(f'  missing: backdrop-sources/{slug}/{pic["file"]}')
                missing += 1
                continue
            before += os.path.getsize(src)
            blur(src, dest)
            after += os.path.getsize(dest)
            done += 1
    print(f'Blurred {done} pictures ({before / 1048576:.1f} MB of sources -> {after / 1048576:.1f} MB)'
          + (f'; {missing} missing' if missing else '') + '.')


if __name__ == '__main__':
    main()
