import { z } from 'zod';

/** A number for JSON output; null when the value is not finite (Infinity or NaN). */
export function finiteOrNull(value: number): number | null {
  return Number.isFinite(value) ? value : null;
}

const cost = z
  .number()
  .nullable()
  .describe('Planner cost units (or an improvement multiple); null when the value is not finite');

const improvementMultiple = z
  .number()
  .nullable()
  .describe('base_cost / new_cost; null when not finite or a cost is zero');

const benefit = {
  improvement_multiple: improvementMultiple,
  base_cost: cost,
  new_cost: cost,
};

export const advisorResultSchema = z.object({
  summary: z.object({
    total_recommendations: z.number().int(),
    base_cost: cost.describe(
      'Workload cost in planner cost units without the recommended indexes; null when not finite'
    ),
    new_cost: cost.describe('Workload cost in planner cost units with all recommended indexes; null when not finite'),
    improvement_multiple: improvementMultiple,
    total_size_bytes: z.number().describe('Estimated size of all recommended indexes in bytes'),
  }),
  recommendations: z.array(
    z.object({
      index_apply_order: z.number().int().describe('1-based order in which to create the indexes'),
      index_target_table: z.string(),
      index_target_columns: z.array(z.string()),
      benefit_of_this_index_only: z.object(benefit).describe('Benefit of this index alone'),
      benefit_after_previous_indexes: z
        .object(benefit)
        .describe('Benefit of this index once the earlier recommendations exist'),
      index_size_bytes: z.number().describe('Estimated index size in bytes'),
      index_definition: z.string(),
      warning: z.string().optional().describe('Present when the index may be problematic to create'),
    })
  ),
  query_impact: z.array(
    z.object({
      query: z.string(),
      base_cost: cost,
      new_cost: cost,
      improvement_multiple: improvementMultiple,
      before_explain_plan: z.string().describe('Plain-text plan summary without the recommended indexes'),
      after_explain_plan: z.string().describe('Plain-text plan summary with all recommended indexes'),
      explain_plan_diff: z.string(),
    })
  ),
  _langfuse_trace: z
    .array(z.string())
    .optional()
    .describe('Advisor debug trace; only with POSTGRES_MCP_INCLUDE_LANGFUSE_TRACE'),
});

export type AdvisorResult = z.infer<typeof advisorResultSchema>;
