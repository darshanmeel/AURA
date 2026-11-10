{# First text block of an assistant message: walks up to 20 content positions and
   skips thinking/tool_use blocks (profiled max first-text index was 12). Shared by
   int_turns and fact_prompts so the extraction lives in one place. #}
{% macro assistant_text(payload) %}
COALESCE(
{%- for i in range(20) %}
    CASE WHEN json_extract_string({{ payload }}, '$.message.content[{{ i }}].type') = 'text'
         THEN json_extract_string({{ payload }}, '$.message.content[{{ i }}].text') END{{ "," if not loop.last }}
{%- endfor %}
)
{% endmacro %}
