-- The on-run-start hook must leave the session in UTC (Q5).
SELECT 1 AS not_utc WHERE current_setting('TimeZone') <> 'UTC'
