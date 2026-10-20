"""Benchmark the real POST /search handler over N stored sessions.

Uses the in-memory fake database, so the numbers cover the route's own work
(filter, 384-d cosine scoring in NumPy, sort, top-k) and exclude MongoDB
network and BSON decoding time. Treat them as a lower bound.

    python scripts/bench_search.py [--sizes 100 1000 5000] [--repeats 20]
"""
import argparse
import asyncio
import random
import statistics
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import _fakedb  # noqa: E402

from backend.app.api import retrieval  # noqa: E402

DIM = 384  # all-MiniLM-L6-v2


def unit_vec(rng):
    v = [rng.gauss(0, 1) for _ in range(DIM)]
    n = sum(x * x for x in v) ** 0.5
    return [x / n for x in v]


async def run(size, repeats, rng):
    db = _fakedb.install()
    db.sessions.docs = [
        {"_id": str(i), "user_id": "u1", "intent": f"session {i}", "started_at": None,
         "tab_count": 5, "window_count": 1, "embedding": unit_vec(rng)}
        for i in range(size)
    ]
    body = retrieval.SearchRequest(vector=unit_vec(rng), limit=5)
    await retrieval.search_sessions(body, current_user_id="u1")  # warm-up
    times = []
    for _ in range(repeats):
        t0 = time.perf_counter()
        await retrieval.search_sessions(body, current_user_id="u1")
        times.append((time.perf_counter() - t0) * 1000)
    times.sort()
    return statistics.median(times), times[min(len(times) - 1, int(len(times) * 0.95))]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--sizes", type=int, nargs="+", default=[100, 1000, 5000])
    ap.add_argument("--repeats", type=int, default=20)
    args = ap.parse_args()
    rng = random.Random(42)

    print(f"POST /search, {DIM}-d embeddings, {args.repeats} runs each")
    print(f"{'sessions':>9} | {'median ms':>9} | {'p95 ms':>8}")
    for size in args.sizes:
        med, p95 = asyncio.run(run(size, args.repeats, rng))
        print(f"{size:>9} | {med:>9.2f} | {p95:>8.2f}")


if __name__ == "__main__":
    main()
