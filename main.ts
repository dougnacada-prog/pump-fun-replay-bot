// Pump.fun launch sniper — written from scratch for the Replay Sprint field.
//
// Idea in plain words: most new pump.fun coins dump within seconds of launch,
// so the bot never chases a run-up. It watches each coin from its CreateEvent
// and buys in the create batch itself — batches exist only for slots with
// events, so waiting even one slot would miss almost every launch — but only
// a launch that looks quiet and honest: the creator bought at most 2 SOL for
// themselves, exactly one other wallet has bought in so far (a crowd piling
// in at once is usually the creator's cluster waiting to dump; zero buyers
// is a dead launch), the creator has not sold, nobody dumped a big sell,
// the price has not already doubled, and the curve already holds at least
// 2 SOL of real reserve (so the 1%-of-reserve cap still allows a real buy).
// It then gets out fast: +15% take-profit, -6% stop-loss, out after 4 slots
// at the latest, out at once if the creator sells while held, out if the
// coin goes quiet for 30 slots. One buy per coin, at most 5 coins open.
// All money math is integer lamports (bigint); no clock, no randomness,
// no network, no environment.
//
// The grader runs this as `node /bot/main.ts` and speaks agent-fun/replay/v2
// on stdin/stdout through the vendored SDK shim below.

import { runBot, type Batch, type BotState, type OrderInput, type Pubkey } from "./vendor/makefun-bot.ts";

// ---- knobs (lamports; 1 SOL = 1_000_000_000 lamports) -----------------------
const STAKE = 100_000_000n; // 0.1 SOL aimed per coin (still capped at 1% of real SOL)
const MIN_BUY = 5_000_000n; // 0.005 SOL: smaller buys are not worth the tx fee
const MIN_AGE = 0; // buy in the create batch itself: batches exist only for slots
// with events, so the next batch is usually several slots later and a coin's
// 3-slot window is gone by then — waiting even one slot misses almost every
// launch. The tape below is still read from this same batch's events.
const MAX_AGE = 3; // oldest age (slots since create) a first buy may be decided
const MIN_REAL_SOL = 2_000_000_000n; // 2 SOL of real reserve before buying: the
// 1%-of-reserve cap then allows a buy of at least 0.01 SOL, which both counts
// toward the guardrail and keeps the fixed tx fee small next to the trade
const MAX_DEV_BUY = 2_000_000_000n; // creator's own buys in the create slot, at most 2 SOL
const MIN_BUYERS = 1; // distinct non-creator buyers seen before entry, at least
const MAX_BUYERS = 1; // ... at most: a crowd piling in at once is a dump in waiting
const MAX_RUNUP_BPS = 10_000n; // price now at most 2x the create price (+100%)
const MAX_BIG_SELL_BPS = 5_000n; // biggest single non-creator sell, at most 50% of real SOL
const TP_BPS = 1_500n; // take profit: +15% over cost
const SL_BPS = 600n; // stop loss: -6% under cost
const MAX_HOLD_SLOTS = 4; // never hold past this many slots
const STALE_SLOTS = 30; // exit if no trade hit the coin for this long
const BUY_SLIPPAGE_BPS = 10_000;
const SELL_SLIPPAGE_BPS = 10_000;
const MAX_OPEN = 5;

// ---- per-coin opening tape --------------------------------------------------
class Tape {
  mint: Pubkey;
  creator: Pubkey;
  bornSlot: number;
  // Create price as a ratio (virtual quote / virtual token), kept as a pair.
  firstQuote: bigint;
  firstTokens: bigint;
  devBuy = 0n;
  devSold = false;
  buyers = new Set<Pubkey>();
  biggestSellBps = 0n; // largest single non-creator sell, in bps of real SOL then
  trades = 0;
  lastTradeSlot: number;
  bought = false;

  constructor(mint: Pubkey, creator: Pubkey, slot: number, vQuote: bigint, vTokens: bigint) {
    this.mint = mint;
    this.creator = creator;
    this.bornSlot = slot;
    this.firstQuote = vQuote;
    this.firstTokens = vTokens;
    this.lastTradeSlot = slot;
  }

  // Fold one trade into the tape. `realSol` is the post-trade real SOL reserve.
  noteTrade(user: Pubkey, isBuy: boolean, sol: bigint, realSol: bigint, slot: number): void {
    this.trades += 1;
    this.lastTradeSlot = slot;
    if (user === this.creator) {
      if (isBuy) this.devBuy += sol;
      else this.devSold = true;
      return;
    }
    if (isBuy) {
      this.buyers.add(user);
    } else if (realSol > 0n) {
      const bps = (sol * 10_000n) / realSol;
      if (bps > this.biggestSellBps) this.biggestSellBps = bps;
    }
  }

  // Price now (virtual quote per virtual token) over the create price, in bps.
  // Returns null when either side is missing.
  runupBps(curve: { virtual_quote_reserves: bigint; virtual_token_reserves: bigint }): bigint | null {
    if (this.firstTokens === 0n || this.firstQuote === 0n) return null;
    if (curve.virtual_token_reserves === 0n) return null;
    const now = curve.virtual_quote_reserves * this.firstTokens;
    const then = this.firstQuote * curve.virtual_token_reserves;
    if (then === 0n) return null;
    return (now * 10_000n) / then;
  }
}

// ---- open-position bookkeeping ----------------------------------------------
interface Seat {
  openedSlot: number;
}

// Current value of a holding in lamports, from the curve's virtual reserves.
function valueLamports(tokens: bigint, curve: { virtual_quote_reserves: bigint; virtual_token_reserves: bigint }): bigint | null {
  if (curve.virtual_token_reserves === 0n) return null;
  return (tokens * curve.virtual_quote_reserves) / curve.virtual_token_reserves;
}

