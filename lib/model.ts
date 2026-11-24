export type Protocol = {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
};

export type Snapshot = {
  as_of: string;
  source: string;
  floor_usd: number;
  watchlist: string[];
  protocols: Protocol[];
};

export type BoardRow = {
  rank: number;
  slug: string;
  name: string;
  implied_value_usd: number;
  farm_steps: string[];
};

export const BOARD_SIZE = 200;
const DAY_MS = 86_400_000;

export function recordsTradingToken(protocol: Protocol): boolean {
  return protocol.gecko_id !== null || protocol.symbol !== null || protocol.mcap_usd !== null;
}

function tenureDays(protocol: Protocol, asOf: number): number | null {
  if (protocol.listed_at === null) return null;
  const days = (asOf - Date.parse(protocol.listed_at)) / DAY_MS;
  if (!Number.isInteger(days) || days < 0) throw new Error(`Invalid listing date for ${protocol.slug}`);
  return days;
}

function slugOrder(a: Protocol, b: Protocol): number {
  return a.slug < b.slug ? -1 : Number(a.slug > b.slug);
}

function anchors(candidates: { protocol: Protocol; days: number | null }[]) {
  const moves = candidates.flatMap(({ protocol }) =>
    protocol.change_7d === null ? [] : [Math.abs(protocol.change_7d)]
  ).sort((a, b) => a - b);
  const days = candidates.flatMap((item) => item.days === null ? [] : [item.days]).sort((a, b) => a - b);
  const mid = Math.floor(days.length / 2);
  const median = days.length ? (days[mid] + days[Math.floor((days.length - 1) / 2)]) / 2 : 0;
  return {
    growth_scale: moves[Math.ceil(moves.length * 0.9) - 1] || 1,
    tenure_scale: median || 1,
  };
}

function modifiers(change: number | null, days: number | null, scale: ReturnType<typeof anchors>) {
  // USD value = round(TVL × momentum × tenure). Momentum = 1 + 0.25 × clamp(7d% / P90(|7d%|), -1, 1).
  // Tenure = 1 + 0.25 × (days - median days) / (days + median days). Each missing input contributes 1×.
  const momentum = change === null ? 1 : 1 + 0.25 * Math.min(1, Math.max(-1, change / scale.growth_scale));
  const maturity = days === null ? 1 : 1 + 0.25 * (days - scale.tenure_scale) / (days + scale.tenure_scale);
  return { momentum, maturity };
}

