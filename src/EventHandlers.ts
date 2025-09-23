import {
  WMON,
  User,
  UserWeeklyPoints,
  HourlySnapshot,
  Transfer,
  Deposit,
  Withdrawal,
  Approval,
  GlobalStats,
  type handlerContext,
  type WMON_Transfer_event,
  type WMON_Deposit_event,
  type WMON_Withdrawal_event,
  type WMON_Approval_event,
} from "generated";

// ========== GLOBAL CONSTANTS ==========

// WMON token configuration
const WMON_DECIMALS = 18;
const DECIMAL_MULTIPLIER = BigInt(10) ** BigInt(WMON_DECIMALS);

// Tier definitions (amounts in actual WMON tokens, not wei)
const TIER_THRESHOLDS = {
  TIER_1_MIN: 10,    // 10 WMON
  TIER_2_MIN: 30,    // 30 WMON
  TIER_3_MIN: 100,   // 100 WMON
  TIER_4_MIN: 500,   // 500 WMON
};

// Points per hour for each tier
const TIER_POINTS = {
  TIER_0: 0,  // < 10 WMON
  TIER_1: 1,  // 10-30 WMON
  TIER_2: 2,  // 30-100 WMON
  TIER_3: 3,  // 100-500 WMON
  TIER_4: 4,  // 500+ WMON
};

// Weekly caps for each tier
const WEEKLY_CAPS = {
  TIER_0: 0,
  TIER_1: 120,  // 1 point/hour * ~120 hours (71% of 168)
  TIER_2: 280,  // 2 points/hour * ~140 hours (83% of 168)
  TIER_3: 450,  // 3 points/hour * ~150 hours (89% of 168)
  TIER_4: 600,  // 4 points/hour * ~150 hours (89% of 168)
};

// Zero address for mint/burn detection
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

// ========== UTILITY FUNCTIONS ==========

// Convert wei to actual token amount
function weiToTokenAmount(weiAmount: bigint): number {
  return Number(weiAmount) / Number(DECIMAL_MULTIPLIER);
}

// Convert token amount to string with proper decimals
function tokenAmountToString(weiAmount: bigint): string {
  const amount = weiToTokenAmount(weiAmount);
  return amount.toFixed(6); // 6 decimal places for display
}

// Calculate tier based on token amount
function calculateTier(tokenAmount: number): number {
  if (tokenAmount >= TIER_THRESHOLDS.TIER_4_MIN) return 4;
  if (tokenAmount >= TIER_THRESHOLDS.TIER_3_MIN) return 3;
  if (tokenAmount >= TIER_THRESHOLDS.TIER_2_MIN) return 2;
  if (tokenAmount >= TIER_THRESHOLDS.TIER_1_MIN) return 1;
  return 0;
}

// Get weekly cap for a tier
function getWeeklyCapForTier(tier: number): number {
  switch (tier) {
    case 1: return WEEKLY_CAPS.TIER_1;
    case 2: return WEEKLY_CAPS.TIER_2;
    case 3: return WEEKLY_CAPS.TIER_3;
    case 4: return WEEKLY_CAPS.TIER_4;
    default: return WEEKLY_CAPS.TIER_0;
  }
}

// Get points per hour for a tier
function getPointsForTier(tier: number): number {
  switch (tier) {
    case 1: return TIER_POINTS.TIER_1;
    case 2: return TIER_POINTS.TIER_2;
    case 3: return TIER_POINTS.TIER_3;
    case 4: return TIER_POINTS.TIER_4;
    default: return TIER_POINTS.TIER_0;
  }
}

// Get week start timestamp (Sunday 00:00:00) - AMM pattern adapted
function getWeekStartTimestamp(blockTime: number): number {
  const date = new Date(blockTime * 1000);
  const dayOfWeek = date.getUTCDay(); // 0 = Sunday, 1 = Monday, etc.
  const sunday = new Date(date);
  sunday.setUTCDate(date.getUTCDate() - dayOfWeek);
  sunday.setUTCHours(0, 0, 0, 0);
  return Math.floor(sunday.getTime() / 1000); // Return as Unix timestamp
}

// Get week start date string (Sunday) for a given timestamp
function getWeekStartDate(timestamp: number): string {
  const weekTimestamp = getWeekStartTimestamp(timestamp);
  return new Date(weekTimestamp * 1000).toISOString().split('T')[0]; // Returns "2025-09-28" format
}

