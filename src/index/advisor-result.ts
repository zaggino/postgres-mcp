import { z } from 'zod';

const costBenefitSchema = z.object({
  base_cost: z.number().nullable().describe('Cost in planner cost units without the indexes; null when not finite'),
  new_cost: z.number().nullable().describe('Cost in planner cost units with the indexes; null when not finite'),
  improvement_multiple: z
    .number()
    .nullable()
    .describe('base_cost / new_cost; null when either cost is zero or not finite'),
});

const planText = z.string().nullable();

const recommendationSchema = z.object({
  index_apply_order: z.number().int().describe('1-based order in which to create the indexes'),
  index_target_table: z.string(),
  index_target_columns: z.array(z.string()),
  benefit_of_this_index_only: costBenefitSchema.describe('Workload cost with this index alone'),
  benefit_after_previous_indexes: costBenefitSchema.describe(
    'Workload cost with this index once the earlier recommendations exist'
  ),
  index_size_bytes: z.number().int().describe('Estimated index size in bytes'),
  index_definition: z.string(),
  warning: z.string().optional().describe('Present when the index may be problematic to create'),
});

const queryImpactSchema = z.object({
  query: z.string(),
  ...costBenefitSchema.shape,
  before_explain_plan: planText.describe(
    'Plain-text plan without the recommended indexes; null when the plan cannot be read'
  ),
  after_explain_plan: planText.describe(
    'Plain-text plan with all recommended indexes; null when the plan cannot be read'
  ),
  explain_plan_diff: planText.describe('Plain-text summary of the plan changes; null when a plan cannot be read'),
});

/** The structured result of analyze_workload_indexes and analyze_query_indexes, declared as their outputSchema. */
export const advisorResultSchema = z.object({
  summary: z.object({
    total_recommendations: z.number().int(),
    ...costBenefitSchema.shape,
    total_size_bytes: z.number().int().describe('Estimated size of all recommended indexes in bytes'),
  }),
  recommendations: z.array(recommendationSchema),
  query_impact: z.array(queryImpactSchema),
});

export type AdvisorResult = z.infer<typeof advisorResultSchema>;
export type AdvisorRecommendation = z.infer<typeof recommendationSchema>;
export type QueryImpact = z.infer<typeof queryImpactSchema>;
export type CostBenefit = z.infer<typeof costBenefitSchema>;

/** The costs when there is nothing to compare, such as a result with no recommendation. */
export const NO_COSTS: CostBenefit = { base_cost: null, new_cost: null, improvement_multiple: null };

/** The costs of one comparison and their ratio; one rule for every place the result reports an improvement. */
export function costBenefit(baseCost: number, newCost: number): CostBenefit {
  const base = Number.isFinite(baseCost) ? baseCost : null;
  const next = Number.isFinite(newCost) ? newCost : null;
  return {
    base_cost: base,
    new_cost: next,
    improvement_multiple: base !== null && next !== null && base > 0 && next > 0 ? base / next : null,
  };
}