const tapes = new Map<Pubkey, Tape>();
const seats = new Map<Pubkey, Seat>();

function hasPendingOrder(state: BotState, mint: Pubkey, side?: "buy" | "sell"): boolean {
  for (const p of state.pending.values()) {
    if (p.order.mint === mint && (side === undefined || p.order.side === side)) return true;
  }
  return false;
}

function onBatch(state: BotState, batch: Batch): OrderInput[] {
  const orders: OrderInput[] = [];

  // 1. Take in this batch's events first (state already folded them in, but
  // the tape needs the per-trade detail: who traded and how much).
  for (const ev of batch.events) {
    if (ev.event === "CreateEvent") {
      tapes.set(
        ev.mint,
        new Tape(ev.mint, ev.creator, ev.slot, BigInt(ev.virtual_quote_reserves), BigInt(ev.virtual_token_reserves)),
      );
    } else if (ev.event === "TradeEvent") {
      let tape = tapes.get(ev.mint);
      if (tape === undefined) {
        // The mint was first seen through a trade or a mark: start a tape with
        // the reserves we have now and the trade's creator as best guess.
        tape = new Tape(ev.mint, ev.creator, ev.slot, BigInt(ev.virtual_quote_reserves), BigInt(ev.virtual_token_reserves));
        tapes.set(ev.mint, tape);
      }
      tape.noteTrade(ev.user, ev.is_buy, BigInt(ev.sol_amount), BigInt(ev.real_quote_reserves), ev.slot);
    } else if (ev.event === "CompleteEvent") {
      tapes.delete(ev.mint);
      seats.delete(ev.mint);
    }
  }

  // 2. Manage what is already held: exits first, so a freed slot can be reused.
  for (const [mint, holding] of state.positions) {
    const curve = state.curves.get(mint);
    const seat = seats.get(mint);
    if (curve === undefined || seat === undefined) continue;
    if (curve.complete) continue; // the harness closes completed curves itself
    if (hasPendingOrder(state, mint, "sell")) continue; // a sell is already on its way
    const value = valueLamports(holding.token_amount, curve);
    if (value === null) continue;
    const cost = holding.cost_lamports;
    let exit = false;
    if (value * 10_000n >= cost * (10_000n + TP_BPS)) exit = true; // take profit
    else if (value * 10_000n <= cost * (10_000n - SL_BPS)) exit = true; // stop loss
    else if (state.slot - seat.openedSlot >= MAX_HOLD_SLOTS) exit = true; // time out
    const tape = tapes.get(mint);
    if (tape !== undefined) {
      if (tape.devSold) exit = true; // creator sold while we hold: leave at once
      if (state.slot - tape.lastTradeSlot >= STALE_SLOTS) exit = true; // gone quiet
    }
    if (exit) {
      // Keep the seat until the position is really gone: if this sell is
      // rejected or fails, the next batch must manage the position again.
      orders.push({ side: "sell", mint, token_amount: holding.token_amount, max_slippage_bps: SELL_SLIPPAGE_BPS });
    }
  }

  // 3. Drop stale seats: a seat whose position is gone and which has no
  // order still pending is stale (its buy was rejected/failed, or its sell
  // filled). This runs BEFORE new buys are decided: an order sent in this
  // very reply is not in state.pending yet (runBot records it only after
  // onBatch returns), so cleaning up after buying would delete the seat
  // of a buy that has not even been sent.
  for (const mint of [...seats.keys()]) {
    if (!state.positions.has(mint) && !hasPendingOrder(state, mint)) {
      seats.delete(mint);
    }
  }

  // 4. Look for fresh launches to buy, youngest first.
  if (state.committedPositionCount() < MAX_OPEN) {
    const fresh: Tape[] = [];
    for (const tape of tapes.values()) {
      if (tape.bought) continue;
      const age = state.slot - tape.bornSlot;
      if (age < MIN_AGE || age > MAX_AGE) continue;
      if (state.positions.has(tape.mint)) continue;
      if (hasPendingOrder(state, tape.mint)) continue;
      fresh.push(tape);
    }
    fresh.sort((a, b) => a.bornSlot - b.bornSlot);
    for (const tape of fresh) {
      if (state.committedPositionCount() >= MAX_OPEN) break;
      if (state.freeCashLamports() < STAKE + state.txFeeLamports()) break;
      const curve = state.curves.get(tape.mint);
      if (curve === undefined || curve.complete) continue;
      // Honest-launch filter.
      if (tape.devBuy > MAX_DEV_BUY) continue;
      if (tape.devSold) continue;
      if (tape.trades < 1) continue;
      if (tape.buyers.size < MIN_BUYERS || tape.buyers.size > MAX_BUYERS) continue;
      if (tape.biggestSellBps > MAX_BIG_SELL_BPS) continue;
      if (curve.real_quote_reserves < MIN_REAL_SOL) continue;
      const runup = tape.runupBps(curve);
      if (runup === null) continue;
      if (runup > 10_000n + MAX_RUNUP_BPS) continue;
      // Size: aim for the stake, capped at 1% of the real SOL reserve, and
      // never below the minimum worth paying a tx fee for.
      let amount = STAKE;
      const cap = state.maxBuyLamports(tape.mint);
      if (amount > cap) amount = cap;
      if (amount < MIN_BUY) continue;
      tape.bought = true;
      seats.set(tape.mint, { openedSlot: state.slot });
      orders.push({ side: "buy", mint: tape.mint, quote_lamports: amount, max_slippage_bps: BUY_SLIPPAGE_BPS });
    }
  }

  return orders;
}

await runBot({ onBatch });
