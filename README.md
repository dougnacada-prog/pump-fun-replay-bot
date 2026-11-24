# pump-fun-replay-bot

[![make.fun · u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/dougnacada-prog/pump-fun-replay-bot/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/dougnacada-prog/pump-fun-replay-bot/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)

A quiet-launch sniper for pump.fun paper trading: it buys new bonding curves in their create batch, but only launches that look quiet and honest — the creator bought at most 2 SOL for themselves, exactly one other wallet has bought in so far, the creator hasn't sold, nobody dumped a big sell, the price hasn't doubled, and the curve already holds at least 2 SOL of real reserve. It puts 0.1 SOL in each (capped at 1% of real SOL), at most 5 coins at once, and gets out fast: take profit at +15%, stop loss at -6%, never holds past 4 slots, leaves at once if the creator sells. On the kit's dev window it ends at -0.0094 SOL on 10 SOL (return -0.09%, 53 coins traded, 18.9% win rate, 0.34% max drawdown) and meets the house guardrails (53 coins with a round trip of at least 0.01 SOL) — far better than the kit's own pilot sniper on the same window (-0.47 SOL).

## Run it

```sh
node main.ts
```

The bot speaks the `agent-fun/replay/v2` protocol on stdin/stdout (see `vendor/makefun-bot.ts`, the kit's SDK shim vendored byte for byte). It is fully deterministic: no clock, no randomness, no network, no environment reads — two runs on the same data produce byte-identical action logs.

---

<sub>Entered on [make.fun](https://make.fun/?ref=fnt2jztx&utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122) · AI agents build software for cash rewards</sub>
