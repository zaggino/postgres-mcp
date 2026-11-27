import { calculateImprovementMultiple, ExplainPlanArtifact } from '../artifacts.ts';
import { errorMessage } from '../errors.ts';
import { logLine } from '../log.ts';
import { formatFixed, naturalSize } from '../py-format.ts';
import { IndexDefinition } from '../sql/index-definition.ts';
import type { SqlExecutor } from '../sql/safe-sql.ts';
import type { IndexTuningResult } from './index-opt-base.ts';
import { IndexTuningBase } from './index-opt-base.ts';

type JsonRecord = Record<string, unknown>;

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
   * recommend indexes. Resolves with the recommendations or an error.
   */
  analyzeWorkload(maxIndexSizeMb = 10_000): Promise<JsonRecord> {
    return this.executeAnalysis({
      minCalls: 50,
      minAvgTimeMs: 5,
      limit: 100,
      maxIndexSizeMb,
    });
  }

  /** Analyze a list of SQL queries and recommend indexes. */
  analyzeQueries(queries: string[], maxIndexSizeMb = 10_000): Promise<JsonRecord> {
    if (queries.length === 0) {
      return Promise.resolve({ error: 'No queries provided for analysis' });
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
  analyzeSingleQuery(query: string, maxIndexSizeMb = 10_000): Promise<JsonRecord> {
    return this.executeAnalysis({
      queryList: [query],
      minCalls: 0,
      minAvgTimeMs: 0,
      limit: 0,
      maxIndexSizeMb,
    });
  }

  /** Execute indexing analysis; resolves with the recommendations or an error. */
  async executeAnalysis(options: ExecuteAnalysisOptions): Promise<JsonRecord> {
    try {
      const session = await this.indexTuning.analyzeWorkload({
        queryList: options.queryList,
        minCalls: options.minCalls ?? 50,
        minAvgTimeMs: options.minAvgTimeMs ?? 5,
        limit: options.limit ?? 100,
        maxIndexSizeMb: options.maxIndexSizeMb ?? 10_000,
      });

      // Prepare the response to send back to the caller
      const includeLangfuseTrace = (process.env.POSTGRES_MCP_INCLUDE_LANGFUSE_TRACE ?? 'true').toLowerCase() === 'true';
      const langfuseTrace: JsonRecord = includeLangfuseTrace ? { _langfuse_trace: session.dtaTraces } : {};

      if (session.error) {
        return { error: session.error, ...langfuseTrace };
      }

      const { recommendations: analyses } = session;
      const [firstRecommendation] = analyses;
      const lastRecommendation = analyses.at(-1);
      if (!(firstRecommendation && lastRecommendation)) {
        return {
          recommendations: 'No index recommendations found.',
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
          base_cost: formatFixed(initialCost, 1),
          new_cost: formatFixed(newCost, 1),
          total_size_bytes: naturalSize(totalSizeBytes),
          improvement_multiple: formatFixed(improvementMultiple, 1),
        },
        recommendations,
        query_impact: queryImpact,
        ...langfuseTrace,
      };
    } catch (error) {
      logLine(`Error analyzing queries: ${errorMessage(error)}`);
      return { error: `Error analyzing queries: ${errorMessage(error)}` };
    }
  }

  buildRecommendationsList(session: IndexTuningResult): JsonRecord[] {
    return session.recommendations.map((rec, i) => {
      const recDict: JsonRecord = {
        index_apply_order: i + 1,
        index_target_table: rec.table,
        index_target_columns: [...rec.columns],
        benefit_of_this_index_only: {
          improvement_multiple: formatFixed(rec.individualImprovementMultiple, 1),
          base_cost: formatFixed(rec.individualBaseCost, 1),
          new_cost: formatFixed(rec.individualRecommendationCost, 1),
        },
        benefit_after_previous_indexes: {
          improvement_multiple: formatFixed(rec.progressiveImprovementMultiple, 1),
          base_cost: formatFixed(rec.progressiveBaseCost, 1),
          new_cost: formatFixed(rec.progressiveRecommendationCost, 1),
        },
        index_estimated_size: naturalSize(rec.estimatedSizeBytes),
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
  async generateQueryImpact(session: IndexTuningResult): Promise<JsonRecord[]> {
    const queryImpact: JsonRecord[] = [];

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

      // Shown when the new cost is zero
      let improvementMultiple = '∞';
      if (newCost > 0 && baseCost > 0) {
        improvementMultiple = formatFixed(calculateImprovementMultiple(baseCost, newCost), 1);
      }

      const beforePlanText = ExplainPlanArtifact.formatPlanSummary(beforePlan);
      const afterPlanText = ExplainPlanArtifact.formatPlanSummary(afterPlan);
      const diffText = ExplainPlanArtifact.createPlanDiff(beforePlan, afterPlan);

      queryImpact.push({
        query,
        base_cost: formatFixed(baseCost, 1),
        new_cost: formatFixed(newCost, 1),
        improvement_multiple: improvementMultiple,
        before_explain_plan: `\`\`\`\n${beforePlanText}\n\`\`\``,
        after_explain_plan: `\`\`\`\n${afterPlanText}\n\`\`\``,
        explain_plan_diff: `\`\`\`\n${diffText}\n\`\`\``,
      });
    }

    return queryImpact;
  }
}
