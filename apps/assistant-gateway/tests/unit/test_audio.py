from __future__ import annotations

import io
import socket
import threading
from collections.abc import Callable, Iterator
from decimal import Decimal
from pathlib import Path

import av
import pytest
from audio_samples import (
    adts_aac,
    aiff_pcm,
    flac,
    matroska_opus,
    matroska_two_audio_streams,
    mp3,
    mp4_aac,
    mp4_audio_and_video,
    ogg_opus,
    wav_pcm,
    webm_opus_all_packets_at_pts_zero,
    webm_opus_no_duration,
)

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


def test_two_audio_streams_are_unsupported() -> None:
    # A naive reader would measure only the short first stream (0.5 s) of this 30 s file.
    with pytest.raises(UnsupportedAudio):
        duration_seconds(matroska_two_audio_streams(0.5, 30.0))


def test_audio_plus_video_is_unsupported() -> None:
    with pytest.raises(UnsupportedAudio):
        duration_seconds(mp4_audio_and_video())


def test_timestamps_that_lie_cannot_shorten_the_measure() -> None:
    # 30 s of real Opus whose packets all claim pts 0: the packet span says 0.02 s, the decoded
    # samples say 30 s, and the longer wins.
    assert duration_seconds(webm_opus_all_packets_at_pts_zero(30.0)) >= Decimal("29.9")


def test_a_limit_stops_measuring_soon_after_it_is_passed() -> None:
    # 60 s of honest audio with a 5 s limit: the answer is just past the limit, not 60.
    result = duration_seconds(webm_opus_no_duration(60.0), limit=Decimal(5))
    assert Decimal(5) < result < Decimal("5.5")


def test_a_limit_stops_decoding_when_timestamps_lie() -> None:
    # Every packet claims pts 0, so only the decoded length can trip the limit. Decoding stops
    # right after it does; it does not run on to the full 30 s.
    result = duration_seconds(webm_opus_all_packets_at_pts_zero(30.0), limit=Decimal(5))
    assert Decimal(5) < result < Decimal("5.5")


def test_a_limit_above_the_length_changes_nothing() -> None:
    data = webm_opus_no_duration(3.0)
    assert duration_seconds(data, limit=Decimal(60)) == duration_seconds(data)


@pytest.mark.parametrize(
    "make",
    [webm_opus_no_duration, matroska_opus, mp4_aac, ogg_opus, wav_pcm, mp3, adts_aac, flac],
)
def test_every_allowed_container_is_measured(make: Callable[[float], bytes]) -> None:
    assert Decimal("2.9") <= duration_seconds(make(3.0)) <= Decimal("3.2")


def test_a_container_off_the_allow_list_is_refused() -> None:
    data = aiff_pcm(3.0)
    with av.open(io.BytesIO(data)) as container:  # FFmpeg itself reads it fine
        assert container.format.name == "aiff"
    with pytest.raises(UnsupportedAudio):
        duration_seconds(data)


def test_a_concat_list_cannot_make_ffmpeg_read_a_local_file(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # ffconcat's default `safe` mode still accepts a relative name, which it opens from the
    # server's working directory: secondary I/O on a file the caller never uploaded.
    (tmp_path / "on_the_server.wav").write_bytes(wav_pcm(5.0))
    monkeypatch.chdir(tmp_path)
    with pytest.raises(UnsupportedAudio):
        duration_seconds(b"ffconcat version 1.0\nfile 'on_the_server.wav'\n")


@pytest.fixture
def listener() -> Iterator[tuple[int, list[bytes]]]:
    """A TCP listener on 127.0.0.1: (port, what each accepted connection sent)."""
    server = socket.socket()
    server.bind(("127.0.0.1", 0))
    server.listen(5)
    server.settimeout(0.2)
    seen: list[bytes] = []
    stop = threading.Event()

    def accept() -> None:
        while not stop.is_set():
            try:
                conn, _ = server.accept()
            except TimeoutError:
                continue
            with conn:
                conn.settimeout(1)
                try:
                    seen.append(conn.recv(4096))
                except OSError:
                    seen.append(b"")

    thread = threading.Thread(target=accept, daemon=True)
    thread.start()
    try:
        yield server.getsockname()[1], seen
    finally:
        stop.set()
        thread.join(2)
        server.close()


@pytest.mark.parametrize(
    "playlist",
    [
        "#EXTM3U\n#EXT-X-TARGETDURATION:10\n#EXT-X-MEDIA-SEQUENCE:0\n"
        "#EXTINF:10.0,\nhttp://127.0.0.1:{port}/segment.ts\n#EXT-X-ENDLIST\n",
        "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000\nhttp://127.0.0.1:{port}/variant.m3u8\n",
        "ffconcat version 1.0\nfile 'http://127.0.0.1:{port}/a.wav'\n",
    ],
    ids=["hls-media", "hls-master", "ffconcat-http"],
)
def test_a_playlist_is_refused_without_any_network_request(
    listener: tuple[int, list[bytes]], playlist: str
) -> None:
    port, seen = listener
    with pytest.raises(UnsupportedAudio):
        duration_seconds(playlist.format(port=port).encode())
    assert seen == []
