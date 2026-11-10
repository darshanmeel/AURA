{{ config(materialized='table') }}

SELECT ts, source, file_path, error_message, stack_trace
FROM {{ source('lake', 'watcher_errors') }}
WHERE {{ lake_cutoff() }}
