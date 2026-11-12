# Design review: freight audit clerk

## Reviewer: Priya Nair

- outcome checkable: yes. Paid or disputed is a status in the invoices table, and the metric query counts it.
- must-never checkable: yes. The check query returns any load paid twice, and two trap cases expect zero rows.
- approver named: yes. Ravi up to USD 5,000 and Lena above, both named on pay_invoice in tools.yaml.
- cost below value: yes. USD 0.0045 per settled invoice against USD 4 of clerk time, failed runs counted.
- tenant safe: yes. Every tool in tools.yaml is tenant own, and none searches KaaS Dairy's loads.
- stop rule: yes. A job ends paid, disputed or waiting for Lena, and the topology ADR stops at the checker.
