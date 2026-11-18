"""Loopback OTLP/HTTP protobuf/JSON receiver for isolated parity evidence."""
import argparse
import base64
import gzip
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import threading
import time
import zlib

from google.protobuf.json_format import MessageToDict
from opentelemetry.proto.collector.trace.v1.trace_service_pb2 import ExportTraceServiceRequest


def otlp_json(value):
    if isinstance(value, list):
        return [otlp_json(item) for item in value]
    if isinstance(value, dict):
        return {key: base64.b64decode(item).hex()
                if key in ("traceId", "spanId", "parentSpanId") and isinstance(item, str)
                else otlp_json(item) for key, item in value.items()}
    return value


def main(args):
    root = Path(args.root).resolve()
    root.mkdir(parents=True, exist_ok=True)
    lock = threading.Lock()

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *unused):
            pass

        def do_POST(self):
            if self.path != "/v1/traces":
                self.send_error(404)
                return
            if "chunked" in self.headers.get("Transfer-Encoding", "").lower():
                chunks = []
                while True:
                    line = self.rfile.readline()
                    size = int(line.split(b";", 1)[0].strip(), 16)
                    if size == 0:
                        while self.rfile.readline() not in (b"\r\n", b"\n", b""):
                            pass
                        break
                    chunks.append(self.rfile.read(size))
                    if self.rfile.read(2) != b"\r\n":
                        self.send_error(400)
                        return
                body = b"".join(chunks)
            else:
                body = self.rfile.read(int(self.headers.get("Content-Length", 0)))
            receipt = {"received_time_unix_nano": str(time.time_ns()),
                       "content_type": self.headers.get("Content-Type"),
                       "content_encoding": self.headers.get("Content-Encoding"),
                       "transfer_encoding": self.headers.get("Transfer-Encoding"),
                       "content_length": self.headers.get("Content-Length"),
                       "received_bytes": len(body)}
            with lock, (root / "http-receipts.jsonl").open("a") as output:
                output.write(json.dumps(receipt) + "\n")
            if not body:
                self.send_error(400, "Empty OTLP body")
                return
            request = ExportTraceServiceRequest()
            try:
                if self.headers.get("Content-Encoding") == "gzip":
                    body = gzip.decompress(body)
                elif self.headers.get("Content-Encoding") == "deflate":
                    body = zlib.decompress(body)
                is_json = "json" in self.headers.get("Content-Type", "") or body.lstrip().startswith(b"{")
                if is_json:
                    data = json.loads(body)
                else:
                    request.ParseFromString(body)
                    data = otlp_json(MessageToDict(request))
            except Exception as exc:
                with lock, (root / "parse-errors.jsonl").open("a") as output:
                    output.write(json.dumps({**receipt, "error_type": type(exc).__name__}) + "\n")
                (root / f"{receipt['received_time_unix_nano']}.unparsed").write_bytes(body)
                self.send_error(400)
                return
            with lock:
                stamp = str(time.time_ns())
                (root / f"{stamp}.{'wire-json' if is_json else 'pb'}").write_bytes(body)
                (root / f"{stamp}.json").write_text(json.dumps(data, indent=2))
                with (root / "requests.jsonl").open("a") as output:
                    output.write(json.dumps({"received_time_unix_nano": stamp, "wire_format": "json" if is_json else "protobuf", **data}) + "\n")
                for resource in data.get("resourceSpans", []):
                    attrs = {item["key"]: item["value"] for item in resource.get("resource", {}).get("attributes", [])}
                    service = attrs.get("service.name", {}).get("stringValue", "unknown")
                    if service.startswith(("qwenpaw-parity-baseline", "qwenpaw-parity-pilot")) and all(c.isalnum() or c in "-_." for c in service):
                        with (root / f"{service}.jsonl").open("a") as output:
                            output.write(json.dumps({"resourceSpans": [resource]}) + "\n")
            self.send_response(200)
            self.send_header("Content-Type", "application/x-protobuf")
            self.send_header("Content-Length", "0")
            self.end_headers()

    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    endpoint = f"http://127.0.0.1:{server.server_port}/v1/traces"
    (root / "endpoint.json").write_text(json.dumps({"endpoint": endpoint}))
    print(endpoint, flush=True)
    server.serve_forever()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", required=True)
    parser.add_argument("--port", type=int, default=0)
    main(parser.parse_args())
