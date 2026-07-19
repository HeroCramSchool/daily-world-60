#!/usr/bin/env python3
"""Subject cutout via rembg (u2net). Usage: python3 cutout.py <in.jpg> <out.png>

Produces a transparent-background foreground PNG used as the parallax layer.
Model (~176MB) caches at ~/.u2net after first run.
"""
import sys

from PIL import Image
from rembg import remove

src, dst = sys.argv[1], sys.argv[2]
img = Image.open(src)
out = remove(img)
out.save(dst)
print(f"[cutout] {dst} {out.size}")
