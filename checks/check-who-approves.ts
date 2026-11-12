// Jo is refused, Ravi is refused over his limit, Lena pays once, and a decline writes nothing.
import { behaviourRule } from "./lib";

export default [
  behaviourRule(
    "check-who-approves",
    "Jo and Ravi get 403, Lena's approval pays once, and Lena's decline writes nothing",
    "read GET /people from the world and compare the role and the limit with the amount before you accept a decision",
  ),
];
