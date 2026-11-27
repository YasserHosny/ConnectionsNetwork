from __future__ import annotations

import io
from decimal import Decimal

import av
import pytest
from audio_samples import mp4_aac, webm_opus_no_duration

from assistant_gateway.audio import UnsupportedAudio, duration_seconds


def test_fixture_really_has_no_duration_in_the_header() -> None:
    # The point of the fixture: the container and stream report nothing, like MediaRecorder's.
    with av.open(io.BytesIO(webm_opus_no_duration(3.0))) as container:
        assert container.duration is None
        assert container.streams.audio[0].duration is None


def test_duration_measured_from_packets_without_header() -> None:
    assert Decimal("2.9") <= duration_seconds(webm_opus_no_duration(3.0)) <= Decimal("3.1")


def test_mp4_duration() -> None:
    assert Decimal("2.9") <= duration_seconds(mp4_aac(3.0)) <= Decimal("3.1")


def test_duration_is_rounded_up_to_a_hundredth() -> None:
    result = duration_seconds(webm_opus_no_duration(1.234))
    assert result == result.quantize(Decimal("0.01"))
    assert Decimal("1.23") <= result <= Decimal("1.27")


def test_garbage_is_unsupported() -> None:
    with pytest.raises(UnsupportedAudio):
        duration_seconds(b"not audio")


def test_empty_is_unsupported() -> None:
    with pytest.raises(UnsupportedAudio):
        duration_seconds(b"")


def test_a_file_with_no_audio_stream_is_unsupported() -> None:
    sink = io.BytesIO()
    container = av.open(sink, "w", format="mp4")
    stream = container.add_stream("mpeg4", rate=10)
    stream.width, stream.height, stream.pix_fmt = 16, 16, "yuv420p"
    for i in range(3):
        frame = av.VideoFrame(16, 16, "yuv420p")
        frame.pts = i
        for packet in stream.encode(frame):
            container.mux(packet)
    for packet in stream.encode(None):
        container.mux(packet)
    container.close()
    with pytest.raises(UnsupportedAudio):
        duration_seconds(sink.getvalue())
