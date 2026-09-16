import asyncio
import contextlib
import fcntl
import functools
import logging
import multiprocessing
import os
import pickle
import tempfile
import time
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

# Scratch dir for any run_cpu_bound job that needs to hand ifcopenshell a
# real file path (ifcopenshell.open() takes a path, not bytes) — clash_check,
# ids_check, ifc/relationship_types all do this. Deliberately its own
# subdirectory rather than the shared system temp root, so cleanup_stale_temp_
# files() (below) only ever touches files this pool's own workers wrote —
# other producers of temp .ifc files (e.g. converge_mcp.py, which keeps its
# own long-lived per-session file) never collide with it.
_WORKER_TMP_DIR = os.path.join(tempfile.gettempdir(), "bim_normalizer_worker_tmp")
os.makedirs(_WORKER_TMP_DIR, exist_ok=True)


@contextlib.contextmanager
def locked_temp_file(data: bytes, suffix: str = ".ifc"):
    """
    Write `data` to a fresh temp file in _WORKER_TMP_DIR and hold an advisory
    exclusive lock (flock) on it for as long as this context manager is open
    — however long that turns out to be, since a big multi-rule clash job or
    a crash-bisected one can legitimately run well past any fixed timeout.
    flock is tied to the process's open file descriptor table, so the OS
    releases it automatically the instant the holding worker dies, segfault
    included, with no cleanup code of ours needing to run for that release to
    happen. cleanup_stale_temp_files (below) uses this: it only deletes a
    stale-looking file if it can grab the same lock itself, which tells apart
    "still genuinely in use" from "orphaned by a crash" regardless of how
    long the file has existed. Runs inside the worker process, so the lock
    naturally disappears with it on a crash — nothing to reconcile from the
    main process's side.
    """
    f = tempfile.NamedTemporaryFile(suffix=suffix, dir=_WORKER_TMP_DIR, delete=False)
    try:
        f.write(data)
        f.flush()
        fcntl.flock(f.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        yield f.name
    finally:
        f.close()
        try:
            os.unlink(f.name)
        except OSError:
            pass


def cleanup_stale_temp_files(max_age_seconds: int = 1800) -> int:
    """
    Sweep _WORKER_TMP_DIR for orphaned temp files left behind by a worker
    that segfaulted mid-job — locked_temp_file's own cleanup only runs on a
    normal exit; a native crash (ifcopenshell/ifcclash geometry code, per
    _worker_init's docstring) kills the process before that code can run,
    permanently orphaning the file (confirmed in production: one clash job
    alone left 262 files, 7.6GB). Called from run_cpu_bound itself, right
    after it detects a worker actually died (BrokenProcessPool) — that keeps
    this structural rather than something each caller of run_cpu_bound has to
    separately remember to trigger, and means it only runs when a crash
    actually happened rather than on every job.

    A file is only deleted if BOTH it's older than max_age_seconds AND this
    process can grab its flock right now — age alone isn't enough, since a
    slow-but-legitimate job can hold a file open well past this window; the
    lock is what actually proves nobody's using it. Returns the count removed.
    """
    removed = 0
    now = time.time()
    try:
        entries = list(os.scandir(_WORKER_TMP_DIR))
    except OSError:
        return 0
    for entry in entries:
        try:
            if now - entry.stat().st_mtime < max_age_seconds:
                continue
            fd = os.open(entry.path, os.O_RDONLY)
        except OSError:
            continue
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            continue  # still locked by a live worker, however long it's run
        finally:
            os.close(fd)
        try:
            os.unlink(entry.path)
            removed += 1
        except OSError:
            pass
    if removed:
        logging.getLogger(__name__).warning(
            "Worker pool: cleaned up %d orphaned temp file(s) left by a crashed worker", removed,
        )
    return removed


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
    # A worker that segfaults (confirmed: ifcopenshell's native geometry
    # code, see clash_check.py's _single_threaded_geometry_iterator) dumps
    # its full memory image to a core.<pid> file in the container's own
    # /app — not a mounted volume, so nothing ever cleans it up. One such
    # crash left behind a 1-2GB file; eight of them (accumulated silently
    # over about an hour) filled this host's entire disk and crashed
    # Postgres as collateral damage. BrokenProcessPool already handles a
    # dead worker gracefully from the app's perspective (run_cpu_bound
    # recreates the pool and retries), so the core dump itself was never
    # buying anything but disk risk — disabling it here means any future
    # native crash, from this or any other cause, degrades to "that job
    # failed and got retried" instead of "silently eat multiple GB and
    # eventually take the database down with it."
    import resource
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    from db.connection import init_pool
    init_pool()


def _noop() -> None:
    pass


def _run_job(func, args, kwargs):
    """Runs in the worker process. On exception, verifies the exception
    survives a pickle round trip before letting it propagate — some
    third-party exceptions (e.g. specklepy's SpeckleException, which
    requires a `message` positional arg it doesn't actually put in
    self.args) fail to unpickle in the parent process. That failure
    happens deep inside concurrent.futures.process's own result-handling,
    which reads it as the worker connection having died — surfacing an
    ordinary, informative error as a misleading BrokenProcessPool instead.
    Converting to a plain, always-picklable exception here preserves the
    original type and message while guaranteeing it crosses the process
    boundary intact."""
    try:
        return func(*args, **kwargs)
    except Exception as exc:
        try:
            pickle.loads(pickle.dumps(exc))
        except Exception:
            raise RuntimeError(f"{type(exc).__name__}: {exc}") from None
        raise


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
    call = functools.partial(_run_job, func, args, kwargs)
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
        # Best-effort: a dead worker may have orphaned a locked_temp_file()
        # (see its docstring). Never let a sweep problem block the retry —
        # this is strictly cleanup, not part of the actual job.
        try:
            await asyncio.to_thread(cleanup_stale_temp_files)
        except Exception:
            logging.getLogger(__name__).warning("Stale temp-file sweep after a worker crash failed", exc_info=True)
        return await loop.run_in_executor(get_process_pool(), call)
