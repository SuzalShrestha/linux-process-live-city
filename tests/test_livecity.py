import http.client
import json
import os
import subprocess
import sys
import threading
import time
import unittest

import psutil

from livecity.collector import Collector
from livecity.server import serve


class CollectorTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.collector = Collector(interval=0.5)
        cls.collector.sample()
        time.sleep(0.2)
        cls.snap = cls.collector.sample()

    def test_snapshot_contains_this_process(self):
        rows = {p["pid"]: p for p in self.snap["processes"]}
        me = rows[os.getpid()]
        self.assertEqual(me["ppid"], os.getppid())
        self.assertGreater(me["rss"], 0)
        self.assertIn("python", me["cmd"].lower())
        for key in ("cpu_percent", "num_threads", "status", "create_time", "kernel"):
            self.assertIn(key, me)

    def test_snapshot_is_json_serialisable(self):
        json.dumps(self.snap)

    def test_system_block(self):
        sys_ = self.snap["system"]
        self.assertGreater(sys_["cpu_count"], 0)
        self.assertEqual(len(sys_["per_cpu"]), len(psutil.cpu_percent(percpu=True)))
        self.assertGreater(sys_["mem_total"], 0)
        self.assertEqual(sys_["processes"], len(self.snap["processes"]))

    def test_details_for_self(self):
        d = self.collector.details(os.getpid())
        json.dumps(d)
        self.assertEqual(d["pid"], os.getpid())
        self.assertEqual(d["cwd"], os.getcwd())
        self.assertTrue(d["cmdline"])
        self.assertIn("environ", d)
        self.assertIsInstance(d["threads"], list)
        self.assertIsInstance(d["connections"], list)
        self.assertEqual(d["errors"], {})
        self.assertTrue(d["history"])

    def test_details_sees_open_file_and_socket(self):
        import socket
        path = os.path.abspath(__file__)
        with open(path) as fh, socket.socket() as s:
            s.bind(("127.0.0.1", 0))
            s.listen()
            port = s.getsockname()[1]
            d = self.collector.details(os.getpid())
            self.assertIn(path, [f["path"] for f in d["open_files"]])
            listening = [c for c in d["connections"] if c["status"] == "LISTEN"]
            self.assertIn(port, [c["laddr"]["port"] for c in listening])
            # Enums must be serialised by name, not as bare ints.
            self.assertEqual(listening[0]["family"], "AF_INET")
            fh.read(1)

    def test_details_missing_pid(self):
        with self.assertRaises(psutil.NoSuchProcess):
            self.collector.details(2 ** 22 + 12345)

    def test_new_child_appears_and_exits(self):
        child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(30)"])
        try:
            snap = self.collector.sample()
            row = next(p for p in snap["processes"] if p["pid"] == child.pid)
            self.assertEqual(row["ppid"], os.getpid())
        finally:
            child.kill()
            child.wait()
        snap = self.collector.sample()
        self.assertNotIn(child.pid, [p["pid"] for p in snap["processes"]])

    def test_signal_guards(self):
        with self.assertRaises(PermissionError):
            self.collector.send_signal(1, "TERM")
        with self.assertRaises(PermissionError):
            self.collector.send_signal(os.getpid(), "TERM")
        with self.assertRaises(ValueError):
            self.collector.send_signal(12345, "SEGV")

    def test_signal_delivery(self):
        child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(30)"])
        try:
            self.collector.send_signal(child.pid, "TERM")
            self.assertEqual(child.wait(timeout=5), -15)
        finally:
            if child.poll() is None:
                child.kill()


class ServerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.collector = Collector(interval=0.5)
        cls.collector.sample()
        cls.httpd, _ = serve("127.0.0.1", 0, cls.collector, allow_signals=False)
        cls.port = cls.httpd.server_address[1]
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()

    def request(self, method, path, headers=None, body=None):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        h = {"Host": f"localhost:{self.port}"}
        h.update(headers or {})
        conn.request(method, path, body=body, headers=h)
        res = conn.getresponse()
        data = res.read()
        conn.close()
        return res.status, data

    def test_index_served(self):
        status, body = self.request("GET", "/")
        self.assertEqual(status, 200)
        self.assertIn(b"PROCESS", body)

    def test_vendored_three_served(self):
        status, _ = self.request("GET", "/vendor/three/build/three.module.js")
        self.assertEqual(status, 200)

    def test_snapshot_api(self):
        status, body = self.request("GET", "/api/snapshot")
        self.assertEqual(status, 200)
        self.assertIn(os.getpid(), [p["pid"] for p in json.loads(body)["processes"]])

    def test_process_api(self):
        status, body = self.request("GET", f"/api/process/{os.getpid()}")
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)["pid"], os.getpid())
        status, _ = self.request("GET", f"/api/process/{2 ** 22 + 12345}")
        self.assertEqual(status, 404)

    def test_path_traversal_blocked(self):
        for path in ("/../server.py", "/%2e%2e/server.py", "/css/../../server.py"):
            status, _ = self.request("GET", path)
            self.assertEqual(status, 404, path)

    def test_dns_rebinding_blocked(self):
        status, _ = self.request("GET", "/api/snapshot", headers={"Host": "attacker.example"})
        self.assertEqual(status, 403)

    def test_signals_require_header_and_flag(self):
        status, _ = self.request("POST", "/api/process/12345/signal", body=b'{"signal":"TERM"}')
        self.assertEqual(status, 403)
        status, body = self.request(
            "POST", "/api/process/12345/signal", body=b'{"signal":"TERM"}',
            headers={"X-LiveCity": "1", "Content-Type": "application/json"},
        )
        self.assertEqual(status, 403)
        self.assertIn(b"--allow-signals", body)


class TokenTests(unittest.TestCase):
    def test_token_required_when_requested(self):
        collector = Collector()
        collector.sample()
        httpd, token = serve("127.0.0.1", 0, collector, require_token=True)
        port = httpd.server_address[1]
        threading.Thread(target=httpd.serve_forever, daemon=True).start()
        try:
            def get(path):
                conn = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
                conn.request("GET", path, headers={"Host": "localhost"})
                res = conn.getresponse()
                res.read()
                conn.close()
                return res.status
            self.assertTrue(token)
            self.assertEqual(get("/api/snapshot"), 401)
            self.assertEqual(get("/api/snapshot?token=wrong"), 401)
            self.assertEqual(get(f"/api/snapshot?token={token}"), 200)
            self.assertEqual(get("/"), 200)  # static assets stay public
        finally:
            httpd.shutdown()
            httpd.server_close()


if __name__ == "__main__":
    unittest.main()
