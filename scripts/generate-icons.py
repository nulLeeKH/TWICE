"""Generate TWICE's local wave mark with Python's standard library."""
from pathlib import Path
import math
import struct
import zlib


def chunk(kind, data):
    return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data))


def icon(size):
    pixels = bytearray()
    samples = 4
    for py in range(size):
        pixels.append(0)  # PNG filter: none
        for px in range(size):
            rgba = [0, 0, 0, 0]
            for sy in range(samples):
                for sx in range(samples):
                    x = (px + (sx + .5) / samples) / size
                    y = (py + (sy + .5) / samples) / size
                    dx = max(.2 - x, 0, x - .8)
                    dy = max(.2 - y, 0, y - .8)
                    color = (15, 17, 21, 255) if dx * dx + dy * dy <= .2 ** 2 else (0, 0, 0, 0)
                    if .23 <= x <= .77:
                        wave = .045 * math.sin((x - .23) / .54 * math.tau)
                        if min(abs(y - (.38 + wave)), abs(y - (.60 + wave))) < .028:
                            color = (61, 214, 196, 255)
                    for i, value in enumerate(color):
                        rgba[i] += value
            pixels.extend(round(value / samples ** 2) for value in rgba)
    header = struct.pack('>IIBBBBB', size, size, 8, 6, 0, 0, 0)
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', header) + chunk(b'IDAT', zlib.compress(pixels, 9)) + chunk(b'IEND', b'')


if __name__ == '__main__':
    folder = Path(__file__).resolve().parents[1] / 'public' / 'icons'
    folder.mkdir(parents=True, exist_ok=True)
    for size in (16, 32, 48, 128):
        (folder / f'{size}.png').write_bytes(icon(size))
