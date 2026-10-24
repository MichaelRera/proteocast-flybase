import sys
from PIL import Image, ImageDraw, ImageFont, ImageFilter
raw, out, icon = sys.argv[1], sys.argv[2], sys.argv[3]
B = ImageFont.truetype("/usr/share/fonts/truetype/ubuntu/Ubuntu-B.ttf", 34)
R = ImageFont.truetype("/usr/share/fonts/truetype/ubuntu/Ubuntu-R.ttf", 20)
NAVY, BG = (31, 59, 115), (238, 242, 248)
SHOTS = [  # (raw file, crop box in the 968x781 browser capture, title, subtitle) — version 0.3.0 captures
    ("raw_allele.jpg", (0, 70, 968, 572), "See what an allele does to the protein",
     "Allele pages: the change is classified and marked on the track; hover a residue for its 19 substitutions, coloured by score as in the paper."),
    ("raw_protein.jpg", (0, 80, 968, 582), "Classify any missense variant in one line",
     "Type G202R or Gly202Arg: impactful, mild or neutral, with its score. Drag on the track to zoom into a stretch of the sequence."),
    ("raw_gene.jpg", (0, 70, 968, 572), "Mutational sensitivity for every isoform",
     "Gene pages: per-residue sensitivity in blue, with domains and alignment confidence, for each isoform of the gene."),
]
for n, (f, box, title, sub) in enumerate(SHOTS, 1):
    im = Image.new("RGB", (1280, 800), BG); d = ImageDraw.Draw(im)
    d.rectangle([0, 0, 1280, 150], fill=NAVY)
    d.text((48, 34), title, font=B, fill="white")
    # wrap subtitle to the band width
    words, line, lines = sub.split(), "", []
    for w in words:
        t = (line + " " + w).strip()
        if d.textlength(t, font=R) > 1180: lines.append(line); line = w
        else: line = t
    lines.append(line)
    for k, l in enumerate(lines[:2]): d.text((48, 86 + k * 26), l, font=R, fill=(214, 224, 240))
    shot = Image.open(f"{raw}/{f}").convert("RGB").crop(box)          # native pixels, no scaling
    x, y = (1280 - shot.width) // 2, 150 + (650 - shot.height) // 2
    shadow = Image.new("RGBA", (shot.width + 40, shot.height + 40), (0, 0, 0, 0))
    ImageDraw.Draw(shadow).rectangle([20, 20, shot.width + 20, shot.height + 20], fill=(0, 0, 0, 70))
    im.paste(shadow.filter(ImageFilter.GaussianBlur(10)), (x - 20, y - 14), shadow.filter(ImageFilter.GaussianBlur(10)))
    im.paste(shot, (x, y))
    im.save(f"{out}/screenshot-{n}.png")
# small promo tile 440x280
t = Image.new("RGB", (440, 280), NAVY); d = ImageDraw.Draw(t)
ic = Image.open(icon).convert("RGBA").resize((96, 96), Image.LANCZOS); t.paste(ic, (172, 34), ic)
for text, font, y in (("ProteoCast for FlyBase", ImageFont.truetype("/usr/share/fonts/truetype/ubuntu/Ubuntu-B.ttf", 30), 150),
                      ("Missense-variant predictions", ImageFont.truetype("/usr/share/fonts/truetype/ubuntu/Ubuntu-R.ttf", 19), 200),
                      ("right on FlyBase pages", ImageFont.truetype("/usr/share/fonts/truetype/ubuntu/Ubuntu-R.ttf", 19), 226)):
    d.text(((440 - d.textlength(text, font=font)) / 2, y), text, font=font, fill="white" if y == 150 else (214, 224, 240))
t.save(f"{out}/promo-small-440x280.png")
