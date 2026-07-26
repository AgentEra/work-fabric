from __future__ import annotations

import asyncio
import sys

from .protocol import ProtocolError, read_request
from .runner import run


def main() -> int:
    try:
        request = read_request()
    except ProtocolError:
        sys.stderr.write("Agently worker rejected its input request\n")
        sys.stderr.flush()
        return 2
    return asyncio.run(run(request))


if __name__ == "__main__":
    raise SystemExit(main())
