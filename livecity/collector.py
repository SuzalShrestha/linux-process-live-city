"""Process sampling for Process City.

A background thread samples every process on the machine at a fixed
interval and keeps the latest snapshot in memory; HTTP handlers only read
that snapshot. Deep per-process details are gathered on demand.

Everything here is best-effort: on both Linux and macOS a normal user can't
read every attribute of every process (other users' environ, open files,
etc.), so each field is fetched independently and failures are reported
back instead of aborting the whole request.
"""

from __future__ import annotations

import collections
import enum
import os
import platform
import signal as _signal
import socket
import sys
import threading
import time

import psutil

IS_LINUX = sys.platform.startswith("linux")
IS_MAC = sys.platform == "darwin"

HISTORY_LEN = 120  # samples kept per process for sparklines

# Attributes sampled for every process on every tick. Kept deliberately
# cheap; expensive things (open files, connections, maps) live in details().
_SNAPSHOT_ATTRS = [
    "pid",
    "ppid",
    "name",
    "username",
    "status",
    "create_time",
    "num_threads",
    "nice",
    "memory_info",
    "cpu_percent",
    "cmdline",
    "num_ctx_switches",
]
if hasattr(psutil.Process, "num_fds"):
    _SNAPSHOT_ATTRS.append("num_fds")
if hasattr(psutil.Process, "io_counters"):
    _SNAPSHOT_ATTRS.append("io_counters")

SIGNALS = {
    "TERM": _signal.SIGTERM,
    "KILL": _signal.SIGKILL,
    "INT": _signal.SIGINT,
    "HUP": _signal.SIGHUP,
    "STOP": _signal.SIGSTOP,
    "CONT": _signal.SIGCONT,
}


def _nt(value):
    """Convert psutil namedtuples (and lists of them) to plain JSON data."""
    if value is None:
        return None
    if isinstance(value, enum.Enum):  # before int: IntEnums are ints too
        return value.name
    if hasattr(value, "_asdict"):
        return {k: _nt(v) for k, v in value._asdict().items()}
    if isinstance(value, (list, tuple)):
        return [_nt(v) for v in value]
    if isinstance(value, (bytes, bytearray)):
        return value.decode("utf-8", "replace")
    if isinstance(value, (int, float, str, bool, dict)):
        return value
    # Enums (socket family/type, psutil.Status...) and anything else.
    name = getattr(value, "name", None)
    return name if isinstance(name, str) else str(value)


def _is_kernel(pid, ppid, name):
    if IS_LINUX:
        return pid == 2 or ppid == 2
    if IS_MAC:
        return pid == 0 or name == "kernel_task"
    return False


