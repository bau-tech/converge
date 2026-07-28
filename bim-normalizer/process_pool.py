import asyncio
import functools
import logging
import multiprocessing
import os
from concurrent.futures import ProcessPoolExecutor
from concurrent.futures.process import BrokenProcessPool

# CPU-bound IFC work (ingest, export, clash/IDS checks — ifcopenshell/numpy)
# used to run via asyncio.to_thread, which only ever uses threads. Threads
# share one GIL, so two concurrent CPU-heavy jobs in the same process don't
# parallelize — they serialize and add overhead: a real ingest measured at
# 54s alone took 270s running alongside a second concurrent ingest. A
# process pool sidesteps the GIL by giving each job its own interpreter.
#
# 'spawn' (not the Linux default 'fork') so worker processes start with a
# clean interpreter instead of inheriting this process's live DB connections
# and thread locks, which are not safe to share across a fork.

_pool: ProcessPoolExecutor | None = None


def _worker_init() -> None:
    """Runs once in each fresh worker process — a spawned interpreter has
    neither this process's logging config nor its DB connection pool.
    Deliberately does NOT warm up the embedding model (search/embeddings.py) —
    that used to happen eagerly here, but it means every worker permanently
    carries its own loaded-model memory whether or not that worker ever
    handles an ingest, tripling the model's footprint for no benefit. Left
    lazy instead: the existing singleton in search/embeddings.py loads it on
    first real use, same as the main process already does for semantic
    search (routers/elements.py calls it directly, no warm-up there either)."""
    log_level = getattr(logging, (os.getenv("LOG_LEVEL") or "INFO").upper(), logging.INFO)
    logging.basicConfig(
        level=log_level,
        format="%(asctime)s %(levelname)s %(name)s — %(message)s",
    )
    from db.connection import init_pool
    init_pool()


def _noop() -> None:
    pass


def init_process_pool() -> None:
    global _pool
    if _pool is not None:
        return
    ctx = multiprocessing.get_context("spawn")
    # Two fewer than total cores: one headroom core for the event loop
    # (request handling, DB I/O, health checks), and the pool itself is
    # sized for this host's actual constraint — memory, not CPU. Each worker
    # can independently balloon to several GB processing a large model
    # (specklepy's operations.receive() materializes a whole commit's object
    # tree — meshes included — in memory at once, before any per-element
    # processing starts), and this host runs alongside ~30 other LXCs
    # sharing the same physical RAM with little slack. Fewer concurrent
    # workers directly caps how many of those multi-GB spikes can stack at
    # once; it costs queuing (not slowdown — see run_cpu_bound) only when 3+
    # CPU-bound jobs land at the same moment, which this deployment's usage
    # doesn't see in practice.
    workers = max(1, (os.cpu_count() or 2) - 2)
    _pool = ProcessPoolExecutor(max_workers=workers, mp_context=ctx, initializer=_worker_init)
    # ProcessPoolExecutor starts workers lazily on first task by default —
    # force every worker to actually start now (paying its one-time
    # _worker_init cost during app boot) rather than on whichever user's job
    # first reaches a cold worker.
    for _ in range(workers):
        _pool.submit(_noop)


def get_process_pool() -> ProcessPoolExecutor:
    if _pool is None:
        init_process_pool()
    return _pool


def close_process_pool() -> None:
    global _pool
    if _pool is not None:
        _pool.shutdown(wait=False, cancel_futures=True)
        _pool = None


async def run_cpu_bound(func, *args, **kwargs):
    """Run a CPU-heavy function with picklable args/return value in the
    shared process pool instead of a thread — see module docstring.

    A worker dying abruptly (OOM-killed, segfault, ...) leaves the pool
    itself unusable — every future already in flight on it, and by default
    every future submitted afterwards, raises BrokenProcessPool forever,
    since ProcessPoolExecutor doesn't self-heal. Without this catch, that
    turned one OOM'd worker into "ingest is broken until someone restarts the
    container." Caught here instead: tear down and recreate the pool, then
    retry the call exactly once against the fresh pool — a second
    BrokenProcessPool (or any other exception) propagates normally rather
    than looping. The retried call re-does whatever work the dead worker had
    in progress; it does not resume it, since a crashed worker can't hand
    back partial state."""
    loop = asyncio.get_running_loop()
    call = functools.partial(func, *args, **kwargs)
    _log = logging.getLogger(__name__)
    _log.info("DIAG: run_cpu_bound submitting %s", getattr(func, "__name__", func))
    try:
        result = await loop.run_in_executor(get_process_pool(), call)
        _log.info("DIAG: run_cpu_bound got result for %s: %r", getattr(func, "__name__", func), result)
        return result
    except BrokenProcessPool:
        logging.getLogger(__name__).warning(
            "Process pool broken (a worker died) — recreating and retrying once"
        )
        close_process_pool()
        return await loop.run_in_executor(get_process_pool(), call)
