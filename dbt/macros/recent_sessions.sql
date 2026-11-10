{# Incremental cursor: sessions with lake rows ingested since this model's last
   build (minus 1 h of slack for late or retried flushes). _built_at is the
   cutoff of the build, not wall-clock time, so a cycle never skips rows. #}
{% macro recent_sessions() %}
SELECT DISTINCT tenant_id, session_id FROM {{ source('lake', 'raw_events') }}
WHERE {{ lake_cutoff() }}
  AND ingested_at >= (SELECT COALESCE(MAX(_built_at), TIMESTAMP '1970-01-01') FROM {{ this }}) - INTERVAL 1 HOUR
{% endmacro %}

{# High-water mark stored as _built_at. LEAST() with the UTC clock keeps a manual
   run without --vars (cutoff 9999-12-31) from freezing the cursor forever. #}
{% macro built_at() %}LEAST(TIMESTAMP '{{ var("aura_cutoff", "9999-12-31 00:00:00") }}', CAST(current_timestamp AT TIME ZONE 'UTC' AS TIMESTAMP)){% endmacro %}
