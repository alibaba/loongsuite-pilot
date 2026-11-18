* | WITH deployment_log AS (SELECT * FROM log WHERE instance = coalesce(nullif(url_decode('${{multica_deployment|}}'),''), (SELECT instance FROM log
 WHERE nullif(instance,'') IS NOT NULL
 AND (schema_version LIKE 'multica.%' OR record_type='collection_status')
 GROUP BY instance ORDER BY max(observed_at_ms) DESC, instance LIMIT 1))), inputs AS (
 SELECT task_id, record_type, status, observed_at_ms, created_at, started_at, dispatched_at, completed_at,
  source_time, phase, phase_elapsed_ms, total_elapsed_ms, pod_name, pod_uid, runtime_id, event_id, entity_id, file_path
 FROM deployment_log
 WHERE record_type IN ('task_snapshot','server_log')
 AND regexp_like(task_id,'^[A-Za-z0-9_-]+$')
 AND (record_type='task_snapshot' OR (phase IS NOT NULL AND phase_elapsed_ms>=0 AND total_elapsed_ms>=phase_elapsed_ms))
), params AS (
 SELECT nullif('${{gantt_task_id|自动}}','自动') AS requested
), selected AS (
 SELECT coalesce((SELECT requested FROM params), (
  SELECT task_id FROM inputs GROUP BY task_id
  ORDER BY CASE WHEN count_if(record_type='server_log')>0 THEN 0 ELSE 1 END,max(observed_at_ms) DESC,task_id LIMIT 1
 )) AS id
), snap AS (
 SELECT task_id AS id, status, observed_at_ms / 1000.0 AS observed,
  try(to_unixtime(from_iso8601_timestamp(created_at))) AS created,
  try(to_unixtime(from_iso8601_timestamp(dispatched_at))) AS dispatched,
  try(to_unixtime(from_iso8601_timestamp(started_at))) AS started,
  try(to_unixtime(from_iso8601_timestamp(completed_at))) AS completed
 FROM inputs WHERE task_id=(SELECT id FROM selected) AND record_type='task_snapshot'
 ORDER BY observed_at_ms DESC,event_id DESC LIMIT 1
), raw_phases AS (
 SELECT DISTINCT task_id AS id, coalesce(nullif(pod_uid,''),nullif(pod_name,''),'未上报') AS host,
  coalesce(nullif(runtime_id,''),'未上报') AS runtime, phase, phase_elapsed_ms AS delta_ms,total_elapsed_ms AS elapsed_ms,
  try(to_unixtime(from_iso8601_timestamp(source_time))) AS marked_s
 FROM inputs WHERE task_id=(SELECT id FROM selected) AND record_type='server_log'
), attempts AS (
 SELECT *, count_if(phase='claimed') OVER (
  PARTITION BY host,runtime ORDER BY marked_s,elapsed_ms,phase ROWS UNBOUNDED PRECEDING
 ) AS attempt
 FROM raw_phases WHERE marked_s IS NOT NULL
), picked AS (
 SELECT host,runtime,attempt FROM attempts GROUP BY host,runtime,attempt
 ORDER BY max(marked_s) DESC,host,runtime,attempt DESC LIMIT 1
), phases AS (
 SELECT p.*, first_value(marked_s-elapsed_ms/1000.0) OVER (ORDER BY marked_s,elapsed_ms,phase) AS baseline
 FROM attempts p JOIN picked a ON p.host=a.host AND p.runtime=a.runtime AND p.attempt=a.attempt
), local_records AS (
 -- For local file records, entity_id contains device, inode and byte offset.
 SELECT task_id AS id, phase, phase_elapsed_ms AS delta_ms, total_elapsed_ms AS elapsed_ms,
  file_path, regexp_extract(entity_id, '^([0-9]+:[0-9]+):([0-9]+)$', 1) AS file_identity,
  try_cast(regexp_extract(entity_id, '^([0-9]+:[0-9]+):([0-9]+)$', 2) AS bigint) AS file_offset,
  coalesce(nullif(runtime_id,''),'未上报') AS runtime,
  coalesce(nullif(pod_uid,''),nullif(pod_name,''),'未上报') AS host,
  min(observed_at_ms) AS first_observed_ms
 FROM inputs WHERE task_id=(SELECT id FROM selected) AND record_type='server_log'
  AND try(to_unixtime(from_iso8601_timestamp(source_time))) IS NULL
  AND regexp_like(entity_id,'^[0-9]+:[0-9]+:[0-9]+$')
 GROUP BY 1,2,3,4,5,6,7,8,9
), local_attempts AS (
 SELECT *, count_if(phase='claimed') OVER (
  PARTITION BY host,runtime,file_path,file_identity ORDER BY file_offset ROWS UNBOUNDED PRECEDING
 ) AS attempt
 FROM local_records
), latest_local AS (
 SELECT host,runtime,file_path,file_identity,attempt FROM local_attempts
 GROUP BY host,runtime,file_path,file_identity,attempt
 ORDER BY max(first_observed_ms) DESC,max(file_offset) DESC,host,runtime,file_path,file_identity,attempt DESC LIMIT 1
), phase_offsets AS (
 SELECT id, phase, delta_ms, elapsed_ms, baseline, false AS relative_only FROM phases
 UNION ALL
 -- Anchor the drawing to the task snapshot when available. Keep absolute log times null.
 SELECT p.id,p.phase,p.delta_ms,p.elapsed_ms,coalesce((SELECT started FROM snap),0.0),true
 FROM local_attempts p JOIN latest_local a
 ON p.host=a.host AND p.runtime=a.runtime AND p.file_path=a.file_path AND p.file_identity=a.file_identity AND p.attempt=a.attempt
 WHERE NOT EXISTS (SELECT 1 FROM phases)
), spans AS (
 SELECT id, baseline+(elapsed_ms-delta_ms)/1000.0 AS begin_s,baseline+elapsed_ms/1000.0 AS end_s,delta_ms/1000.0 AS seconds,
  CASE phase WHEN 'claimed' THEN '领到任务' WHEN 'prepare_started' THEN '开始准备'
   WHEN 'skills_ready' THEN '技能准备完成' WHEN 'environment_ready' THEN '环境就绪'
   WHEN 'runtime_started' THEN '运行时启动' WHEN 'first_output_received' THEN '收到首次输出'
   WHEN 'first_tool_use' THEN '首次调用工具' WHEN 'turn_completed' THEN '本轮执行结束'
   WHEN 'finished' THEN '任务收尾完成' ELSE phase END AS label, relative_only
 FROM phase_offsets WHERE delta_ms>0
), first_phase AS (
 SELECT min(baseline) AS begin_s FROM phases
), summary AS (
 SELECT id, created, dispatched, started, completed, observed, status, begin_s FROM snap CROSS JOIN first_phase
), ranges AS (
 SELECT * FROM spans
 UNION ALL
 SELECT id,created,coalesce(dispatched,started,begin_s,IF(status IN ('queued','dispatched','deferred','waiting_local_directory'),observed,NULL)),
  coalesce(dispatched,started,begin_s,IF(status IN ('queued','dispatched','deferred','waiting_local_directory'),observed,NULL))-created,'排队等待',false
 FROM summary WHERE started IS NOT NULL OR NOT EXISTS (SELECT 1 FROM spans WHERE relative_only)
 UNION ALL
 SELECT id,dispatched,begin_s,begin_s-dispatched,'派给运行时后等待领取',false FROM summary
 UNION ALL
 SELECT id,started,coalesce(completed,IF(status='running',observed,NULL)),
  coalesce(completed,IF(status='running',observed,NULL))-started,'执行（仅有任务时间）',false
 FROM summary WHERE NOT EXISTS (SELECT 1 FROM spans)
)
SELECT round(begin_s-min(begin_s) OVER (),3) AS "开始偏移",
 round(end_s-min(begin_s) OVER (),3) AS "结束偏移",
 round(seconds,3) AS "本段耗时",
 concat(label,' · ',cast(round(seconds,3) AS varchar),' 秒') AS "阶段",
 id AS "任务 ID",IF(relative_only,NULL,begin_s) AS "开始时间",IF(relative_only,NULL,end_s) AS "结束时间"
FROM ranges WHERE begin_s IS NOT NULL AND end_s>begin_s
ORDER BY begin_s,end_s LIMIT 100
