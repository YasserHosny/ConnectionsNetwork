"""Measuring an upload's length from its audio packets.

The browser's MediaRecorder writes WebM to a stream it cannot seek in, so the header carries no
duration. The only reliable length is the end of the last packet, which is also what the
provider will bill. Demuxing reads packet headers only; nothing is decoded.
"""

from __future__ import annotations

import io
from decimal import ROUND_CEILING, Decimal

import av
import av.error


class UnsupportedAudio(Exception):
    """The bytes are not audio PyAV can read, or hold no audio stream or no measurable length."""


_HUNDREDTH = Decimal("0.01")


def duration_seconds(data: bytes) -> Decimal:
    """Seconds of audio in `data`, rounded up to 0.01. Raises `UnsupportedAudio`."""
    try:
        with av.open(io.BytesIO(data)) as container:
            streams = container.streams.audio
            if not streams:
                raise UnsupportedAudio("no audio stream")
            stream = streams[0]
            end = Decimal(0)
            for packet in container.demux(stream):
                if packet.pts is None or packet.time_base is None:
                    continue  # a flush packet, or one that cannot be placed in time
                ticks = packet.pts + (packet.duration or 0)
                end = max(
                    end, Decimal(ticks) * packet.time_base.numerator / packet.time_base.denominator
                )
    except (av.error.FFmpegError, ValueError, OSError):
        raise UnsupportedAudio("unreadable audio") from None
    if end <= 0:
        raise UnsupportedAudio("no audio packets")
    return end.quantize(_HUNDREDTH, rounding=ROUND_CEILING)
