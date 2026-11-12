# Runbook: the ledger is down

## Detect

The board shows one open incident card: "The ledger answers 503". Jobs stay `working` and the trace has `x.pause`
spans. A tool call answering 503 is the signal; a 4xx is not an outage, it is a bad request.

## Stop

The clerk pauses every job by itself and writes nothing until the ledger answers. If the outage goes on, stop the
nightly batch so no new job starts, and leave the paused ones alone: do not restart them by hand, they resume
with the same Idempotency-Key.

## Tell

Tell Lena Ortiz (finance lead) that payments are paused and which invoices wait, from the card's job list. Tell
Ravi Shah (AP clerk) not to pay those invoices by hand, or the carrier is paid twice.

## Fix

The ledger team brings it back. Then check the board: the card closes, every paused job ends `done`, and the
ledger shows each invoice paid once. Any job that ended `failed` is started again with the same job id.

## Learn

Add the outage to the replay set and keep `failed-on-a-ledger-error` in the swap gate's evals, so a change that
makes the clerk give up on a 503 again is refused before it ships. Count the mode again after the next batch.