type Route = { inspect: string; trial: string; exit: string; check: string };
const routes = {
  curator: {
    inspect: 'Find a vault explicitly curated by the protocol. Record the host app, asset, vault address, allocation and available withdrawal liquidity.',
    trial: 'Preview a supply and an immediate redemption in the host vault. Price approvals, share conversion and both transaction fees.',
    exit: 'Recheck market allocations and available exit liquidity in 7 days. Redeem shares only against the documented vault and confirm receipt in the wallet.',
    check: 'Look for the curator’s name in campaign rules. Host-vault activity, curator exposure and campaign credit can track different addresses.',
  },
  vault: {
    inspect: 'Find the live product and record its share token, underlying assets, manager fee, withdrawal queue and any minimum deposit.',
    trial: 'Preview a deposit and its share receipt, then price a redemption. Include the fee paid by the strategy or vault as well as network fees.',
    exit: 'In 7 days compare the share-to-asset conversion with the quote. If a queue applies, note when a withdrawal request becomes claimable.',
    check: 'Confirm whether a campaign attributes deposits to the specific vault, chain and share holder. Save the published product or campaign identifier.',
  },
  dex: {
    inspect: 'Find a liquid spot pair in the official interface. Record contract addresses, routing, price impact and the pool’s fee tier.',
    trial: 'Preview a small swap and the reverse quote on the same chain. Record protocol fees, price impact and both network costs.',
    exit: 'Check campaign status in 7 days. If you tested liquidity, remove the position and compare both asset balances with the initial amounts.',
    check: 'Verify which pairs and actions count. Keep a swap or position receipt and avoid circular trades or volume generated purely for eligibility.',
  },
  lending: {
    inspect: 'Find a single-asset supply market. Record its collateral configuration, utilization, available withdrawal cash and lending caps.',
    trial: 'Preview supplying a supported asset and redeeming it without borrowing. Check approval cost, supply cap and the withdrawal quote.',
    exit: 'After 7 days check utilization again and compare the supply receipt with the amount available to redeem. Stop if withdrawals are constrained.',
    check: 'Confirm whether supply alone counts and whether the underlying market or an aggregator receives attribution. Save the market ID.',
  },
  collateral: {
    inspect: 'Read accepted collateral, the debt ceiling, oracle and liquidation threshold. Identify the repay-and-withdraw path before opening a position.',
    trial: 'Simulate a minimal collateral deposit, mint, repay and withdrawal through the official interface if available. Price network and stability fees.',
    exit: 'For a live position, monitor the collateral buffer daily and plan repayment promptly. Retain enough of the debt asset for fees and interest.',
    check: 'Check whether holding the issued asset or managing collateral counts. Keep the position identifier and avoid assuming that holding implies credit.',
  },
  bridge: {
    inspect: 'Verify the source and destination, supported asset and receiving address. Record min transfer, finality, relayer fees and return route.',
    trial: 'Preview one small transfer over a supported route and quote the return leg. Check destination gas and any delayed proof or claim.',
    exit: 'Track settlement up to the documented finality window. Reconcile both balances after arrival and keep enough destination gas for a return.',
    check: 'Save the source hash and message ID. Check whether the route, volume and destination qualify under any published campaign rules.',
  },
  stake: {
    inspect: 'Check the supported asset, validator or operator, fee, slashing exposure, and documented unstake or unbonding route.',
    trial: 'Preview a minimal stake and the exit. For a liquid receipt, compare the withdrawal queue with a secondary-market quote.',
    exit: 'Review the position in 7 days. Use the documented exit and record cooldown and settlement dates before committing any principal.',
    check: 'Check whether delegation, a receipt token or direct deposits get credit. Record the operator and position separately from the underlying asset.',
  },
  rwa: {
    inspect: 'Read access terms, eligible jurisdictions, verification requirements, subscription minimum and redemption cutoff before connecting.',
    trial: 'Check a subscription quote and next redemption window. Include management charges and any settlement spread. Stop at research if access is gated.',
    exit: 'Recheck NAV and redemption terms in 7 days. Compare the earliest dealing date with the cash settlement date before committing capital.',
    check: 'Confirm whether the listed product has a public campaign and whether verified accounts or direct holders qualify. Record the share class.',
  },
  exchange: {
    inspect: 'Read the official account and regional eligibility terms. Locate the fee schedule, supported networks and an asset’s withdrawal minimum.',
    trial: 'Use the demo or a public order preview when provided. Compare maker or taker fees and withdrawal cost with the minimum viable order.',
    exit: 'Recheck withdrawal availability in 7 days. For a permitted live test, withdraw the balance once using a supported network and reconcile the fee.',
    check: 'Check the campaign’s enrollment, regional terms and eligible pairs. Use a single eligible account and skip enrollment if the rules exclude you.',
  },
  derivatives: {
    inspect: 'Read margin, oracle, funding and liquidation rules. Find a testnet or paper mode and record its position-size minimum.',
    trial: 'Simulate opening and closing the smallest position with available low leverage. Log taker fees, funding, spread and realized P&L.',
    exit: 'Close a demo position after testing both entry and reduce-only exit. Check open orders and margin balances before finishing.',
    check: 'Verify whether testnet, mainnet, specific instruments or holding periods qualify. Keep screenshots or an order ID for the record.',
  },
  chain: {
    inspect: 'Check the network’s official RPC, chain ID, explorer and testnet availability. Verify whether the listed TVL belongs to an app, bridge or network.',
    trial: 'Use the documented faucet and submit a self-transfer on a testnet if offered. For mainnet, price onboarding and exit before moving assets.',
    exit: 'Confirm finality in the explorer. Only plan a mainnet test where a documented return path and wallet support both exist.',
    check: 'Check the campaign’s network ID and allowed actions. Record the transaction hash and avoid treating testnet use as mainnet credit.',
  },
  payments: {
    inspect: 'Read wallet support, supported currency, route limits and fees. Check whether the service offers a test environment or an invoice preview.',
    trial: 'Create a test invoice and look for a fee quote and expiry. For Bitcoin payment channels, include routing and channel open or close costs.',
    exit: 'Verify the invoice or test payment settled and record the receipt. Price channel or balance withdrawal if the service holds funds.',
    check: 'Look for an explicit payment campaign and its definition of a valid transaction. Reconcile the invoice ID with any dashboard credit.',
  },
  insurance: {
    inspect: 'Find an eligible cover quote and read exclusions, term, deductible and proof needed for a claim.',
    trial: 'Preview the smallest available cover without binding it. Compare the premium and claim fee with the maximum covered loss.',
    exit: 'Record the renewal date and cancellation terms. If you bound warranted cover, retain the policy receipt through the full claims period.',
    check: 'Verify whether purchasing cover or supplying underwriting capacity counts. These have different eligibility and capital requirements.',
  },
  governance: {
    inspect: 'Find the official proposal or incentive market and read voting eligibility, the lock period and claim schedule.',
    trial: 'Preview the smallest eligible vote or position. Price locking and unlocking fees and find any no-cost participation option first.',
    exit: 'Record the vote deadline or unlock date. Review for claim availability at the end of the epoch and reconcile any receipt.',
    check: 'Compare the campaign snapshot and eligibility with your action date. Keep the proposal or incentive ID for later verification.',
  },
  privacy: {
    inspect: 'Read the protocol’s access terms, supported proofs and regional restrictions before running any test.',
    trial: 'Use a documented public test environment if available. Record verification costs and how the interface confirms successful completion.',
    exit: 'Confirm the test completed according to published instructions. Check any return or finality period before planning a mainnet transaction.',
    check: 'Only track explicitly permitted test activity under published campaign terms, using the applicable network and proof type.',
  },
} satisfies Record<string, Route>;

