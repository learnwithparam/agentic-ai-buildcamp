# Failure modes

From the runs labelled fail in label-the-traces.

| Mode                     | Count | Runs                                                                 | What happened              |
| ------------------------ | ----- | -------------------------------------------------------------------- | -------------------------- |
| failed-on-a-ledger-error | 4     | run-26e3c694, run-7f90cb75, run-20c64277, run-1930ef2d, run-7cb01a1c | Ledger down.               |
| wrong-reason-code        | 2     | run-7d5eac95, run-a92cdc3d                                           | Wrong code.                |
| missed-the-duplicate     | 1     | run-c2d6049d                                                         | Paid draft on a duplicate. |