// Get hourly timestamp - AMM pattern
function getHourlyTimestamp(blockTime: number): number {
  return Math.floor(new Date(blockTime * 1000).setMinutes(0, 0, 0) / 1000);
}

// Create unique transaction identifier from block hash and log index
function createTransactionId(blockHash: string, logIndex: number): string {
  return `${blockHash}_${logIndex}`;
}

// Get or create global stats - handles singleton pattern
async function getOrCreateGlobalStats(context: handlerContext): Promise<GlobalStats> {
  let globalStats = await context.GlobalStats.get("global");

  if (!globalStats) {
    globalStats = {
      id: "global",
      total_users: 0n,
      total_points_distributed: 0n,
      current_week_number: "1970-01-04", // Default week
      last_snapshot_hour: "1970-01-01-0",
      tier_distribution: JSON.stringify({
        tier0: 0,
        tier1: 0,
        tier2: 0,
        tier3: 0,
        tier4: 0
      })
    };
  }

  return globalStats;
}

// Update tier distribution in global stats
async function updateTierDistribution(
  oldTier: number,
  newTier: number,
  context: handlerContext
): Promise<void> {
  const globalStats = await getOrCreateGlobalStats(context);
  const tierDist = JSON.parse(globalStats.tier_distribution);

  // Decrement old tier count
  if (oldTier > 0) {
    tierDist[`tier${oldTier}`] = Math.max(0, (tierDist[`tier${oldTier}`] || 0) - 1);
  } else {
    tierDist.tier0 = Math.max(0, (tierDist.tier0 || 0) - 1);
  }

  // Increment new tier count
  if (newTier > 0) {
    tierDist[`tier${newTier}`] = (tierDist[`tier${newTier}`] || 0) + 1;
  } else {
    tierDist.tier0 = (tierDist.tier0 || 0) + 1;
  }

  const updatedGlobalStats: GlobalStats = {
    ...globalStats,
    tier_distribution: JSON.stringify(tierDist)
  };

  context.GlobalStats.set(updatedGlobalStats);
}

// Create or update user entity
async function getOrCreateUser(address: string, context: handlerContext): Promise<{ user: User, isNewUser: boolean }> {
  let user = await context.User.get(address);
  let isNewUser = false;

  if (!user) {
    user = {
      id: address,
      current_balance_wei: 0n,
      current_balance: "0.0",
      current_tier: 0,
      total_points_earned: 0n,
      last_update_timestamp: 0n,
    };
    isNewUser = true;
  }

  return { user, isNewUser };
}

// Update user balance and tier
async function updateUserBalance(
  user: User,
  newBalanceWei: bigint,
  timestamp: number,
  context: handlerContext
): Promise<User> {
  const tokenAmount = weiToTokenAmount(newBalanceWei);
  const newTier = calculateTier(tokenAmount);
  const oldTier = user.current_tier;

  // Update tier distribution if tier changed
  if (oldTier !== newTier) {
    await updateTierDistribution(oldTier, newTier, context);
  }

  return {
    ...user,
    current_balance_wei: newBalanceWei,
    current_balance: tokenAmountToString(newBalanceWei),
    current_tier: newTier,
    last_update_timestamp: BigInt(timestamp),
  };
}

// Get or create weekly points record
async function getOrCreateWeeklyPoints(
  userAddress: string,
  weekNumber: string,
  tier: number,
  context: handlerContext
): Promise<UserWeeklyPoints> {
  const id = `${userAddress}_${weekNumber}`;
  let weeklyPoints = await context.UserWeeklyPoints.get(id);

  if (!weeklyPoints) {
    weeklyPoints = {
      id,
      user_id: userAddress,
      user_address: userAddress,
      week_number: weekNumber,
      points_earned_this_week: 0n,
      weekly_cap: BigInt(getWeeklyCapForTier(tier)),
      is_cap_reached: false,
    };
  }

  return weeklyPoints;
}

