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


def _encode(stream: av.AudioStream, seconds: float, rate: int, frame_size: int) -> list[av.Packet]:
    packets: list[av.Packet] = []
    pts = 0
    for _ in range(0, int(seconds * rate), frame_size):
        frame = av.AudioFrame(format="s16", layout="mono", samples=frame_size)
        frame.planes[0].update(bytes(frame_size * 2))
        frame.sample_rate = rate
        frame.pts = pts
        frame.time_base = Fraction(1, rate)
        pts += frame_size
        packets.extend(stream.encode(frame))
    packets.extend(stream.encode(None))
    return packets


def matroska_two_audio_streams(first: float, second: float) -> bytes:
    """Two audio streams: a short first one that a naive reader would measure, a long second."""
    sink = io.BytesIO()
    container = av.open(sink, "w", format="matroska")
    a = container.add_stream("libopus", rate=48000)
    b = container.add_stream("libopus", rate=48000)
    a.layout = b.layout = "mono"
    for packet in _encode(a, first, 48000, 960) + _encode(b, second, 48000, 960):
        container.mux(packet)
    container.close()
    return sink.getvalue()


def mp4_audio_and_video() -> bytes:
    sink = io.BytesIO()
    container = av.open(sink, "w", format="mp4")
    audio = container.add_stream("aac", rate=44100)
    audio.layout = "mono"
    video = container.add_stream("mpeg4", rate=10)
    video.width, video.height, video.pix_fmt = 16, 16, "yuv420p"
    for packet in _encode(audio, 1.0, 44100, 1024):
        container.mux(packet)
    for i in range(3):
        frame = av.VideoFrame(16, 16, "yuv420p")
        frame.pts = i
        for packet in video.encode(frame):
            container.mux(packet)
    for packet in video.encode(None):
        container.mux(packet)
    container.close()
    return sink.getvalue()


def webm_opus_all_packets_at_pts_zero(seconds: float) -> bytes:
    """Real audio whose container timestamps lie: every packet claims to start at 0."""
    sink = _NonSeekable()
    container = av.open(sink, "w", format="webm")
    stream = container.add_stream("libopus", rate=48000)
    stream.layout = "mono"
    for packet in _encode(stream, seconds, 48000, 960):
        packet.pts = 0
        packet.dts = 0
        container.mux(packet)
    container.close()
    return sink.buffer.getvalue()
