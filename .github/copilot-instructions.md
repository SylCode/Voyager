# MineVoyager Copilot Instructions

## Post-Change Monitoring Loop

**After every code change that affects the bot (any .js, .py, prompt, or config file):**

1. Restart the bot: `pkill -f run_local.py && pkill -f forge-proxy && pkill -f 'voyager/env/mineflayer/index.js' && sleep 3 && nohup .venv/bin/python -u run_local.py > logs/voyager.log 2>&1 < /dev/null & disown`
2. Enter the monitoring loop below. Monitor continuously in escalating intervals: **1 min → 2 min → 3 min → … → 20 min → repeat from 1 min**.

### What to check every interval

For each check, run a combined diagnostic and inspect ALL of the following:

```bash
latest=$(ls -t logs/mineflayer/ | head -1)
# 1. Bot alive?
pgrep -fa run_local.py | head -1

# 2. Current task (curriculum agent)
grep -E "Starting task|Completed task|Failed to complete task" logs/voyager.log | tail -5

# 3. Action agent — generated code
grep -A60 "YOUR PROGRAM" logs/voyager.log | tail -60

# 4. Critic agent — feedback
grep -E "Critique:|critique|success.*false|success.*true" logs/voyager.log | tail -5

# 5. Errors in voyager/action log
grep -E "Error|error|Traceback|raise " logs/voyager.log | tail -10

# 6. Server/mineflayer logs — block breaks, position, inventory, placement
grep -E "dig start|blockUpdate.*->.*air|goto block|Placing |Cannot place|Error placing|inventory gained|inv=" logs/mineflayer/$latest | tail -15

# 7. Chat output (what the bot is saying in-game)
grep -E "Chat log:" logs/voyager.log | tail -5

# 8. Inventory
grep -E "Inventory \(" logs/voyager.log | tail -2
```

After each check:

- **Identify** any errors, bad patterns, stalls, wrong block targets, placement failures, critic rejections.
- **Diagnose** root cause (prompt issue, runtime bug, wrong offset, missing prereq, etc.).
- **Fix immediately** if an issue is found, then restart and reset the monitoring loop back to 1 min.

### NEVER call task_complete while monitoring

- **NEVER call `task_complete` while the monitoring loop is active.** The loop is always active after a code change until the user explicitly ends the session. Calling `task_complete` closes the thread and breaks the monitoring loop.
- The only correct way to end a monitoring session is if the user explicitly says to stop.

### If the user interrupts the loop

- Address the interruption fully.
- Then **always resume the monitoring loop** from where it was interrupted (continue from the next interval, not from 1 min, unless a new change was made — in that case reset to 1 min).

### Loop schedule

| Cycle | Intervals (minutes)                                                   |
| ----- | --------------------------------------------------------------------- |
| 1     | 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20 |
| 2+    | repeat from 1 min                                                     |

A "cycle" resets to 1 min whenever a new fix is applied and the bot is restarted.
