#!/usr/bin/env python3
"""Cuts the two Korean fonts down to the characters the app draws with them.

The full fonts carry every Hangul syllable, which is two thirds of the app.
Gowun Dodum sets the body text, file names included, so it keeps the 2,350
syllables of KS X 1001 - nearly every name a person types. Gaegu sets the
headings, so it keeps what the interface's own text uses. Either way a missing
character falls back to the system's Korean font.

The originals stay in apps/macos/fonts; the subsets replace them in the app's
resources. Run it again after changing the translations, with fonttools
installed (pip install fonttools):

    python3 apps/macos/scripts/subset-fonts.py
"""
import json
import pathlib

from fontTools import subset
from fontTools.ttLib import TTFont

root = pathlib.Path(__file__).resolve().parents[3]
originals = root / "apps/macos/fonts"
resources = root / "apps/macos/Sources/LiberaUI/Resources"


def strings(node):
    if isinstance(node, dict):
        for value in node.values():
            yield from strings(value)
    elif isinstance(node, str):
        yield node


interface = {ord(character) for text in strings(json.loads((resources / "strings.json").read_text())) for character in text}
# Latin, Latin-1, punctuation, currency and arrows, wherever the font has them.
latin = set(range(0x20, 0x7F)) | set(range(0xA0, 0x100)) | set(range(0x2010, 0x2060)) | set(range(0x20A0, 0x20C0)) | set(range(0x2190, 0x2200))
jamo = set(range(0x3131, 0x318F))
# A syllable EUC-KR writes in two bytes is one of KS X 1001's; any other it
# spells out as a sequence of jamo.
ks_x_1001 = {code for code in range(0xAC00, 0xD7A4) if len(chr(code).encode("euc_kr")) == 2}

fonts = {
    "GowunDodum-Regular.ttf": latin | jamo | ks_x_1001 | interface,
    "Gaegu-Bold.ttf": latin | jamo | interface,
}

options = subset.Options()
options.layout_features = ["*"]
options.name_IDs = ["*"]
options.name_languages = ["*"]
options.name_legacy = True
options.notdef_outline = True
# Core Text draws without TrueType hinting, so the instructions are dead weight.
options.hinting = False

for name, unicodes in fonts.items():
    # The original timestamps are kept, so an unchanged run leaves no diff.
    font = TTFont(originals / name, recalcTimestamp=False)
    subsetter = subset.Subsetter(options)
    subsetter.populate(unicodes=unicodes)
    subsetter.subset(font)
    output = resources / "Fonts" / name
    font.save(output)
    before = (originals / name).stat().st_size
    print(f"{name}: {before / 1e6:.2f} MB -> {output.stat().st_size / 1e6:.2f} MB, {len(font.getGlyphOrder())} glyphs")
