"""Measuring an upload's length, to price it and to enforce `max_audio_seconds`.

The browser's MediaRecorder writes WebM to a stream it cannot seek in, so the header carries no
duration, and container timestamps are only as honest as whoever made the file. The length is
therefore the larger of two measures: the span of the packet timestamps, and the length of the
audio actually decoded. A file whose timestamps understate its audio cannot get under a cap.

Decoding costs CPU in proportion to the audio, and a crafted file can pack hours of audio into a
few megabytes. A caller that only needs to know whether a file is over a cap passes `limit`:
measuring stops as soon as either measure passes it.

Only a file that is exactly one audio stream is accepted, so no other stream can hide length
from, or add length to, the measure. This is our own estimate for the reservation; the provider
bills by its own measure of the same audio.
"""

from __future__ import annotations

import io
from decimal import ROUND_CEILING, Decimal
from fractions import Fraction

import av
import av.error


class UnsupportedAudio(Exception):
    """The bytes are not a single readable audio stream with a measurable length."""


_HUNDREDTH = Decimal("0.01")


def duration_seconds(data: bytes, *, limit: Decimal | None = None) -> Decimal:
    """Seconds of audio in `data`, rounded up to 0.01. Raises `UnsupportedAudio`.

    With a `limit`, a file longer than it stops being measured once it passes the limit, and
    the result is then some value above `limit` (not the full length).
    """
    cap = Fraction(limit) if limit is not None else None
    try:
        with av.open(io.BytesIO(data)) as container:
            if len(container.streams) != 1 or len(container.streams.audio) != 1:
                raise UnsupportedAudio("not exactly one audio stream")
            stream = container.streams.audio[0]
            first: Fraction | None = None
            last = Fraction(0)
            decoded = Fraction(0)
            for packet in container.demux(stream):
                if packet.pts is not None and packet.time_base is not None:
                    start = Fraction(packet.pts) * packet.time_base
                    end = Fraction(packet.pts + (packet.duration or 0)) * packet.time_base
                    first = start if first is None else min(first, start)
                    last = max(last, end)
                    if cap is not None and last - first > cap:
                        return _seconds(last - first)
                for frame in packet.decode():
                    if not isinstance(frame, av.AudioFrame) or frame.sample_rate <= 0:
                        raise UnsupportedAudio("undecodable audio")
                    decoded += Fraction(frame.samples, frame.sample_rate)
                    if cap is not None and decoded > cap:
                        return _seconds(decoded)
    except (av.error.FFmpegError, ValueError, OSError):
        raise UnsupportedAudio("unreadable audio") from None
    span = last - first if first is not None else Fraction(0)
    return _seconds(max(decoded, span))


def _seconds(length: Fraction) -> Decimal:
    if length <= 0:
        raise UnsupportedAudio("no audio")
    seconds = Decimal(length.numerator) / Decimal(length.denominator)
    return seconds.quantize(_HUNDREDTH, rounding=ROUND_CEILING)
