"""Aura adapter base protocol. See spec §4 "Adapter interface"."""


class Adapter:
    """Protocol for watcher adapters.

    name: str — 'claude' | 'gemini' | ...
    def parse_line(self, raw: dict, ctx: FileContext) -> RawEvent: ...
    """
    pass
