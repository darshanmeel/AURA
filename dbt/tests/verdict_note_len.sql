-- Verdict notes are capped at 500 characters in stg_session_verdicts.
SELECT * FROM {{ ref('stg_session_verdicts') }} WHERE length(note) > 500
