# Freight audit clerk: where it sits on the map

## Problem

KaaS Freight pays about 40 carriers. Two clerks match each carrier invoice to its rate confirmation and its
proof of delivery by hand. Last quarter they paid one load twice: USD 3,140 out of the door, and many rounds of
emails to get it back. When they fall behind, carriers charge late fees.

## Choice

agent

## Why

Each invoice needs a different next step. A clean one is paid. One with a detention charge needs the signed delay
on the proof of delivery. One that looks like a duplicate needs a search for the same load. Code cannot list every
mix of these in advance, so the model reads the papers and picks the next tool.

Who decides the next step: the model

Code still holds the lines it must never cross: the pay tool refuses a second payment for the same load, and any
payment over USD 5,000 waits for Lena.

## Starts by

An event: a new invoice arrives in the ledger. It lives for one case: one invoice, from arrival to paid or
disputed.
