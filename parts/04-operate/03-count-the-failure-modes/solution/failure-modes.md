# Failure modes

From the runs labelled fail in label-the-traces. Each failed run is in one mode: the first thing that went wrong.

| Mode | Count | Runs | What happened |
|---|---|---|---|
| failed-on-a-ledger-error | 5 | run-26e3c694, run-7f90cb75, run-20c64277, run-1930ef2d, run-7cb01a1c | The ledger answered 503, or the pay call timed out three times. The job gave up and wrote nothing. |
| wrong-reason-code | 2 | run-7d5eac95, run-a92cdc3d | The draft disputed detention and fuel as ABOVE_RATE. The checker stopped it, so nobody disputed the invoice. |
| missed-the-duplicate | 1 | run-c2d6049d | The draft said pay on a load already billed. The checker stopped it; the duplicate is still open. |

Total: 8 of 60 runs fail. The largest mode is not the model: it is the clerk giving up when the ledger is down.
