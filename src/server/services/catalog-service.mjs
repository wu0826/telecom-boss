import { openRuntimeDatabase } from '../db/runtime-database.mjs';

function formatMinorUnits(value) {
  const amount = BigInt(value);
  const sign = amount < 0n ? '-' : '';
  const digits = (amount < 0n ? -amount : amount).toString().padStart(3, '0');
  return `${sign}${digits.slice(0, -2)}.${digits.slice(-2)}`;
}

function priceLabel(price) {
  if (price.price_type === 'INTRO' && price.month_from && price.month_to) {
    return `第 ${price.month_from}–${price.month_to} 個月`;
  }
  if (price.price_type === 'RENEWAL' && price.month_from) {
    return `第 ${price.month_from} 個月起`;
  }
  if (price.billing_cycle === 'ONE_TIME') return '一次性費用';
  return '標準月租';
}

async function getCatalogProjection(telecomDatabasePath, { planId = null, includeInactivePlan = false, clock = Date.now } = {}) {
  const database = openRuntimeDatabase(telecomDatabasePath);
  try {
    const now = new Date(clock());
    if (Number.isNaN(now.getTime())) throw new Error('Catalog clock must return a valid timestamp');
    const today = now.toISOString().slice(0, 10);
    const nowValue = database.kind === 'mysql'
      ? now.toISOString().replace('T', ' ').replace('Z', '')
      : now.toISOString();
    const plans = await database.prepare(`
      SELECT
        id,
        plan_code,
        plan_name,
        service_category,
        technology,
        download_mbps,
        upload_mbps,
        bandwidth_label,
        contract_months,
        wifi_included,
        description
      FROM service_plans
      WHERE (? = 1 OR (
        is_active = 1
        AND (effective_from IS NULL OR effective_from <= ?)
        AND (effective_to IS NULL OR effective_to >= ?)
      ))
        AND (? IS NULL OR id = ?)
      ORDER BY download_mbps, id
    `).all(includeInactivePlan ? 1 : 0, today, today, planId, planId);
    const prices = await database.prepare(`
      SELECT
        prices.service_plan_id,
        prices.price_type,
        prices.billing_cycle,
        prices.amount,
        prices.month_from,
        prices.month_to
      FROM plan_prices AS prices
      JOIN service_plans AS plans ON plans.id = prices.service_plan_id
      WHERE plans.is_active = 1
        AND prices.is_active = 1
        AND (prices.effective_from IS NULL OR prices.effective_from <= ?)
        AND (prices.effective_to IS NULL OR prices.effective_to >= ?)
      ORDER BY prices.service_plan_id, prices.priority, prices.month_from, prices.id
    `).all(today, today);
    const promotions = await database.prepare(`
      SELECT
        links.service_plan_id,
        promotions.promotion_code,
        promotions.promotion_name,
        promotions.description,
        promotions.gift_quantity,
        equipment.model_code,
        equipment.brand,
        equipment.model_name
      FROM promotion_plans AS links
      JOIN promotions ON promotions.id = links.promotion_id
      LEFT JOIN equipment_models AS equipment
        ON equipment.id = promotions.gift_equipment_model_id
      WHERE promotions.is_active = 1
        AND (promotions.starts_at IS NULL OR promotions.starts_at <= ?)
        AND (promotions.ends_at IS NULL OR promotions.ends_at >= ?)
      ORDER BY links.service_plan_id, promotions.id
    `).all(nowValue, nowValue);

    const pricesByPlan = Map.groupBy(prices, ({ service_plan_id }) => service_plan_id);
    const promotionsByPlan = Map.groupBy(promotions, ({ service_plan_id }) => service_plan_id);
    return {
      brand: {
        name: '比奇堡電信',
        tagline: '社區網路，穩定連結每一天',
      },
      plans: plans.map((plan) => {
        const planPrices = (pricesByPlan.get(plan.id) ?? []).map((price) => ({
          type: price.price_type,
          billingCycle: price.billing_cycle,
          amount: formatMinorUnits(price.amount),
          monthFrom: price.month_from,
          monthTo: price.month_to,
          label: priceLabel(price),
        }));
        const monthlyPrices = planPrices.filter(({ billingCycle }) => billingCycle === 'MONTHLY');
        const lowestMonthlyAmount = monthlyPrices
          .map(({ amount }) => amount)
          .toSorted((left, right) => Number(left) - Number(right))
          .at(0) ?? null;

        return {
          id: plan.id,
          code: plan.plan_code,
          name: plan.plan_name,
          category: plan.service_category,
          technology: plan.technology,
          downloadMbps: plan.download_mbps,
          uploadMbps: plan.upload_mbps,
          bandwidthLabel: plan.bandwidth_label,
          contractMonths: plan.contract_months,
          wifiIncluded: Boolean(plan.wifi_included),
          description: plan.description,
          lowestMonthlyAmount,
          prices: planPrices,
          promotions: (promotionsByPlan.get(plan.id) ?? []).map((promotion) => ({
            code: promotion.promotion_code,
            name: promotion.promotion_name,
            description: promotion.description,
            gift: promotion.model_code ? {
              quantity: promotion.gift_quantity,
              modelCode: promotion.model_code,
              brand: promotion.brand,
              modelName: promotion.model_name,
            } : null,
          })),
        };
      }),
    };
  } finally {
    await database.close();
  }
}

export async function getPublicCatalog(telecomDatabasePath, options = {}) {
  return getCatalogProjection(telecomDatabasePath, options);
}

export async function getCatalogPlanPreview(telecomDatabasePath, planId, options = {}) {
  return (await getCatalogProjection(telecomDatabasePath, {
    ...options,
    planId,
    includeInactivePlan: true,
  })).plans.at(0) ?? null;
}

export async function getPublicPlan(telecomDatabasePath, planId, options = {}) {
  return (await getPublicCatalog(telecomDatabasePath, options)).plans.find(({ id }) => id === planId) ?? null;
}
