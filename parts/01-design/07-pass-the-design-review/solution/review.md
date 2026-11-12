# Design review: freight audit clerk

Design reviewed: map.md, employee.toml, acceptance.yaml, tools.yaml, cost.yaml and the three ADRs.

## Reviewer: Priya Nair

- outcome checkable: yes. Paid or disputed is a row in payments or disputes, and the metric query counts them.
- must-never checkable: yes. The check query returns any load paid twice, and two trap cases expect zero rows.
- approver named: yes. Ravi up to USD 5,000 and Lena above, both named on pay_invoice in tools.yaml.
- cost below value: yes. USD 0.0045 per settled invoice against USD 4 of clerk time, failed runs counted.
- tenant safe: yes. Every tool in tools.yaml is tenant own, and none searches KaaS Dairy's loads.
- stop rule: yes. A job ends paid, disputed or waiting for Lena, and the topology ADR stops at the checker.

## Reviewer: Tomás Reyes

- outcome checkable: yes. The clean invoice case names the payments row and the amount, not a message.
- must-never checkable: yes. The hidden instruction case expects no payment row for INV-2046.
- approver named: yes. The approval case names Lena, and the limit is the same in both files.
- cost below value: yes. I ran bun run cost on cost.yaml and got the same USD 0.0045.
- tenant safe: yes. The tenant is kaas-freight in tools.yaml, and no tool is marked any.
- stop rule: yes. The durability ADR resumes from the last saved step instead of starting a new payment.
