#!/usr/bin/env python3
"""Push samples from local Discord / Reddit dumps into a Lead-Harness blitz project.

Reads the same JSON shapes the discord-scraper repo produces:
  - Discord: DiscordChatExporter export (single object with {guild, channel, messages: [...]})
  - Reddit:  reddit_scraper output (list of posts or {posts: [...]})

Pushes batches to POST /ingest, then triggers POST /score. All state lives on blitz.

Usage:
  export INGEST_TOKEN=...   # the project secret you set via $BASE/secrets/INGEST_TOKEN
  export BLITZ_BASE=https://your-slug.app.blitz.dev
  python3 push_samples.py path/to/discord_export.json path/to/reddit_dump.json
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Iterable


UA = "lead-harness-scraper/0.1 (+https://github.com/teenybase/teenybase)"


def jpost(url: str, token: str, body: dict[str, Any] | None = None, timeout: int = 60) -> dict[str, Any]:
    data = json.dumps(body or {}).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=data,
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
            "User-Agent": UA,
            "Accept": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace")[:500]
        raise SystemExit(f"HTTP {e.code} from {url}: {body}") from e
    except urllib.error.URLError as e:
        raise SystemExit(f"network error to {url}: {e}") from e


def discord_samples(path: Path) -> Iterable[dict[str, Any]]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict) or "messages" not in payload:
        return
    guild = (payload.get("guild") or {}).get("name") or "unknown"
    channel = (payload.get("channel") or {}).get("name") or "unknown"
    for m in payload.get("messages", []):
        content = (m.get("content") or "").strip()
        if not content:
            continue
        author = (m.get("author") or {}).get("name") or "unknown"
        yield {
            "external_id": f"discord:{guild}:{channel}:{m.get('id')}",
            "source": "discord",
            "channel": f"{guild}/{channel}",
            "author": author,
            "permalink": "",
            "title": "",
            "body": content,
            "links": [],
            "meta": {"guild": guild, "channel": channel, "raw_id": m.get("id")},
            "source_ts": m.get("timestamp") or "",
        }


def reddit_samples(path: Path) -> Iterable[dict[str, Any]]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    if isinstance(payload, dict) and isinstance(payload.get("posts"), list):
        posts = payload["posts"]
    elif isinstance(payload, list):
        posts = payload
    else:
        return
    for p in posts:
        title = (p.get("title") or "").strip()
        body = (p.get("body") or p.get("selftext") or "").strip()
        if not title and not body:
            continue
        subreddit = str(p.get("subreddit") or "unknown")
        yield {
            "external_id": f"reddit:{subreddit}:{p.get('id')}",
            "source": "reddit",
            "channel": f"r/{subreddit}",
            "author": str(p.get("author") or "unknown"),
            "permalink": str(p.get("permalink") or ""),
            "title": title,
            "body": body,
            "links": list(p.get("links") or []),
            "meta": {
                "subreddit": subreddit,
                "reddit_score": int(p.get("score") or 0),
                "num_comments": int(p.get("num_comments") or 0),
            },
            "source_ts": str(p.get("created_utc") or ""),
        }


def samples_from(path: Path) -> Iterable[dict[str, Any]]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    if isinstance(payload, dict) and "messages" in payload:
        yield from discord_samples(path)
    elif isinstance(payload, dict) and "posts" in payload:
        yield from reddit_samples(path)
    elif isinstance(payload, list):
        yield from reddit_samples(path)
    else:
        print(f"skipping {path}: unrecognized shape", file=sys.stderr)


def batched(it: Iterable[dict[str, Any]], n: int) -> Iterable[list[dict[str, Any]]]:
    buf: list[dict[str, Any]] = []
    for item in it:
        buf.append(item)
        if len(buf) >= n:
            yield buf
            buf = []
    if buf:
        yield buf


def main() -> None:
    p = argparse.ArgumentParser(description="Push scraper JSON dumps into a Lead-Harness blitz project")
    p.add_argument("paths", nargs="+", help="JSON files: Discord exports or Reddit dumps")
    p.add_argument("--base", default=os.environ.get("BLITZ_BASE", "").rstrip("/"))
    p.add_argument("--token", default=os.environ.get("INGEST_TOKEN", ""))
    p.add_argument("--batch", type=int, default=40)
    p.add_argument("--no-score", action="store_true", help="Skip the POST /score step")
    p.add_argument("--full-score", action="store_true", help="Re-score every sample even if already scored")
    p.add_argument("--llm", action="store_true", help="Use LLM scoring (requires OPENROUTER_API_KEY secret on project)")
    args = p.parse_args()

    if not args.base or not args.token:
        raise SystemExit("set BLITZ_BASE and INGEST_TOKEN env vars (or --base/--token)")

    total_in = total_skip = 0
    for raw in args.paths:
        path = Path(raw)
        if not path.exists():
            print(f"missing: {path}", file=sys.stderr)
            continue
        all_samples = list(samples_from(path))
        if not all_samples:
            print(f"empty: {path}")
            continue
        for batch in batched(iter(all_samples), args.batch):
            r = jpost(f"{args.base}/ingest", args.token, {"samples": batch})
            total_in += int(r.get("inserted") or 0)
            total_skip += int(r.get("skipped") or 0)
            print(f"{path.name}: inserted={r.get('inserted')} skipped={r.get('skipped')} errors={r.get('total_errors')}")

    print(f"\ntotal_inserted={total_in} total_skipped={total_skip}")

    if not args.no_score:
        # /score is capped at 45 samples per call (Workers subrequest limit).
        # Loop until the worker reports it scored zero rows.
        q = []
        if args.full_score:
            q.append("full=1")
        if args.llm:
            q.append("llm=1")
        suffix = ("?" + "&".join(q)) if q else ""
        total_scored = 0
        for i in range(50):
            r = jpost(f"{args.base}/score{suffix}", args.token, {})
            n = int(r.get("scored") or 0)
            total_scored += n
            print(f"scored: {r}")
            if n == 0:
                break
        print(f"total_scored={total_scored}")


if __name__ == "__main__":
    main()
