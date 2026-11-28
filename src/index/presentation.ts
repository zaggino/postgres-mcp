import { ExplainPlanArtifact } from '../artifacts.ts';
import { UsageError } from '../errors.ts';
import { IndexDefinition } from '../sql/index-definition.ts';
import type { AdvisorRecommendation, AdvisorResult, QueryImpact } from './advisor-result.ts';
import { costBenefit, NO_COSTS } from './advisor-result.ts';
import type { IndexTuningResult } from './index-opt-base.ts';
import { IndexTuningBase } from './index-opt-base.ts';

/** The advisor result, plus its debug trace when POSTGRES_MCP_INCLUDE_LANGFUSE_TRACE asks for it. */
export interface AdvisorOutput {
  result: AdvisorResult;
  trace?: string[];
}

const LONG_TEXT_WARNING =
  'This index is potentially problematic because it includes a long text column. ' +
  'You might not be able to create this index if the index row size becomes too large ' +
  '(i.e., more than 8191 bytes).';

interface ExecuteAnalysisOptions {
  limit: number;
  maxIndexSizeMb: number;
  minAvgTimeMs: number;
  minCalls: number;
  queryList?: string[];
}

function warningFor(reason: string | null): string | undefined {
  if (reason === 'long_text_column') {
    return LONG_TEXT_WARNING;
  }
  return reason ? `This index is potentially problematic because it includes a ${reason} column.` : undefined;
}

/** Presentation of index tuning recommendations as the advisor tools' structured result. */
export class TextPresentation {
  readonly indexTuning: IndexTuningBase;

  constructor(indexTuning: IndexTuningBase) {
    this.indexTuning = indexTuning;
  }

  /**
   * Analyze the query history (frequently executed and costly queries) and
   * recommend indexes.
   */
  analyzeWorkload(maxIndexSizeMb: number): Promise<AdvisorOutput> {
    return this.executeAnalysis({
      minCalls: 50,
      minAvgTimeMs: 5,
      limit: 100,
      maxIndexSizeMb,
    });
  }

  /** Analyze a list of SQL queries and recommend indexes. */
  analyzeQueries(queries: string[], maxIndexSizeMb: number): Promise<AdvisorOutput> {
    // An empty list would fall through to the pg_stat_statements workload
    if (queries.length === 0) {
      return Promise.reject(new UsageError('No queries provided for analysis'));
    }
    return this.executeAnalysis({
      queryList: queries,
      // Ignore min calls, min time and limit for an explicit query list
      minCalls: 0,
      minAvgTimeMs: 0,
      limit: 0,
      maxIndexSizeMb,
    });
  }

  /** Execute indexing analysis; resolves with the recommendations, rejects when the analysis fails. */
  async executeAnalysis(options: ExecuteAnalysisOptions): Promise<AdvisorOutput> {
    const session = await this.indexTuning.analyzeWorkload(options);

    const analyses = session.recommendations;
    const [first] = analyses;
    const last = analyses.at(-1);
    const result: AdvisorResult = {
      summary: {
        total_recommendations: analyses.length,
        ...(first && last ? costBenefit(first.progressiveBaseCost, last.progressiveRecommendationCost) : NO_COSTS),
        total_size_bytes: analyses.reduce((total, rec) => total + rec.estimatedSizeBytes, 0),
      },
      recommendations: this.buildRecommendationsList(session),
      query_impact: await this.generateQueryImpact(session),
    };

    // Debugging output that costs an agent tokens on every call, so only on request
    const includeTrace = process.env.POSTGRES_MCP_INCLUDE_LANGFUSE_TRACE?.toLowerCase() === 'true';
    return includeTrace ? { result, trace: session.dtaTraces } : { result };
  }

  buildRecommendationsList(session: IndexTuningResult): AdvisorRecommendation[] {
    return session.recommendations.map((rec, i) => {
      const warning = warningFor(rec.potentialProblematicReason);
      return {
        index_apply_order: i + 1,
        index_target_table: rec.table,
        index_target_columns: [...rec.columns],
        benefit_of_this_index_only: costBenefit(rec.individualBaseCost, rec.individualRecommendationCost),
        benefit_after_previous_indexes: costBenefit(rec.progressiveBaseCost, rec.progressiveRecommendationCost),
        index_size_bytes: rec.estimatedSizeBytes,
        index_definition: rec.definition,
        ...(warning && { warning }),
      };
    });
  }

  /** The query impact section: before and after explain plans of each workload query. */
  async generateQueryImpact(session: IndexTuningResult): Promise<QueryImpact[]> {
    // All recommendations have the same queries
    const [firstRecommendation] = session.recommendations;
    if (!firstRecommendation) {
      return [];
    }

    // Remove duplicates while preserving order
    const uniqueQueries = [...new Set(firstRecommendation.queries)];

    const indexConfigs = session.recommendations.map((rec) => new IndexDefinition(rec.table, rec.columns, rec.using));

    const queryImpact: QueryImpact[] = [];
    // One query at a time: each explain replaces the hypothetical indexes on its connection
    for (const query of uniqueQueries) {
      const beforePlan = await this.indexTuning.getExplainPlanWithIndexes(query, []);
      const afterPlan = await this.indexTuning.getExplainPlanWithIndexes(query, indexConfigs);

      queryImpact.push({
        query,
        ...costBenefit(
          IndexTuningBase.extractCostFromJsonPlan(beforePlan),
          IndexTuningBase.extractCostFromJsonPlan(afterPlan)
        ),
        before_explain_plan: ExplainPlanArtifact.formatPlanSummary(beforePlan),
        after_explain_plan: ExplainPlanArtifact.formatPlanSummary(afterPlan),
        explain_plan_diff: ExplainPlanArtifact.createPlanDiff(beforePlan, afterPlan),
      });
    }

    return queryImpact;
  }
}
