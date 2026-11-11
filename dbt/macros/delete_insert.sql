{# dbt-duckdb's delete+insert deletes with `USING <new rows>`: every old row joins once per
   new row sharing its key, so a session-keyed model blows up quadratically (hours on the
   DuckLake stage). dbt's default deletes `WHERE key IN (SELECT DISTINCT key ...)` instead. #}
{% macro duckdb__get_delete_insert_merge_sql(target, source, unique_key, dest_columns, incremental_predicates) -%}
    {{ default__get_delete_insert_merge_sql(target, source, unique_key, dest_columns, incremental_predicates) }}
{%- endmacro %}