class Collector:
    def __init__(self, interval: float = 1.5):
        self.interval = max(0.25, float(interval))
        self._lock = threading.Lock()
        self._procs: dict[int, psutil.Process] = {}
        self._warned: set[int] = set()
        self._io_prev: dict[int, tuple[float, int, int]] = {}
        self._history: dict[int, collections.deque] = {}
        self._sys_history: collections.deque = collections.deque(maxlen=HISTORY_LEN)
        self._net_prev = None
        self._disk_prev = None
        self._snapshot: dict | None = None
        self._seq = 0
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self.self_pid = os.getpid()
        psutil.cpu_percent(percpu=True)  # prime system-wide counters

    # ------------------------------------------------------------------ loop
    def start(self):
        self.sample()
        self._thread = threading.Thread(target=self._run, name="sampler", daemon=True)
        self._thread.start()

    def stop(self):
        self._stop.set()

    def _run(self):
        while not self._stop.wait(self.interval):
            try:
                self.sample()
            except Exception as exc:  # never let the sampler die
                print(f"[livecity] sample failed: {exc!r}", file=sys.stderr)

    def snapshot(self) -> dict | None:
        with self._lock:
            return self._snapshot

    # -------------------------------------------------------------- sampling
    def _process(self, pid: int) -> psutil.Process:
        """Return a cached Process, replacing it if the pid was reused."""
        proc = self._procs.get(pid)
        if proc is not None and proc.is_running():
            return proc
        proc = psutil.Process(pid)
        self._procs[pid] = proc
        return proc

    def _row(self, proc: psutil.Process, now: float) -> dict:
        with proc.oneshot():
            d = proc.as_dict(attrs=_SNAPSHOT_ATTRS, ad_value=None)
        mem = d.pop("memory_info")
        ctx = d.pop("num_ctx_switches")
        io = d.pop("io_counters", None)
        cmd = d.pop("cmdline")
        pid = d["pid"]

        d["rss"] = mem.rss if mem else None
        d["vms"] = mem.vms if mem else None
        d["ctx"] = (ctx.voluntary + ctx.involuntary) if ctx else None
        d["cmd"] = " ".join(cmd)[:400] if cmd else ""
        d.setdefault("num_fds", None)
        d["cpu_percent"] = round(d["cpu_percent"] or 0.0, 2)
        d["kernel"] = _is_kernel(pid, d["ppid"], d["name"])
        d["denied"] = mem is None

        # Disk IO rate (bytes/s) from the delta against the previous tick.
        d["io_read"] = d["io_write"] = None
        if io is not None:
            rb = getattr(io, "read_bytes", 0)
            wb = getattr(io, "write_bytes", 0)
            prev = self._io_prev.get(pid)
            if prev is not None and now > prev[0]:
                dt = now - prev[0]
                d["io_read"] = max(0.0, (rb - prev[1]) / dt)
                d["io_write"] = max(0.0, (wb - prev[2]) / dt)
            self._io_prev[pid] = (now, rb, wb)

        hist = self._history.get(pid)
        if hist is None:
            hist = self._history[pid] = collections.deque(maxlen=HISTORY_LEN)
        hist.append((round(now, 2), d["cpu_percent"], d["rss"]))
        return d

    def sample(self) -> dict:
        now = time.time()
        rows = []
        alive = set()
        for pid in psutil.pids():
            try:
                proc = self._process(pid)
                rows.append(self._row(proc, now))
                alive.add(pid)
            except psutil.ZombieProcess:
                # Zombies can't be queried but are worth showing.
                alive.add(pid)
                rows.append(self._zombie_row(pid))
            except (psutil.NoSuchProcess, psutil.AccessDenied, ProcessLookupError):
                continue
            except Exception as exc:  # platform quirks (e.g. raw OSError on macOS)
                if pid not in self._warned:
                    self._warned.add(pid)
                    print(f"[livecity] skipping pid {pid}: {exc!r}", file=sys.stderr)
                continue

        for table in (self._procs, self._io_prev, self._history):
            for pid in [p for p in table if p not in alive]:
                del table[pid]

        system = self._system(now, len(rows), sum(r["num_threads"] or 0 for r in rows))
        with self._lock:
            self._seq += 1
            self._snapshot = {
                "seq": self._seq,
                "time": now,
                "interval": self.interval,
                "system": system,
                "processes": rows,
            }
            return self._snapshot

    def _zombie_row(self, pid):
        ppid = None
        name = "<zombie>"
        try:
            p = psutil.Process(pid)
            ppid = p.ppid()
            name = p.name()
        except Exception:
            pass
        return {
            "pid": pid, "ppid": ppid, "name": name, "username": None,
            "status": "zombie", "create_time": None, "num_threads": 0,
            "nice": None, "cpu_percent": 0.0, "rss": 0, "vms": 0, "ctx": None,
            "cmd": "", "num_fds": None, "kernel": False, "denied": True,
            "io_read": None, "io_write": None,
        }

    def _system(self, now, nprocs, nthreads) -> dict:
        percpu = psutil.cpu_percent(percpu=True)
        total = sum(percpu) / len(percpu) if percpu else 0.0
        vm = psutil.virtual_memory()
        sw = psutil.swap_memory()
        try:
            load = os.getloadavg()
        except (AttributeError, OSError):
            load = None

        net = disk = None
        try:
            n = psutil.net_io_counters()
            if self._net_prev is not None and now > self._net_prev[0]:
                dt = now - self._net_prev[0]
                net = {
                    "sent": max(0.0, (n.bytes_sent - self._net_prev[1]) / dt),
                    "recv": max(0.0, (n.bytes_recv - self._net_prev[2]) / dt),
                }
            self._net_prev = (now, n.bytes_sent, n.bytes_recv)
        except Exception:
            pass
        try:
            dio = psutil.disk_io_counters()
            if dio is not None:
                if self._disk_prev is not None and now > self._disk_prev[0]:
                    dt = now - self._disk_prev[0]
                    disk = {
                        "read": max(0.0, (dio.read_bytes - self._disk_prev[1]) / dt),
                        "write": max(0.0, (dio.write_bytes - self._disk_prev[2]) / dt),
                    }
                self._disk_prev = (now, dio.read_bytes, dio.write_bytes)
        except Exception:
            pass

        self._sys_history.append((round(now, 2), round(total, 1), vm.percent))
        return {
            "hostname": socket.gethostname(),
            "os": f"{platform.system()} {platform.release()}",
            "platform": sys.platform,
            "boot_time": psutil.boot_time(),
            "cpu_count": psutil.cpu_count() or len(percpu),
            "cpu_percent": round(total, 1),
            "per_cpu": percpu,
            "load": load,
            "mem_total": vm.total,
            "mem_used": vm.total - vm.available,
            "mem_percent": vm.percent,
            "swap_total": sw.total,
            "swap_used": sw.used,
            "net": net,
            "disk": disk,
            "processes": nprocs,
            "threads": nthreads,
            "self_pid": self.self_pid,
            "history": list(self._sys_history),
        }

    # --------------------------------------------------------------- details
    def details(self, pid: int) -> dict:
        """Everything we can find out about one process."""
        proc = psutil.Process(pid)  # raises NoSuchProcess
        out: dict = {"pid": pid}
        errors: dict[str, str] = {}

        def grab(key, fn, convert=_nt):
            try:
                out[key] = convert(fn())
            except psutil.AccessDenied:
                errors[key] = "access denied"
            except psutil.ZombieProcess:
                errors[key] = "zombie process"
            except psutil.NoSuchProcess:
                raise
            except (NotImplementedError, AttributeError):
                errors[key] = "not supported on this platform"
            except Exception as exc:  # pragma: no cover - platform quirks
                errors[key] = f"{type(exc).__name__}: {exc}"

        cached = self._procs.get(pid)
        grab("name", proc.name)
        grab("exe", proc.exe)
        grab("cmdline", proc.cmdline)
        grab("cwd", proc.cwd)
        grab("username", proc.username)
        grab("status", proc.status)
        grab("create_time", proc.create_time)
        grab("ppid", proc.ppid)
        grab("terminal", proc.terminal)
        grab("nice", proc.nice)
        grab("uids", proc.uids)
        grab("gids", proc.gids)
        grab("num_threads", proc.num_threads)
        grab("cpu_times", proc.cpu_times)
        grab("num_ctx_switches", proc.num_ctx_switches)
        grab("memory_info", proc.memory_info)
        grab("memory_full_info", proc.memory_full_info)
        grab("memory_percent", lambda: round(proc.memory_percent(), 3))
        if cached is not None:
            grab("cpu_percent", lambda: round(cached.cpu_percent(None), 2))
        for opt in ("num_fds", "io_counters", "ionice", "cpu_affinity", "cpu_num", "environ"):
            if hasattr(proc, opt):
                grab(opt, getattr(proc, opt))
        grab("threads", proc.threads)

        # psutil >= 6 renamed connections() to net_connections().
        conns = getattr(proc, "net_connections", None) or getattr(proc, "connections")
        grab("connections", lambda: conns(kind="all"))

        grab("open_files", proc.open_files)

        if hasattr(proc, "memory_maps"):
            def maps():
                rows = [_nt(m) for m in proc.memory_maps(grouped=True)]
                rows.sort(key=lambda m: m.get("rss") or 0, reverse=True)
                return rows[:300]
            grab("memory_maps", maps, convert=lambda x: x)

        grab("parents", lambda: [{"pid": p.pid, "name": _safe_name(p)} for p in proc.parents()],
             convert=lambda x: x)
        grab("children", lambda: [
            {"pid": c.pid, "name": _safe_name(c)} for c in proc.children(recursive=False)
        ], convert=lambda x: x)

        if hasattr(proc, "rlimit"):
            grab("rlimits", lambda: _rlimits(proc), convert=lambda x: x)

        if IS_LINUX:
            out["linux"] = _linux_extras(pid)

        with self._lock:
            hist = self._history.get(pid)
            out["history"] = list(hist) if hist else []
        out["errors"] = errors
        out["is_self"] = pid == self.self_pid
        return out

    def send_signal(self, pid: int, name: str):
        sig = SIGNALS.get(name.upper())
        if sig is None:
            raise ValueError(f"unsupported signal {name!r}")
        if pid <= 1 or pid == self.self_pid:
            raise PermissionError("refusing to signal this process")
        psutil.Process(pid).send_signal(sig)


