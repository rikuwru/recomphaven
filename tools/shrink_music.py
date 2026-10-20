#!/usr/bin/env python3
"""Shrinks game-page music for the media repo and works out how loud to play each track.

Reads the songs listed in data/media.js from music/ (as downloaded), re-encodes each to 96 kbps
MP3 in media/music/, and sets each track's "volume" in data/media.js so they all sit at about the
same quiet level, whatever their mastering: a track's typical loudness is measured and the volume
chosen to land it near TARGET_DB, without letting its loudest stretch pass LOUDEST_DB.

    .venv/Scripts/python tools/shrink_music.py            # every listed track
    .venv/Scripts/python tools/shrink_music.py --only doom

Needs the miniaudio, lameenc and av packages (pip install miniaudio lameenc av).
"""
import argparse
import array
import json
import math
import os
import sys

import lameenc
import miniaudio

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from refresh_stats import ROOT  # noqa: E402

MEDIA_JS = os.path.join(ROOT, 'data', 'media.js')
SRC = os.path.join(ROOT, 'music')
OUT = os.path.join(ROOT, 'media', 'music')
RATE, CHANNELS, KBPS = 44100, 2, 96
TARGET_DB = -25.6   # typical loudness after the volume, in dBFS: where Lost Odyssey sits at 25%
LOUDEST_DB = -19.0  # the loudest 3 seconds may not go past this


def read_media():
    text = open(MEDIA_JS, encoding='utf-8').read()
    start = text.index('{', text.index('RECOMPHAVEN_MEDIA'))
    return text[:start], json.loads(text[start:].rstrip().rstrip(';'))


def write_media(head, media):
    """Back to data/media.js, one game a line."""
    games = sorted(media['games'].items())
    lines = ['{', f' "base": {json.dumps(media["base"])},', ' "games": {']
    lines += [f'  {json.dumps(slug)}: {json.dumps(game, ensure_ascii=False)}' + (',' if i < len(games) - 1 else '')
              for i, (slug, game) in enumerate(games)]
    lines += [' }', '}']
    with open(MEDIA_JS, 'w', encoding='utf-8') as f:
        f.write(head + '\n'.join(lines) + ';\n')


def loudness(samples):
    """Typical and loudest-3-second loudness of 16-bit samples, in dBFS."""
    window = RATE * CHANNELS * 3
    rms = []
    for start in range(0, max(1, len(samples) - window + 1), window):
        chunk = samples[start:start + window: 7]  # every 7th sample is plenty for a level
        if chunk:
            rms.append(math.sqrt(sum(s * s for s in chunk) / len(chunk)) / 32768)
    rms = [r for r in rms if r > 1e-4] or [1e-4]
    rms.sort()
    typical = rms[len(rms) // 2]
    return 20 * math.log10(typical), 20 * math.log10(rms[-1])


def decode(src):
    """16-bit stereo samples. Some downloads named .mp3 are really AAC in MP4, which miniaudio
    can't read; PyAV (FFmpeg) reads those."""
    try:
        decoded = miniaudio.decode_file(src, output_format=miniaudio.SampleFormat.SIGNED16,
                                        nchannels=CHANNELS, sample_rate=RATE)
        return array.array('h', decoded.samples)
    except miniaudio.DecodeError:
        import av
        samples = array.array('h')
        with av.open(src) as container:
            resampler = av.AudioResampler(format='s16', layout='stereo', rate=RATE)
            frames = (f for frame in container.decode(audio=0) for f in resampler.resample(frame))
            for f in [*frames, *resampler.resample(None)]:
                samples.frombytes(bytes(f.planes[0])[: f.samples * CHANNELS * 2])
        return samples


def shrink(src, dest):
    samples = decode(src)
    enc = lameenc.Encoder()
    enc.set_bit_rate(KBPS)
    enc.set_in_sample_rate(RATE)
    enc.set_channels(CHANNELS)
    enc.set_quality(2)
    data = enc.encode(samples.tobytes()) + enc.flush()
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    with open(dest, 'wb') as f:
        f.write(data)
    return samples, len(samples) / (RATE * CHANNELS)


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--only', help='one game page slug')
    args = ap.parse_args()
    head, media = read_media()
    failed = []
    for slug, game in media['games'].items():
        track = game.get('music')
        if not track or (args.only and slug != args.only):
            continue
        src = os.path.join(SRC, track['source'])
        dest = os.path.join(OUT, track['file'])
        try:
            samples, seconds = shrink(src, dest)
        except Exception as e:  # noqa: BLE001 - one bad download shouldn't stop the rest
            failed.append(slug)
            print(f'{slug:46} FAILED: {e}', flush=True)
            continue
        typical, loudest = loudness(samples)
        volume = min(10 ** ((TARGET_DB - typical) / 20), 10 ** ((LOUDEST_DB - loudest) / 20))
        track['volume'] = round(max(0.06, min(0.6, volume)), 3)
        print(f'{slug:46} {seconds / 60:4.1f} min  {typical:6.1f} dB typical  {loudest:6.1f} dB loudest  '
              f'volume {track["volume"]:.3f}  {os.path.getsize(dest) / 1048576:.1f} MB', flush=True)
    write_media(head, media)
    print(f'Done. Couldn\'t read: {", ".join(failed)}' if failed else 'Done.')


if __name__ == '__main__':
    main()
