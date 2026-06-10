"""
Timeline queries: discover date/sequence parameters and return sorted build steps.
"""
import re
from datetime import datetime

_DATE_KEY_KW = re.compile(
    r'start|begin|end|finish|date|planned|actual|construction|schedule|sequence|phase|stage|step',
    re.IGNORECASE,
)

_ISO_DATE = re.compile(r'^\d{4}-\d{2}-\d{2}')
_DMY_DATE = re.compile(r'^\d{2}[./]\d{2}[./]\d{4}')
_MDY_DATE = re.compile(r'^\d{2}/\d{2}/\d{4}')


def _looks_like_date(val: str) -> bool:
    return bool(_ISO_DATE.match(val) or _DMY_DATE.match(val) or _MDY_DATE.match(val))


def _parse_sortable(val: str):
    """Return a comparable tuple for sorting: (0, datetime) or (1, float) or (2, str)."""
    for fmt in ('%Y-%m-%d', '%d.%m.%Y', '%d/%m/%Y', '%m/%d/%Y'):
        try:
            return (0, datetime.strptime(val[:10], fmt))
        except ValueError:
            pass
    try:
        return (1, float(val.replace(',', '.')))
    except ValueError:
        pass
    return (2, val)


def get_timeline_params(conn, model_id: str) -> list:
    """
    Return candidate parameters that could drive a build-up timeline.
    Looks for keys whose values look like dates or construction sequence numbers.
    """
    with conn.cursor() as cur:
        cur.execute("""
            SELECT p.key,
                   COUNT(DISTINCT p.element_id) AS elem_count,
                   COUNT(DISTINCT p.value)       AS distinct_values,
                   MIN(p.value)                  AS sample_min,
                   MAX(p.value)                  AS sample_max
            FROM bim_parameters p
            JOIN bim_elements e ON e.element_id = p.element_id
            WHERE e.model_id = %s
              AND p.value IS NOT NULL
              AND p.value <> ''
              AND LENGTH(p.value) BETWEEN 4 AND 60
            GROUP BY p.key
            HAVING COUNT(DISTINCT p.element_id) > 1
               AND COUNT(DISTINCT p.value) BETWEEN 2 AND 500
            ORDER BY elem_count DESC
            LIMIT 300
        """, (model_id,))
        rows = cur.fetchall()

    result = []
    for key, elem_count, distinct_values, sample_min, sample_max in rows:
        is_date_key = bool(_DATE_KEY_KW.search(key))
        is_date_val = _looks_like_date(str(sample_min or '')) or _looks_like_date(str(sample_max or ''))
        is_num_val = False
        try:
            float(str(sample_min or '').replace(',', '.'))
            is_num_val = True
        except ValueError:
            pass

        param_type = None
        if is_date_val:
            param_type = 'date'
        elif is_date_key and is_num_val:
            param_type = 'sequence'
        elif is_date_key:
            param_type = 'text'

        if param_type is None:
            continue

        result.append({
            'key':            key,
            'type':           param_type,
            'element_count':  elem_count,
            'distinct_values': distinct_values,
            'sample_min':     sample_min,
            'sample_max':     sample_max,
        })

    # Prioritize: date > sequence > text, then by element coverage
    type_rank = {'date': 0, 'sequence': 1, 'text': 2}
    return sorted(result, key=lambda x: (type_rank[x['type']], -x['element_count']))


def get_timeline_data(conn, model_id: str, param_key: str) -> dict:
    """
    Return elements grouped by param_key value, sorted chronologically.
    Shape: { steps: [{value, element_ids, cumulative_count}], total_elements }
    """
    with conn.cursor() as cur:
        cur.execute("""
            SELECT p.value, array_agg(DISTINCT e.speckle_id) AS speckle_ids
            FROM bim_parameters p
            JOIN bim_elements e ON e.element_id = p.element_id
            WHERE e.model_id = %s
              AND p.key = %s
              AND p.value IS NOT NULL AND p.value <> ''
              AND e.speckle_id IS NOT NULL
            GROUP BY p.value
        """, (model_id, param_key))
        rows = cur.fetchall()

    if not rows:
        return {'steps': [], 'total_elements': 0, 'param_key': param_key}

    sorted_rows = sorted(rows, key=lambda r: _parse_sortable(r[0]))

    steps = []
    cumulative = 0
    for value, speckle_ids in sorted_rows:
        ids = [sid for sid in speckle_ids if sid]
        cumulative += len(ids)
        steps.append({
            'value':            value,
            'element_ids':      ids,
            'cumulative_count': cumulative,
        })

    return {
        'param_key':      param_key,
        'steps':          steps,
        'total_elements': cumulative,
    }
