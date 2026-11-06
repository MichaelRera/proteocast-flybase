#!/usr/bin/env python3
"""
Add "FlyBase browser extension" under the Download item of the ProteoCast website's header menu
(Django templates in Droso_GEMMEwebsite/browser/templates/browser/), plus a short section on the Download page.

    python3 site_download_menu.py <templates_dir> <out_dir> <extension_url>

Reads the templates, writes patched copies to <out_dir> (never edits in place), and prints a summary.
Refuses to write anything if a template doesn't look as expected, or is already patched.

Design: the site loads Bootstrap 4.6 with Popper 2, which Bootstrap 4 dropdowns don't support, so the submenu
is pure CSS (:hover / :focus-within). The "Download" link itself is unchanged and still opens /download, so
nothing existing breaks; touch devices that can't hover find the extension in a paragraph on the Download page.
"""
import html, os, sys

MARK = "pc-ext-menu"  # present once patched
OLD_LINK = '<a class="nav-link text-white" href="/download">Download</a>'
STYLE = """<style id="pc-ext-menu-style">/* pc-ext-menu: CSS-only submenu under Download */
  .pc-ext-menu{position:relative}
  .pc-ext-menu .pc-sub{display:none;position:absolute;left:0;top:100%;z-index:1050;min-width:15rem;padding:.35rem 0;
    background:#fff;border:1px solid rgba(0,0,0,.15);border-radius:.25rem;box-shadow:0 .25rem .75rem rgba(0,0,0,.15)}
  .pc-ext-menu:hover .pc-sub,.pc-ext-menu:focus-within .pc-sub{display:block}
  .pc-ext-menu .pc-sub a{display:block;padding:.3rem 1rem;color:#212529;white-space:nowrap;text-decoration:none}
  .pc-ext-menu .pc-sub a:hover,.pc-ext-menu .pc-sub a:focus{background:#f1f3f5}
  @media (max-width: 991px){.pc-ext-menu .pc-sub{position:static;box-shadow:none;border:0;background:transparent}
    .pc-ext-menu .pc-sub a{color:#fff;padding-left:1.5rem}}
</style>
"""


def menu(url):
    u = html.escape(url, quote=True)
    return (f'<a class="nav-link text-white" href="/download">Download</a>'
            f'<div class="pc-sub" aria-label="Download">'
            f'<a href="/download">Data &amp; code</a>'
            f'<a href="{u}" target="_blank" rel="noopener">FlyBase browser extension</a></div>')


def section(url):
    u = html.escape(url, quote=True)
    return (f'\n        <!-- {MARK}: browser extension -->\n'
            f'        <p>ProteoCast predictions for <em>Drosophila melanogaster</em> can also be viewed directly on FlyBase '
            f'protein, gene and allele pages with the <b>ProteoCast for FlyBase</b> browser extension, available on the '
            f'<a href="{u}" target=\'_blank\' rel="noopener">Chrome Web Store</a> (Chrome, Edge, Brave).</p>\n')


def patch(text, name, url):
    if MARK in text:
        raise ValueError(f"{name}: already patched")
    if text.count(OLD_LINK) != 1 or text.count("</head>") != 1:
        raise ValueError(f"{name}: expected exactly one Download link and one </head>")
    i = text.index(OLD_LINK)
    li = text.rfind("<li", 0, i)
    if li < 0 or 'class="nav-item' not in text[li:i]:
        raise ValueError(f"{name}: Download link is not inside a nav-item <li>")
    # add our class to the enclosing <li class="nav-item ...">
    text = text[:li] + text[li:i].replace('class="nav-item', f'class="nav-item {MARK}', 1) + text[i:]
    text = text.replace(OLD_LINK, menu(url), 1)
    text = text.replace("</head>", STYLE + "</head>", 1)
    if name == "download.html":
        # one more paragraph inside the page's text container, after the existing ones (the footer is
        # absolutely positioned, so content placed outside the container could end up under it)
        c = text.find('<div class="content">')
        end = text.find("</div>", text.find('<div class="container">', c)) if c >= 0 else -1
        if c < 0 or end < 0:
            raise ValueError(f"{name}: content container not found")
        text = text[:end] + section(url) + "      " + text[end:]
    return text


if __name__ == "__main__":
    src, out, url = sys.argv[1:4]
    if not url.startswith("https://"):
        sys.exit("extension URL must be https://")
    names = sorted(f for f in os.listdir(src) if f.endswith(".html") and OLD_LINK in open(os.path.join(src, f)).read())
    patched = {}
    for n in names:  # check everything before writing anything
        patched[n] = patch(open(os.path.join(src, n)).read(), n, url)
    os.makedirs(out, exist_ok=True)
    for n, t in patched.items():
        with open(os.path.join(out, n), "w") as f:
            f.write(t)
    print(f"patched {len(patched)} templates into {out}: {', '.join(names)}")
