import { calculateImprovementMultiple, ExplainPlanArtifact } from '../artifacts.ts';
import { UsageError } from '../errors.ts';
import { IndexDefinition } from '../sql/index-definition.ts';
import type { SqlExecutor } from '../sql/safe-sql.ts';
import type { AdvisorResult } from './advisor-result.ts';
import { finiteOrNull } from './advisor-result.ts';
import type { IndexTuningResult } from './index-opt-base.ts';
import { IndexTuningBase } from './index-opt-base.ts';

const LONG_TEXT_WARNING =
  'This index is potentially problematic because it includes a long text column. ' +
  'You might not be able to create this index if the index row size becomes too large ' +
  '(i.e., more than 8191 bytes).';

interface ExecuteAnalysisOptions {
  limit?: number;
  maxIndexSizeMb?: number;
  minAvgTimeMs?: number;
  minCalls?: number;
  queryList?: string[];
}

/** Text-based presentation of index tuning recommendations. */
export class TextPresentation {
  readonly sqlDriver: SqlExecutor;
  readonly indexTuning: IndexTuningBase;

  constructor(sqlDriver: SqlExecutor, indexTuning: IndexTuningBase) {
    this.sqlDriver = sqlDriver;
    this.indexTuning = indexTuning;
  }

  /**
   * Analyze the query history (frequently executed and costly queries) and
   * recommend indexes.
   */
  analyzeWorkload(maxIndexSizeMb = 10_000): Promise<AdvisorResult> {
    return this.executeAnalysis({
      minCalls: 50,
      minAvgTimeMs: 5,
      limit: 100,
      maxIndexSizeMb,
    });
  }

  /** Analyze a list of SQL queries and recommend indexes. */
  analyzeQueries(queries: string[], maxIndexSizeMb = 10_000): Promise<AdvisorResult> {
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

  /** Analyze a single SQL query and recommend indexes. */
  analyzeSingleQuery(query: string, maxIndexSizeMb = 10_000): Promise<AdvisorResult> {
    return this.executeAnalysis({
      queryList: [query],
      minCalls: 0,
      minAvgTimeMs: 0,
      limit: 0,
      maxIndexSizeMb,
    });
  }

  /** Execute indexing analysis; resolves with the recommendations, rejects when the analysis fails. */
  async executeAnalysis(options: ExecuteAnalysisOptions): Promise<AdvisorResult> {
    const session = await this.indexTuning.analyzeWorkload({
      queryList: options.queryList,
      minCalls: options.minCalls ?? 50,
      minAvgTimeMs: options.minAvgTimeMs ?? 5,
      limit: options.limit ?? 100,
      maxIndexSizeMb: options.maxIndexSizeMb ?? 10_000,
    });

    // Debugging output that costs an agent tokens on every call, so only on request
    const includeLangfuseTrace = process.env.POSTGRES_MCP_INCLUDE_LANGFUSE_TRACE?.toLowerCase() === 'true';
    const langfuseTrace: { _langfuse_trace?: string[] } = includeLangfuseTrace
      ? { _langfuse_trace: session.dtaTraces }
      : {};

    const { recommendations: analyses } = session;
    const [firstRecommendation] = analyses;
    const lastRecommendation = analyses.at(-1);
    if (!(firstRecommendation && lastRecommendation)) {
      return {
        summary: {
          total_recommendations: 0,
          base_cost: null,
          new_cost: null,
          improvement_multiple: null,
          total_size_bytes: 0,
        },
        recommendations: [],
        query_impact: [],
        ...langfuseTrace,
      };
    }

    const totalSizeBytes = analyses.reduce((total, rec) => total + rec.estimatedSizeBytes, 0);

    // Overall performance improvement
    const initialCost = firstRecommendation.progressiveBaseCost;
    const newCost = lastRecommendation.progressiveRecommendationCost;
    const improvementMultiple = calculateImprovementMultiple(initialCost, newCost);

    const recommendations = this.buildRecommendationsList(session);
    const queryImpact = await this.generateQueryImpact(session);

    return {
      summary: {
        total_recommendations: analyses.length,
        base_cost: finiteOrNull(initialCost),
        new_cost: finiteOrNull(newCost),
        improvement_multiple: finiteOrNull(improvementMultiple),
        total_size_bytes: totalSizeBytes,
      },
      recommendations,
      query_impact: queryImpact,
      ...langfuseTrace,
    };
  }

  buildRecommendationsList(session: IndexTuningResult): AdvisorResult['recommendations'] {
    return session.recommendations.map((rec, i) => {
      const recDict: AdvisorResult['recommendations'][number] = {
        index_apply_order: i + 1,
        index_target_table: rec.table,
        index_target_columns: [...rec.columns],
        benefit_of_this_index_only: {
          improvement_multiple: finiteOrNull(rec.individualImprovementMultiple),
          base_cost: finiteOrNull(rec.individualBaseCost),
          new_cost: finiteOrNull(rec.individualRecommendationCost),
        },
        benefit_after_previous_indexes: {
          improvement_multiple: finiteOrNull(rec.progressiveImprovementMultiple),
          base_cost: finiteOrNull(rec.progressiveBaseCost),
          new_cost: finiteOrNull(rec.progressiveRecommendationCost),
        },
        index_size_bytes: rec.estimatedSizeBytes,
        index_definition: rec.definition,
      };
      const reason = rec.potentialProblematicReason;
      if (reason === 'long_text_column') {
        recDict.warning = LONG_TEXT_WARNING;
      } else if (reason) {
        recDict.warning = `This index is potentially problematic because it includes a ${reason} column.`;
      }
      return recDict;
    });
  }

  /** The query impact section: before and after explain plans of each workload query. */
  async generateQueryImpact(session: IndexTuningResult): Promise<AdvisorResult['query_impact']> {
    const queryImpact: AdvisorResult['query_impact'] = [];

    // All recommendations have the same queries
    const [firstRecommendation] = session.recommendations;
    if (!firstRecommendation) {
      return queryImpact;
    }

    // Remove duplicates while preserving order
    const uniqueQueries = [...new Set(firstRecommendation.queries)];

    const indexConfigs = session.recommendations.map((rec) => new IndexDefinition(rec.table, rec.columns, rec.using));

    for (const query of uniqueQueries) {
      // Plan with no indexes
      const beforePlan = await this.indexTuning.getExplainPlanWithIndexes(query, []);

      // Plan with all recommended indexes
      const afterPlan = await this.indexTuning.getExplainPlanWithIndexes(query, indexConfigs);

      const baseCost = IndexTuningBase.extractCostFromJsonPlan(beforePlan);
      const newCost = IndexTuningBase.extractCostFromJsonPlan(afterPlan);

      // Null when either cost is zero or not a plan cost
      const improvementMultiple =
        newCost > 0 && baseCost > 0 ? finiteOrNull(calculateImprovementMultiple(baseCost, newCost)) : null;

      const beforePlanText = ExplainPlanArtifact.formatPlanSummary(beforePlan);
      const afterPlanText = ExplainPlanArtifact.formatPlanSummary(afterPlan);
      const diffText = ExplainPlanArtifact.createPlanDiff(beforePlan, afterPlan);

      queryImpact.push({
        query,
        base_cost: finiteOrNull(baseCost),
        new_cost: finiteOrNull(newCost),
        improvement_multiple: improvementMultiple,
        before_explain_plan: `\`\`\`\n${beforePlanText}\n\`\`\``,
        after_explain_plan: `\`\`\`\n${afterPlanText}\n\`\`\``,
        explain_plan_diff: `\`\`\`\n${diffText}\n\`\`\``,
      });
    }

    return queryImpact;
  }
}
