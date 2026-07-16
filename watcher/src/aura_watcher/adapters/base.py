"""Aura adapter base class. See spec §4 "Adapter interface"."""

from __future__ import annotations

import abc


class Adapter(abc.ABC):
    """Abstract base for watcher adapters.

    Subclasses MUST implement :meth:`parse_line`.  Attempting to
    instantiate a subclass that does not override it will raise
    ``TypeError`` at construction time (standard ``abc.ABC`` behaviour).

    Contract
    --------
    ``parse_line(raw, file_path, byte_offset) -> dict | None``

    Parameters
    ----------
    raw:
        The decoded JSON object for a single JSONL line.
    file_path:
        Absolute path of the JSONL file being ingested (used for
        project-id extraction and logging).
    byte_offset:
        Byte position of the start of this line in *file_path*
        (stored in ``raw_events.byte_offset`` for checkpoint logic).

    Returns
    -------
    dict
        A flat dict ready to be inserted into ``raw_events``.  Required
        keys: ``uuid``, ``session_id``, ``ts``, ``event_type``.
    None
        Drop the line (e.g. missing required fields).  The adapter is
        responsible for logging the reason before returning ``None``.
    """

    @abc.abstractmethod
    def parse_line(
        self,
        raw: dict,
        file_path: str,
        byte_offset: int,
    ) -> dict | None:
        """Parse one decoded JSONL line into a ``raw_events`` row dict.

        See class docstring for the full parameter and return contract.
        """

    def parse_session_attributes(
        self,
        raw: dict,
        file_path: str,
    ) -> dict | None:
        """Extract session-level attributes from a control record.

        Control records (ai-title, permission-mode, mode) carry no uuid/ts so
        they are dropped by ``parse_line``.  This separate parse path captures
        them without touching ``raw_events``.

        Parameters
        ----------
        raw:
            The decoded JSON object for a single JSONL line.
        file_path:
            Absolute path of the JSONL file being ingested (used for
            session_id derivation when the record lacks ``sessionId``).

        Returns
        -------
        dict
            A dict with ``session_id`` and one or more of ``title``,
            ``permission_mode``, ``mode``.
        None
            Line is not a recognised session-attribute record; caller ignores it.
        """
        return None
