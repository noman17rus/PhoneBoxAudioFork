"""Check standalone analyzer SSE cadence against a built Windows agent (WASAPI).

Run with --agent PATH/PhoneBoxAgent.exe. Each analyzer gets a fresh process,
so an FFT profile cannot mask a slow stream. Silence is sufficient (10 Hz);
with audio, waveform and stereo capture normally produce 30 Hz.
"""
import argparse
import json
import subprocess
import tempfile
import time
import urllib.request
from pathlib import Path


def check(agent, port, kind):
    with tempfile.TemporaryDirectory(prefix="phonebox-cadence-") as directory:
        config = Path(directory) / "config.json"
        config.write_text(json.dumps({
            "updates": {"auto": False},
            "pages": [{"id": "p", "widgets": [{"id": "a", "type": kind}]}],
        }), encoding="utf-8")
        process = subprocess.Popen(
            [str(agent), "--config", str(config), "--port", str(port)],
            creationflags=subprocess.CREATE_NO_WINDOW,
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
        base = f"http://127.0.0.1:{port}"
        try:
            for _ in range(60):
                if process.poll() is not None:
                    raise RuntimeError("Agent exited before capture started")
                try:
                    with urllib.request.urlopen(base + f"/api/{kind}?widget=p/a", timeout=2) as reply:
                        data = json.load(reply)
                    if data["frame"]["state"] in ("live", "silent"):
                        break
                except OSError:
                    pass
                time.sleep(.2)
            else:
                raise RuntimeError(f"{kind}: WASAPI capture did not start")
            times, sequences = [], set()
            with urllib.request.urlopen(base + "/api/stream", timeout=4) as stream:
                start = time.monotonic()
                event = ""
                while time.monotonic() - start < 2.5:
                    line = stream.readline().decode("utf-8").strip()
                    if line.startswith("event: "):
                        event = line[7:]
                    elif line.startswith("data: ") and event == kind:
                        frame = json.loads(line[6:])
                        if frame["sequence"] not in sequences:
                            sequences.add(frame["sequence"])
                            times.append(time.monotonic())
            # Allow scheduler jitter at the 10 Hz silence rate, but reject 1 Hz delivery.
            assert len(times) >= 12, f"{kind}: only {len(times)} frames in 2.5 s"
            gaps = [b - a for a, b in zip(times, times[1:])]
            assert max(gaps) < .5, f"{kind}: delivery stalled for {max(gaps):.3f} s"
            print(f"PASS {kind}: {len(times)} frames in {times[-1] - times[0]:.2f} s, "
                  f"longest gap {max(gaps):.3f} s", flush=True)
        finally:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--agent", type=Path, required=True)
    parser.add_argument("--port", type=int, default=18779, help="Unused local port")
    args = parser.parse_args()
    for analyzer in ("audio-waveform", "audio-stereo", "audio-loudness"):
        check(args.agent.resolve(strict=True), args.port, analyzer)
