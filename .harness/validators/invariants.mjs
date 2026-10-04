// Source-level checks for the engine rules a buyback pause must not disturb. Exits 1 and names each broken
// rule. Each check reads the contract, never the agent's tests, so a test the agent weakened cannot excuse it.
import { readFileSync } from "node:fs";

const read = file => readFileSync(new URL(`../../${file}`, import.meta.url), "utf8");
const strip = src => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
const engine = strip(read("packages/foundry/contracts/FurnaceEngine.sol"));

/** The text between the braces of `function <name>(`, or null when there is no such function. */
function body(name) {
  const at = engine.search(new RegExp(`function\\s+${name}\\s*\\(`));
  if (at < 0) return null;
  let i = engine.indexOf("{", at);
  const start = i;
  for (let depth = 0; i < engine.length; i++) {
    if (engine[i] === "{") depth++;
    if (engine[i] === "}" && --depth === 0) return engine.slice(start + 1, i);
  }
  return null;
}

const failures = [];
const rule = (ok, text) => ok || failures.push(text);

const scheduled = body("runScheduled");
const buyback = body("buyback");
const plan = body("_plan");
const preview = body("previewBuyback");
const setter = body("setBuybacksPaused");
rule(scheduled && buyback && plan && preview, "runScheduled, buyback, _plan and previewBuyback must all exist");

if (scheduled && buyback && plan && preview) {
  // AGENTS.md 8 and 9: book first, never revert, one booking per execution.
  const book = scheduled.indexOf("_bookNext()");
  const buy = scheduled.indexOf("this.buyback()");
  rule(book >= 0 && buy >= 0 && book < buy, "runScheduled must book its successor before it calls buyback");
  rule(scheduled.split("_bookNext(").length === 2, "runScheduled must call _bookNext exactly once");
  rule(/try\s+this\.buyback\(\)[\s\S]*catch/.test(scheduled), "runScheduled must wrap buyback in try/catch");
  rule(
    [...scheduled.matchAll(/revert\s+(\w+)/g)].every(m => m[1] === "OnlySelf"),
    "runScheduled may revert only with OnlySelf, so a skipped or failed run never costs the chain",
  );
  rule(!/_bookNext|scheduleCall/.test(buyback), "buyback must not book a schedule");

  // AGENTS.md 3: burn only bought tokens.
  const held = buyback.indexOf("held =");
  const swap = buyback.indexOf("swapExactETHForTokens");
  rule(held >= 0 && swap >= 0 && held < swap, "buyback must read the engine's token balance before the swap");
  rule(
    /tokensBurned\s*=\s*IERC20\(token\)\.balanceOf\(address\(this\)\)\s*-\s*held/.test(buyback),
    "buyback must burn the balance difference around the swap",
  );
  rule(/burnToken\(token,\s*_int64\(tokensBurned\)/.test(buyback), "buyback must burn exactly tokensBurned");
  rule(
    /balanceOf\(address\(this\)\)\s*<\s*teamUnclaimed\s*\+\s*liquidityUnseeded\)\s*revert AllocationBreach/.test(
      buyback,
    ),
    "buyback must keep the AllocationBreach check on the team and liquidity allocations",
  );

  // AGENTS.md 5: one function sizes the buyback, so the dry run cannot disagree with the run.
  rule(/_plan\(\)/.test(buyback) && /_plan\(\)/.test(preview), "buyback and previewBuyback must both read _plan");
  rule(
    /Skip\.TooSoon/.test(plan) && /Skip\.LotCap/.test(plan) && /Skip\.TwapDeviation/.test(plan),
    "_plan must keep the minimum gap, the lot cap and the average-price bound",
  );
  rule(/_snapshot\(/.test(buyback), "buyback must keep moving the price snapshot the average is measured from");
  rule(!/buybacksPaused/.test(buyback), "the pause is decided in _plan, not re-checked in buyback");
  rule(
    /buybacksPaused/.test(plan) && /Skip\.Paused/.test(plan),
    "_plan must skip with Skip.Paused while buybacksPaused is set",
  );
  const paused = plan.indexOf("Skip.Paused");
  rule(paused >= 0 && paused < plan.indexOf("hbarUsd()"), "_plan must check the pause before it reads the oracle");
  rule(!/buybacksPaused/.test(scheduled), "runScheduled must not branch on the pause: it books first and buyback skips");

  // The spend ledger moves only when a buyback spends: lastBuyAt is written after buyback's skip return.
  const skipReturn = buyback.indexOf("plan.skip != Skip.None");
  const stamp = buyback.search(/lastBuyAt\s*=\s*block\.timestamp/);
  rule(skipReturn >= 0 && stamp > skipReturn, "lastBuyAt must be stamped only after buyback's skip return");
}

// AGENTS.md 1: the owner cannot move HBAR, LP tokens or bought tokens, and the setter is plain policy.
if (setter !== null) {
  rule(!/\.call\{|\.transfer\(|\.send\(|burnToken|approve\(/.test(setter), "setBuybacksPaused must only set policy");
  rule(/buybacksPaused\s*=/.test(setter), "setBuybacksPaused must store the flag");
}
rule(!/function\s+(withdraw|sweep|rescue|skim)\w*\(/i.test(engine), "no withdraw, sweep or rescue function may exist");

// The Skip enum is read by the page by position, so the TypeScript list must match the Solidity enum exactly.
const solSkip = engine
  .match(/enum\s+Skip\s*\{([^}]*)\}/)?.[1]
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);
const tsSkip = read("packages/nextjs/utils/furnace/constants.ts")
  .match(/SKIP_REASONS\s*=\s*\[([^\]]*)\]/)?.[1]
  .split(",")
  .map(s => s.trim().replace(/"/g, ""))
  .filter(Boolean);
rule(
  solSkip && tsSkip && JSON.stringify(solSkip) === JSON.stringify(tsSkip),
  `SKIP_REASONS (${tsSkip}) must list the Solidity Skip enum (${solSkip}) in order`,
);

// deployedContracts.ts is generated by the deploy; the page reads the new getters from its own ABI fragment.
rule(
  !/buybacksPaused/.test(read("packages/nextjs/contracts/deployedContracts.ts")),
  "deployedContracts.ts is generated and must not be edited by hand",
);

if (failures.length) {
  console.error(`${failures.length} engine rule(s) broken:`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log("engine rules hold: book first, burn only bought tokens, one _plan, pause decided before the oracle");
