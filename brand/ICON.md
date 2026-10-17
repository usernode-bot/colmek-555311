# colmek icons

The app icon and the featured icons for the Homeroom directory. One mark,
three renders, following the [Homeroom brand framework](https://baked.design/brand/homeroom/):
one bold mark on a rounded-square tile, flat, no text, no gradient, no shadow.

## The mark

Lucide's **`trending-up`** glyph (ISC licence): a rising chart line ending in a
bold upward arrow. Drawn on the 24-unit grid, stroke-width 2, round caps and
joins:

```
<polyline points="22 7 13.5 15.5 8.5 10.5 2 17"/>
<polyline points="16 7 22 7 22 13"/>
```

## Colours

Only the brand's **Cream + Black** pairing:

- Cream `#FFFEEA`
- Black `#000000`

Edge pixels of the stroke are blends of these two colours only (antialiasing).

## Files

| File | Size | Tile | Mark | Placement |
| --- | --- | --- | --- | --- |
| `icon.png` | 1024 × 1024, opaque RGB, square corners (the platform tile rounds it) | Black, full bleed | Cream | `translate(224 224) scale(24)`: glyph in the middle 576 px, 224 px margin |
| `featured-light.png` | 1200 × 1200, transparent RGBA outside the tile | Black rounded square, corner radius 268 px | Cream | `translate(240 240) scale(30)`: glyph in the middle 720 px |
| `featured-dark.png` | 1200 × 1200, transparent RGBA outside the tile | Cream rounded square, corner radius 268 px | Black | same as light |

`icon.svg` is the source for `icon.png` (the featured pair are the same group
at scale 30 on a rounded square). SVG is not accepted by `dapp.json`, which
references `icon.png` with the 📈 emoji kept as fallback.

## Re-rendering

With `rsvg-convert`:

```sh
rsvg-convert -w 1024 -h 1024 brand/icon.svg -o brand/icon.png
```

The sandbox this repo is built in has no SVG rasteriser, so the committed PNGs
were produced by a throwaway stdlib-only Python rasteriser (4 × 4 subsamples
per pixel, distance-to-segment for the stroked mark, distance-to-corner-centre
for the rounded tile). `icon.svg` is the authoritative geometry either way.
