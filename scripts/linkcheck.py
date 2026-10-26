#!/usr/bin/env python3
"""Check relative links, image paths and GitHub-style #anchors in Markdown files.

Usage: python3 scripts/linkcheck.py <root> <file-or-dir>... [--external]

Directories are scanned recursively for *.md. Exits 1 if any link is broken.
--external also requests every http(s) link (skips localhost and example domains);
it is opt-in because remote sites rate-limit and flake in CI.
"""
import os
import re
import sys
import urllib.error
import urllib.request

LINK_RE = re.compile(r'\]\(([^)\s]+)\)')
HREF_RE = re.compile(r'href="([^"]+)"')
# Images in HTML (<img src>, <picture><source srcset>): the first URL of the attribute.
SRC_RE = re.compile(r'\b(?:src|srcset)="([^"\s]+)')
# Placeholder hosts used in examples, plus sites that answer bots with 403 (npm, CF dashboard).
# Files of this repository referenced by absolute URL (the README's images, so they also show on
# npmjs.com, where docs/images isn't in the package): checked against the local tree like relative links.
OWN_RAW = 'https://raw.githubusercontent.com/teenybase/teenybase/main/'
SKIP_HOSTS = re.compile(r'^https?://([^/]*\.)?(localhost|127\.0\.0\.1|example\.com|myapp\.com|my-app\.com|yourdomain\.com|provider\.com|npmjs\.com|dash\.cloudflare\.com)([:/]|$)')


def slug(heading):
    h = heading.strip().lower()
    h = re.sub(r'[^\w\- ]', '', h)
    return h.replace(' ', '-')


_anchor_cache = {}


def anchors(path):
    if path in _anchor_cache:
        return _anchor_cache[path]
    out, seen, in_code = set(), {}, False
    with open(path, encoding='utf-8') as fh:
        for line in fh:
            if line.lstrip().startswith('```'):
                in_code = not in_code
                continue
            m = re.match(r'#{1,6} (.*)', line)
            if in_code or not m:
                continue
            s = slug(m.group(1).replace('`', ''))
            n = seen.get(s, 0)
            out.add(s if n == 0 else f'{s}-{n}')
            seen[s] = n + 1
    _anchor_cache[path] = out
    return out


def md_files(paths):
    for p in paths:
        if os.path.isdir(p):
            for d, _, names in os.walk(p):
                for n in sorted(names):
                    if n.endswith('.md'):
                        yield os.path.join(d, n)
        else:
            yield p


def links(path):
    with open(path, encoding='utf-8') as fh:
        txt = fh.read()
    return LINK_RE.findall(txt) + HREF_RE.findall(txt) + SRC_RE.findall(txt)


def check_url(url):
    req = urllib.request.Request(url, method='GET', headers={'User-Agent': 'teenybase-linkcheck'})
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            return r.status
    except urllib.error.HTTPError as e:
        return e.code
    except Exception as e:  # network errors are reported, not fatal per link
        return str(e)


def main(argv):
    external = '--external' in argv
    args = [a for a in argv if a != '--external']
    if len(args) < 2:
        print(__doc__)
        return 2
    root, targets = args[0], args[1:]
    bad, checked = [], 0
    for f in md_files(targets):
        rel = os.path.relpath(f, root)
        for link in links(f):
            checked += 1
            if link.startswith('mailto:'):
                continue
            if link.startswith(OWN_RAW):
                tgt = os.path.normpath(os.path.join(root, link[len(OWN_RAW):].split('#')[0]))
                if not os.path.exists(tgt):
                    bad.append(f'MISSING {rel} -> {link}')
                continue
            if link.startswith(('http://', 'https://')):
                if external and not SKIP_HOSTS.match(link):
                    status = check_url(link)
                    if status != 200:
                        bad.append(f'HTTP {status} {rel} -> {link}')
                continue
            path, _, anchor = link.partition('#')
            tgt = os.path.normpath(os.path.join(os.path.dirname(f), path)) if path else f
            if not os.path.exists(tgt):
                bad.append(f'MISSING {rel} -> {link}')
            elif anchor and tgt.endswith('.md') and anchor not in anchors(tgt):
                bad.append(f'BADANCHOR {rel} -> {link}')
    for b in bad:
        print(b)
    print(f'linkcheck: {checked} links, {len(bad)} broken')
    return 1 if bad else 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