// Process hourly points award with global stats updates
async function processHourlyPointsForUser(
  userAddress: string,
  newBalance: bigint,
  blockTime: number,
  context: handlerContext
): Promise<void> {
  if (newBalance <= 0n) return; // No points for zero balance

  const tokenAmount = weiToTokenAmount(newBalance);
  const tier = calculateTier(tokenAmount);
  const pointsPerHour = getPointsForTier(tier);

  if (pointsPerHour === 0) return; // No points for tier 0

  // Generate time-based IDs - AMM pattern
  const hourlyTimestamp = getHourlyTimestamp(blockTime);
  const weekNumber = getWeekStartDate(blockTime);

  const hourlySnapshotId = `${userAddress}_${hourlyTimestamp}`;
  const snapshotHour = new Date(hourlyTimestamp * 1000).toISOString().split('T')[0] +
    `-${new Date(hourlyTimestamp * 1000).getUTCHours()}`;

  // Get existing hourly snapshot
  let hourlySnapshot = await context.HourlySnapshot.get(hourlySnapshotId);

  // If snapshot already exists for this hour, don't create duplicate
  if (hourlySnapshot) return;

  // Get weekly points record
  const weeklyPoints = await getOrCreateWeeklyPoints(
    userAddress,
    weekNumber,
    tier,
    context
  );

  // Check weekly cap
  const currentWeeklyPoints = Number(weeklyPoints.points_earned_this_week);
  const weeklyCap = getWeeklyCapForTier(tier);

  let actualPointsAwarded = 0;
  if (currentWeeklyPoints < weeklyCap) {
    actualPointsAwarded = Math.min(pointsPerHour, weeklyCap - currentWeeklyPoints);
  }

  // Create hourly snapshot
  const newHourlySnapshot: HourlySnapshot = {
    id: hourlySnapshotId,
    user_id: userAddress,
    user_address: userAddress,
    points_awarded: BigInt(actualPointsAwarded),
    tier_at_time: tier,
    balance_at_time_wei: newBalance,
    balance_at_time: tokenAmountToString(newBalance),
    snapshot_hour: snapshotHour,
    week_number: weekNumber,
    timestamp: BigInt(blockTime),
  };

  context.HourlySnapshot.set(newHourlySnapshot);

  // Update weekly points
  const updatedWeeklyPoints: UserWeeklyPoints = {
    ...weeklyPoints,
    points_earned_this_week: weeklyPoints.points_earned_this_week + BigInt(actualPointsAwarded),
    is_cap_reached: (currentWeeklyPoints + actualPointsAwarded) >= weeklyCap,
  };

  context.UserWeeklyPoints.set(updatedWeeklyPoints);

  // Update user total points
  const user = await context.User.get(userAddress);
  if (user) {
    const updatedUser: User = {
      ...user,
      total_points_earned: user.total_points_earned + BigInt(actualPointsAwarded),
    };
    context.User.set(updatedUser);
  }

  // Update global stats - track points distributed and current week/hour
  const globalStats = await getOrCreateGlobalStats(context);
  const updatedGlobalStats: GlobalStats = {
    ...globalStats,
    total_points_distributed: globalStats.total_points_distributed + BigInt(actualPointsAwarded),
    current_week_number: weekNumber,
    last_snapshot_hour: snapshotHour,
  };

  context.GlobalStats.set(updatedGlobalStats);
}

// ========== EVENT HANDLERS ==========

// Transfer Event Handler - Updates user balances and processes points
WMON.Transfer.handler(async ({ event, context }: { event: WMON_Transfer_event; context: handlerContext }) => {
  const { src, dst, wad } = event.params;
  const timestamp = event.block.timestamp;
  const blockNumber = event.block.number;
  const transactionHash = createTransactionId(event.block.hash, event.logIndex);

  // Create transfer record
  const transfer: Transfer = {
    id: `${event.chainId}_${blockNumber}_${event.logIndex}`,
    from: src,
    to: dst,
    amount_wei: wad,
    amount: tokenAmountToString(wad),
    timestamp: BigInt(timestamp),
    block_number: BigInt(blockNumber),
    transaction_hash: transactionHash,
  };

  context.Transfer.set(transfer);

  // Update sender balance and process points (if not mint)
  if (src !== ZERO_ADDRESS) {
    const { user: sender } = await getOrCreateUser(src, context);
    const currentBalance = sender.current_balance_wei;
    const newBalance = currentBalance - wad;

    const updatedSender = await updateUserBalance(sender, newBalance, timestamp, context);
    context.User.set(updatedSender);

    // Process hourly points for sender
    await processHourlyPointsForUser(src, newBalance, timestamp, context);
  }

  // Update receiver balance and process points (if not burn)
  if (dst !== ZERO_ADDRESS) {
    const { user: receiver, isNewUser } = await getOrCreateUser(dst, context);
    const currentBalance = receiver.current_balance_wei;
    const newBalance = currentBalance + wad;

    const updatedReceiver = await updateUserBalance(receiver, newBalance, timestamp, context);
    context.User.set(updatedReceiver);

    // If new user, increment total users count
    if (isNewUser) {
      const globalStats = await getOrCreateGlobalStats(context);
      const updatedGlobalStats: GlobalStats = {
        ...globalStats,
        total_users: globalStats.total_users + 1n,
      };
      context.GlobalStats.set(updatedGlobalStats);
    }

    // Process hourly points for receiver
    await processHourlyPointsForUser(dst, newBalance, timestamp, context);
  }
});

