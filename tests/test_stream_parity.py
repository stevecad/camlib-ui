"""The viewer's TypeScript stream reader (web/src/cam/stream.ts) reads the plate's stream, and the shaft's turned one,
as the reference reader does: every move's end and G-code line, and the stock at moves across the program
(web/tests/stream.test.ts, under Node)."""
from __future__ import annotations

import json
import os
import shutil
import subprocess
from pathlib import Path

import pytest

from camlib_ui import stream

WEB = Path(__file__).resolve().parent.parent / "web"


def _parity(client, built, tmp_path):
    data = client.get(built["files"]["cam-playback.bin"]).content
    reader = stream.Reader(data)
    setups = []
    for setup in reader.setups():
        moves = [m for chunk in setup["chunks"] for m in reader.moves(setup, chunk)]
        count = setup["moves"]
        sample = sorted({0, 1, 2, count // 7, count // 3, count // 2, count - 1, count, *range(0, count, 37)})
        volumes = [[n, *stream.volume(setup, reader.stock_at(setup, n))] for n in sample]
        setups.append(dict(id=setup["id"], moves=count, ends=[list(m["end"]) for m in moves],
                           lines=[m["line"] or 0 for m in moves], volumes=volumes))
    (tmp_path / "stream.bin").write_bytes(data)
    (tmp_path / "expected.json").write_text(json.dumps(dict(setups=setups)))
    env = {**os.environ, "CAMLIB_UI_STREAM": str(tmp_path / "stream.bin"), "CAMLIB_UI_EXPECTED": str(tmp_path / "expected.json")}
    run = subprocess.run(["node", "--test", "tests/stream.test.ts"], cwd=WEB, env=env, capture_output=True, text=True, timeout=120)
    assert run.returncode == 0, run.stdout[-4000:] + run.stderr[-4000:]
    assert "skipped 0" in run.stdout and "fail 0" in run.stdout
    assert "✔ the stock at each move matches the reference reader" in run.stdout
    return setups


@pytest.mark.skipif(shutil.which("node") is None, reason="Node isn't installed")
def test_the_viewer_reads_the_stream_as_the_reference_does(client, plate, tmp_path):
    _parity(client, plate, tmp_path)


@pytest.mark.skipif(shutil.which("node") is None, reason="Node isn't installed")
def test_the_viewer_reads_a_turned_stream_as_the_reference_does(client, shaft, tmp_path):
    (setup,) = _parity(client, shaft, tmp_path)
    # The turned stock's volume falls from the bar's as the program cuts (the comparison covered a changing stock).
    volumes = [upper for _, upper, _ in setup["volumes"]]
    assert volumes == sorted(volumes, reverse=True) and volumes[-1] < 0.6 * volumes[0]
