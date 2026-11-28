import { z } from 'zod';

const cost = z.number().nullable().describe('Planner cost units; null when not finite');

const costBenefitShape = {
  base_cost: cost.describe('Cost in planner cost units without the indexes; null when not finite'),
  new_cost: cost.describe('Cost in planner cost units with the indexes; null when not finite'),
  improvement_multiple: z
    .number()
    .nullable()
    .describe('base_cost / new_cost; null when either cost is zero or not finite'),
};

const recommendationSchema = z.object({
  index_apply_order: z.number().int().describe('1-based order in which to create the indexes'),
  index_target_table: z.string(),
  index_target_columns: z.array(z.string()),
  benefit_of_this_index_only: z.object(costBenefitShape).describe('Workload cost with this index alone'),
  benefit_after_previous_indexes: z
    .object(costBenefitShape)
    .describe('Workload cost with this index once the earlier recommendations exist'),
  index_size_bytes: z.number().int().describe('Estimated index size in bytes'),
  index_definition: z.string(),
  warning: z.string().optional().describe('Present when the index may be problematic to create'),
});

const queryImpactSchema = z.object({
  query: z.string(),
  ...costBenefitShape,
  before_explain_plan: z.string().describe('Plain-text plan summary without the recommended indexes'),
  after_explain_plan: z.string().describe('Plain-text plan summary with all recommended indexes'),
  explain_plan_diff: z.string(),
});

/** The structured result of analyze_workload_indexes and analyze_query_indexes, declared as their outputSchema. */
export const advisorResultSchema = z.object({
  summary: z.object({
    total_recommendations: z.number().int(),
    ...costBenefitShape,
    total_size_bytes: z.number().int().describe('Estimated size of all recommended indexes in bytes'),
  }),
  recommendations: z.array(recommendationSchema),
  query_impact: z.array(queryImpactSchema),
});

export type AdvisorResult = z.infer<typeof advisorResultSchema>;
export type AdvisorRecommendation = z.infer<typeof recommendationSchema>;
export type QueryImpact = z.infer<typeof queryImpactSchema>;
export type CostBenefit = z.infer<z.ZodObject<typeof costBenefitShape>>;

function finiteOrNull(value: number): number | null {
  return Number.isFinite(value) ? value : null;
}

/** The costs of one comparison and their ratio; one rule for every place the result reports an improvement. */
export function costBenefit(baseCost: number, newCost: number): CostBenefit {
  const multiple = baseCost > 0 && newCost > 0 ? baseCost / newCost : Number.NaN;
  return {
    base_cost: finiteOrNull(baseCost),
    new_cost: finiteOrNull(newCost),
    improvement_multiple: finiteOrNull(multiple),
  };
}