const routeFor: Record<string, Route> = {
  'Risk Curators': routes.curator,
  'Onchain Capital Allocator': routes.vault,
  Yield: routes.vault,
  'Yield Aggregator': routes.vault,
  'Liquidity Manager': routes.vault,
  Farm: routes.vault,
  'Basis Trading': routes.vault,
  'Stablecoin Wrapper': routes.vault,
  'Options Vault': routes.vault,
  Indexes: routes.vault,
  CeDeFi: routes.rwa,
  RWA: routes.rwa,
  Dexs: routes.dex,
  Lending: routes.lending,
  'Uncollateralized Lending': routes.lending,
  CDP: routes.collateral,
  'Dual-Token Stablecoin': routes.collateral,
  'Collateral Markets': routes.collateral,
  Bridge: routes.bridge,
  'Canonical Bridge': routes.bridge,
  'Anchor BTC': routes.bridge,
  'Decentralized BTC': routes.bridge,
  'Liquid Staking': routes.stake,
  'Liquid Restaking': routes.stake,
  'Staking Pool': routes.stake,
  Restaking: routes.stake,
  CEX: routes.exchange,
  Derivatives: routes.derivatives,
  'Leveraged Farming': routes.derivatives,
  'Prediction Market': routes.derivatives,
  Chain: routes.chain,
  Payments: routes.payments,
  'Crypto Card Issuer': routes.payments,
  Insurance: routes.insurance,
  'Governance Incentives': routes.governance,
  Privacy: routes.privacy,
};

