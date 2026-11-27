"""Audio fixtures generated with PyAV, so the suite carries no binary files."""

from __future__ import annotations

import io
from fractions import Fraction

import av


class _NonSeekable:
    """A write-only sink, like the stream a browser's MediaRecorder writes to.

    The muxer cannot seek back to patch the duration into the header, so none is written.
    """

    def __init__(self) -> None:
        self.buffer = io.BytesIO()

    def write(self, data: bytes) -> int:
        return self.buffer.write(data)

    def flush(self) -> None:
        pass


def _silence(
    fmt: str, codec: str, seconds: float, rate: int, frame_size: int, sink: object
) -> None:
    container = av.open(sink, "w", format=fmt)
    stream = container.add_stream(codec, rate=rate)
    stream.layout = "mono"
    pts = 0
    for _ in range(0, int(seconds * rate), frame_size):
        frame = av.AudioFrame(format="s16", layout="mono", samples=frame_size)
        frame.planes[0].update(bytes(frame_size * 2))
        frame.sample_rate = rate
        frame.pts = pts
        frame.time_base = Fraction(1, rate)
        pts += frame_size
        for packet in stream.encode(frame):
            container.mux(packet)
    for packet in stream.encode(None):
        container.mux(packet)
    container.close()


def webm_opus_no_duration(seconds: float) -> bytes:
    sink = _NonSeekable()
    _silence("webm", "libopus", seconds, 48000, 960, sink)
    return sink.buffer.getvalue()


def mp4_aac(seconds: float) -> bytes:
    sink = io.BytesIO()
    _silence("mp4", "aac", seconds, 44100, 1024, sink)
    return sink.getvalue()
