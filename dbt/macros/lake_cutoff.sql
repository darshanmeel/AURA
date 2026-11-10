{# Consistent lake snapshot (spec §2.1): the watcher passes aura_cutoff, taken
   under its flush lock, so every lake read of one dbt cycle sees the same rows. #}
{% macro lake_cutoff() %}ingested_at <= TIMESTAMP '{{ var("aura_cutoff", "9999-12-31 00:00:00") }}'{% endmacro %}
