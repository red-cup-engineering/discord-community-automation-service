# Discord Community Automation Service

<!-- 561-group-standards:badges:start -->
[![Red Cup Engineering](https://img.shields.io/badge/561%20Group-Red%20Cup%20Engineering-c0392b)](https://github.com/red-cup-engineering)
[![License: MIT](https://img.shields.io/badge/license-MIT-c0392b)](LICENSE)
[![Indigenous data: CARE](https://img.shields.io/badge/Indigenous%20data-CARE-4b6f44)](https://github.com/red-cup-engineering/.github/blob/main/GOVERNANCE.md)
[![Tips welcome](https://img.shields.io/badge/tips-welcome-d4a017)](https://github.com/561-group/.github/blob/main/TIPS.md)
<!-- 561-group-standards:badges:end -->

Transport-free, policy-first building blocks for Discord community automation.
It normalizes reaction events, evaluates explicit reaction-role bindings, makes
deterministic effect plans, journals idempotent execution receipts, derives
reversible rollback plans, and projects durable receipts without Discord IDs or
message content.

It does not open a gateway, call Discord, load environment variables, infer a
community's norms, or contain any community-specific IDs or copy. A Discord
adapter must supply current-state checks and an injected role executor; a
community application supplies bindings and its operational approval process.

## Safety model

- A binding is exact: guild, channel, message, emoji, role, and revision.
- Missing messages or roles, managed roles, hierarchy failures, and redundant
  mutations are refusals or observations, never guesses.
- Effect IDs are deterministic and receipts reserve an effect before it is
  executed, so restart/replay does not repeat a role mutation.
- Only an applied role effect has a generated reverse rollback plan.
- Durable receipt projections pseudonymize the actor and omit raw Discord IDs,
  emoji, role IDs, event IDs, and all message content.

## Commands

```sh
npm run check
npm run build
npm test
```