// Deposit Event Handler - WMON minting
WMON.Deposit.handler(async ({ event, context }: { event: WMON_Deposit_event; context: handlerContext }) => {
  const { dst, wad } = event.params;
  const timestamp = event.block.timestamp;
  const blockNumber = event.block.number;
  const transactionHash = createTransactionId(event.block.hash, event.logIndex);

  // Create deposit record
  const deposit: Deposit = {
    id: `${event.chainId}_${blockNumber}_${event.logIndex}`,
    user: dst,
    usdc_amount_wei: wad,
    usdc_amount: tokenAmountToString(wad),
    pawusdc_minted_wei: wad,
    pawusdc_minted: tokenAmountToString(wad),
    exchange_rate: "1.0",
    timestamp: BigInt(timestamp),
    block_number: BigInt(blockNumber),
    transaction_hash: transactionHash,
  };

  context.Deposit.set(deposit);

  // Update user balance and process points
  const { user, isNewUser } = await getOrCreateUser(dst, context);
  const newBalance = user.current_balance_wei + wad;
  const updatedUser = await updateUserBalance(user, newBalance, timestamp, context);
  context.User.set(updatedUser);

  // If new user, increment total users count
  if (isNewUser) {
    const globalStats = await getOrCreateGlobalStats(context);
    const updatedGlobalStats: GlobalStats = {
      ...globalStats,
      total_users: globalStats.total_users + 1n,
    };
    context.GlobalStats.set(updatedGlobalStats);
  }

  // Process hourly points
  await processHourlyPointsForUser(dst, newBalance, timestamp, context);
});

// Withdrawal Event Handler - WMON burning
WMON.Withdrawal.handler(async ({ event, context }: { event: WMON_Withdrawal_event; context: handlerContext }) => {
  const { src, wad } = event.params;
  const timestamp = event.block.timestamp;
  const blockNumber = event.block.number;
  const transactionHash = createTransactionId(event.block.hash, event.logIndex);

  // Create withdrawal record
  const withdrawal: Withdrawal = {
    id: `${event.chainId}_${blockNumber}_${event.logIndex}`,
    user: src,
    pawusdc_burned_wei: wad,
    pawusdc_burned: tokenAmountToString(wad),
    usdc_received_wei: wad,
    usdc_received: tokenAmountToString(wad),
    exchange_rate: "1.0",
    redemption_fee_wei: 0n,
    redemption_fee: "0.0",
    timestamp: BigInt(timestamp),
    block_number: BigInt(blockNumber),
    transaction_hash: transactionHash,
  };

  context.Withdrawal.set(withdrawal);

  // Update user balance and process points
  const { user } = await getOrCreateUser(src, context);
  const newBalance = user.current_balance_wei - wad;
  const updatedUser = await updateUserBalance(user, newBalance, timestamp, context);
  context.User.set(updatedUser);

  // Process hourly points
  await processHourlyPointsForUser(src, newBalance, timestamp, context);
});

// Approval Event Handler - Track approvals
WMON.Approval.handler(async ({ event, context }: { event: WMON_Approval_event; context: handlerContext }) => {
  const { src, guy, wad } = event.params;
  const timestamp = event.block.timestamp;
  const blockNumber = event.block.number;
  const transactionHash = createTransactionId(event.block.hash, event.logIndex);

  // Create approval record
  const approval: Approval = {
    id: `${event.chainId}_${blockNumber}_${event.logIndex}`,
    owner: src,
    spender: guy,
    amount_wei: wad,
    amount: tokenAmountToString(wad),
    timestamp: BigInt(timestamp),
    block_number: BigInt(blockNumber),
    transaction_hash: transactionHash,
  };

  context.Approval.set(approval);

  // Note: Approvals don't affect balance or points, so no further processing needed
});