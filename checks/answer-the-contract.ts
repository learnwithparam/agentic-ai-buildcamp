// Your employee answers contract 1: the checker starts it from employee.toml and gets GET /health
// within 10 s.
import { behaviourRule } from "./lib";

export default [
  behaviourRule(
    "answer-the-contract",
    "the checker starts your employee from employee.toml " +
      "and GET /health answers contract 1, a name and kaas-freight",
    "read PORT from the environment, listen on it, " +
      'and answer GET /health with {"contract": "1", "employee", "tenants"}',
  ),
];