def _safe_name(p):
    try:
        return p.name()
    except psutil.Error:
        return "?"


def _rlimits(proc):
    out = {}
    for attr in dir(psutil):
        if attr.startswith("RLIMIT_"):
            try:
                soft, hard = proc.rlimit(getattr(psutil, attr))
            except (psutil.Error, OSError, ValueError):
                continue
            out[attr[7:].lower()] = [soft, hard]
    return out


def _read(path, limit=64 * 1024):
    try:
        with open(path, "r", errors="replace") as f:
            return f.read(limit)
    except OSError:
        return None


def _linux_extras(pid) -> dict:
    """Bits of /proc that psutil doesn't expose."""
    base = f"/proc/{pid}"
    status = {}
    for line in (_read(f"{base}/status") or "").splitlines():
        key, _, value = line.partition(":")
        if key:
            status[key.strip()] = value.strip()

    namespaces = {}
    try:
        for ns in sorted(os.listdir(f"{base}/ns")):
            try:
                namespaces[ns] = os.readlink(f"{base}/ns/{ns}")
            except OSError:
                pass
    except OSError:
        pass

    def val(name):
        v = _read(f"{base}/{name}")
        return v.strip() if v is not None else None

    return {
        "status": status,
        "cgroup": val("cgroup"),
        "oom_score": val("oom_score"),
        "oom_score_adj": val("oom_score_adj"),
        "wchan": val("wchan"),
        "sched": (val("sched") or "").splitlines()[:24] or None,
        "limits": val("limits"),
        "namespaces": namespaces,
        "loginuid": val("loginuid"),
        "sessionid": val("sessionid"),
    }
