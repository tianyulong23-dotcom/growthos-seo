# Local background capacity measurement

Date: 2026-09-15.
Status: BLOCKED before load submission, HOST_MEMORY_SAFETY_STOP.

## Requested measurement

Measure independent background task concurrency, distinguishing accepted workflows,
simultaneously executing activities, queued work and completed business operations.

Source root and Git identity verified:
C:/Users/DELL/Documents/缝合/john3947-seo-main,
main, 506d88fac0fa81503e54aebdfc4ac9e68974997b,
origin https://github.com/john3947/seo.git.
All unrelated dirty work retained.

## Current evidence

- Installed Temporal Worker source documents 100 fixed activity slots by default.
  app/workflows/agent_worker.py does not override Worker concurrency or its tuner.
  This is an activity-slot configuration, not a tested maximum number of complete
  product/business tasks or a throughput guarantee.
- Prior phase-5 evidence demonstrated two workflows on real local Temporal with
  fixture activities. It is not a higher-concurrency measurement in this run.
- Host visible RAM: 15.69 GiB.
- Initial OS observation: 0.32 GiB free.
- Second guarded startup: 1.06 GiB available, 93.2% memory utilization.
- Configured safety floor: at least 2 GiB available and below 90% utilization.
- Pagefile current usage at inspection: 9,824 MiB. Paging latency was not measured.
- Both startup attempts stopped before creating a test Worker or workflow and
  before running concurrent HTTP requests.
- Platform API 7200, Core API 7301 and Core Worker 7302 health returned HTTP 200.

## Prepared test, not yet executed

Checkpoint: .codex-checkpoints/multitask-capacity-20260915/.

- capacity.py: real local Temporal, production AgentWorkflow and fixture-only
  activities on a unique queue, leaving the live Worker queue untouched.
- Planned waves: 2, 5, 10, 20, 50, 100, 200; repeat 100 and 200 once each.
- Tool fixtures hold an execution slot, then simulate three seconds of I/O wait.
  Record actual occupied slots, tasks waiting to enter the tool, p95 latency,
  activity retries, handoff correctness and workflow cleanup.
- Separate real read-only task API waves: 1, 5, 10, 20, 50, 50 concurrent requests.
- Memory floor before each wave; 90-second workflow execution timeout; bounded
  submit/result waits; cleanup cancels only this test's unfinished workflows.
- results.json currently contains empty temporal/http measurements and the
  resource stop evidence. It is not a passed load-test report.

## Resume and limitations

Release memory without interrupting business services, then rerun:

```powershell
backend/api/.venv/Scripts/python.exe .codex-checkpoints/multitask-capacity-20260915/capacity.py
```

Do not lower the guard simply to obtain a number. Even when the planned 200-task
ceiling passes, it establishes a bounded fixture-workload result, not an absolute
product maximum. Real AI/provider workloads require a separately bounded provider
budget and representative operations. No such provider calls were made here.

This run made no production edits, service restarts, business writes, Gmail sends,
migrations, commits or pushes. No user processes were closed. The only additions
and edits are the acceptance checkpoint and this report.
