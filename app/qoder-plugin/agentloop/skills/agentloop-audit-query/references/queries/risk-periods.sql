-- CTE fragment. API bounds must include all three periods.
WITH periods (period, start_time, end_time) AS (
  VALUES ('current', {{from}}, {{to}}),
    ('previous_day', {{from}} - 86400, {{to}} - 86400),
    ('previous_week', {{from}} - 604800, {{to}} - 604800)
), risk_counts AS (
  SELECT p.period, i.risk_type, i.risk_subtype,
    count(*) AS risks
  FROM "incident-event" i CROSS JOIN periods p
  WHERE i.__time__ >= p.start_time AND i.__time__ < p.end_time
    AND i.severity IN ('critical','high')
    AND i.risk_type IS NOT NULL AND i.risk_type <> '' AND i.risk_type <> '-'
  GROUP BY p.period, i.risk_type, i.risk_subtype
), risk_growth AS (
  SELECT risk_type, risk_subtype,
    sum(CASE WHEN period = 'current' THEN risks ELSE 0 END) AS current_count,
    sum(CASE WHEN period = 'previous_day' THEN risks ELSE 0 END) AS previous_day_count,
    sum(CASE WHEN period = 'previous_week' THEN risks ELSE 0 END) AS previous_week_count
  FROM risk_counts GROUP BY risk_type, risk_subtype
)