function makePlan(protocol: Protocol, medianTVL: number, floor: number): string[] {
  const route = routeFor[protocol.category ?? ''] ?? routes.vault;
  const chains = protocol.chains;
  const preferred = ['Base', 'Arbitrum', 'Optimism', 'Solana', 'Polygon'].find((chain) => chains.includes(chain));
  const network = preferred ?? chains[0] ?? 'the documented deployment';
  const networkCheck = chains.length > 1
    ? `Start on ${network} if supported. Compare with ${chains.find((chain) => chain !== network)} only if you already have funds there.`
    : `Match the campaign and official product to ${network} before connecting.`;
  const budget = protocol.tvl_usd >= floor ? 40 : protocol.tvl_usd >= medianTVL ? 25 : 10;
  const execution = protocol.tvl_usd < medianTVL
    ? `Preview only by default. An optional test caps principal at $${budget}; skip if the minimum or exit liquidity defeats the cap.`
    : `If the verified action is useful on its own, cap optional principal at $${budget} and quoted round-trip fees at $${budget >= 40 ? 4 : 2}.`;
  const reference = protocol.change_7d !== null && protocol.change_7d < -12
    ? 'Compare the reported TVL drop with published incident and withdrawal notices before leaving the preview.'
    : 'Save the steps and quotes with the date. Treat eligibility and costs as unconfirmed until published or quoted.';
  return [
    `Verify · $0 / 10 min. Open ${protocol.name} through its official documentation and check whether it publishes a token or campaign. ${networkCheck}`,
    `Inspect · $0 / 15 min. ${route.inspect}`,
    `Preview · $0 / 15 min. ${route.trial} ${execution}`,
    `Track · $0 / 5 min. ${route.check} ${reference}`,
    `Exit check · $0 to review / 10 min plus any settlement delay. ${route.exit} For any live test, keep enough native gas to exit.`,
  ];
}

export function buildRadar(snapshot: Snapshot) {
  const asOf = Date.parse(snapshot.as_of);
  if (!Number.isFinite(asOf)) throw new Error('Snapshot has an invalid as_of date');
  const watchlist = new Set(snapshot.watchlist);
  const preToken = snapshot.protocols.filter((protocol) => !recordsTradingToken(protocol));
  const watched = preToken.filter((protocol) => watchlist.has(protocol.slug));
  const early = preToken.filter((protocol) => protocol.tvl_usd < snapshot.floor_usd && !watchlist.has(protocol.slug))
    .sort((a, b) => b.tvl_usd - a.tvl_usd || slugOrder(a, b))
    .slice(0, BOARD_SIZE - watched.length);
  const candidates = [...watched, ...early].map((protocol) => ({ protocol, days: tenureDays(protocol, asOf) }));
  const scale = anchors(candidates);
  const tvls = candidates.map(({ protocol }) => protocol.tvl_usd).sort((a, b) => a - b);
  const medianTVL = (tvls[Math.floor(tvls.length / 2)] + tvls[Math.floor((tvls.length - 1) / 2)]) / 2;
  const ranked = candidates.map(({ protocol, days }) => {
    const { momentum, maturity } = modifiers(protocol.change_7d, days, scale);
    return {
      ...protocol, tenure_days: days, momentum, maturity, watchlist: watchlist.has(protocol.slug),
      implied_value_usd: Math.max(1, Math.round(protocol.tvl_usd * momentum * maturity)),
    };
  }).sort((a, b) => b.implied_value_usd - a.implied_value_usd || b.tvl_usd - a.tvl_usd || slugOrder(a, b))
    .map((protocol, index) => ({
      ...protocol,
      rank: index + 1,
      farm_steps: makePlan(protocol, medianTVL, snapshot.floor_usd),
    }));
  const rows: BoardRow[] = ranked.map(({ rank, slug, name, implied_value_usd, farm_steps }) =>
    ({ rank, slug, name, implied_value_usd, farm_steps })
  );
  const trading = snapshot.protocols.filter(recordsTradingToken).sort(slugOrder)
    .map((protocol) => ({ ...protocol, tenure_days: tenureDays(protocol, asOf) }));
  return {
    rows,
    data: {
      as_of: snapshot.as_of,
      source: snapshot.source,
      floor_usd: snapshot.floor_usd,
      protocol_count: snapshot.protocols.length,
      watchlist_count: watched.length,
      below_floor_count: early.length,
      scale,
      ranked,
      trading,
    },
  };
}
