/** Artifacts for the Database Tuning Advisor. */

import { structuredPatch } from 'diff';

// If the recommendation cost is 0.0, we can't calculate the improvement multiple.
// Return 1000000.0 to indicate infinite improvement.
export const INFINITE_IMPROVEMENT_MULTIPLIER = 1_000_000;

const MAX_FILTER_LENGTH = 100;

type JsonObject = Record<string, unknown>;

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Simple error result class; `cause` keeps the error it was built from. */
export class ErrorResult {
  readonly value: string;
  readonly cause: unknown;

  constructor(message: string, options?: { cause?: unknown }) {
    this.value = message;
    this.cause = options?.cause;
  }

  toText(): string {
    return this.value;
  }
}

/** Calculate the improvement multiple from this recommendation. */
export function calculateImprovementMultiple(baseCost: number, recCost: number): number {
  if (baseCost <= 0) {
    // base_cost or rec_cost might be zero, but as they are floats, they might be
    // represented as -0.0. That's why we compare to <= 0.0.
    return 1;
  }
  if (recCost <= 0) {
    return INFINITE_IMPROVEMENT_MULTIPLIER;
  }
  return baseCost / recCost;
}

function requireField(node: JsonObject, key: string): unknown {
  if (!(key in node)) {
    throw new Error(`'${key}'`);
  }
  return node[key];
}

function requireNumber(node: JsonObject, key: string): number {
  const value = requireField(node, key);
  if (typeof value !== 'number') {
    throw new TypeError(`Expected a number for '${key}'`);
  }
  return value;
}

function optionalNumber(node: JsonObject, key: string): number | null {
  const value = requireField(node, key);
  return typeof value === 'number' ? value : null;
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

export class PlanNode {
  nodeType: string;
  totalCost: number;
  startupCost: number;
  planRows: number;
  planWidth: number;

  // Actual metrics from ANALYZE
  actualTotalTime: number | null = null;
  actualStartupTime: number | null = null;
  actualRows: number | null = null;
  actualLoops: number | null = null;

  // Buffer info
  sharedHitBlocks: number | null = null;
  sharedReadBlocks: number | null = null;
  sharedWrittenBlocks: number | null = null;

  // Other common fields
  relationName: string | null = null;
  filter: string | null = null;
  children: PlanNode[] = [];

  constructor(nodeType: string, totalCost: number, startupCost: number, planRows: number, planWidth: number) {
    this.nodeType = nodeType;
    this.totalCost = totalCost;
    this.startupCost = startupCost;
    this.planRows = planRows;
    this.planWidth = planWidth;
  }

  static fromJsonData(jsonNode: unknown): PlanNode {
    if (!isJsonObject(jsonNode)) {
      throw new TypeError('Plan node must be an object');
    }

    const nodeType = requireField(jsonNode, 'Node Type');
    if (typeof nodeType !== 'string') {
      throw new TypeError("Expected a string for 'Node Type'");
    }
    const node = new PlanNode(
      nodeType,
      requireNumber(jsonNode, 'Total Cost'),
      requireNumber(jsonNode, 'Startup Cost'),
      requireNumber(jsonNode, 'Plan Rows'),
      requireNumber(jsonNode, 'Plan Width')
    );

    // Optional ANALYZE fields
    if ('Actual Total Time' in jsonNode) {
      node.actualTotalTime = optionalNumber(jsonNode, 'Actual Total Time');
      node.actualStartupTime = optionalNumber(jsonNode, 'Actual Startup Time');
      node.actualRows = optionalNumber(jsonNode, 'Actual Rows');
      node.actualLoops = optionalNumber(jsonNode, 'Actual Loops');
    }

    // Optional BUFFERS fields
    if ('Shared Hit Blocks' in jsonNode) {
      node.sharedHitBlocks = optionalNumber(jsonNode, 'Shared Hit Blocks');
      node.sharedReadBlocks = optionalNumber(jsonNode, 'Shared Read Blocks');
      node.sharedWrittenBlocks = optionalNumber(jsonNode, 'Shared Written Blocks');
    }

    // Common optional fields
    if ('Relation Name' in jsonNode) {
      node.relationName = optionalString(jsonNode['Relation Name']);
    }
    if ('Filter' in jsonNode) {
      node.filter = optionalString(jsonNode.Filter);
    }

    // Recursively process child plans
    if ('Plans' in jsonNode) {
      const plans = jsonNode.Plans;
      if (!Array.isArray(plans)) {
        throw new TypeError("'Plans' must be a list");
      }
      node.children = plans.map((child: unknown) => PlanNode.fromJsonData(child));
    }

    return node;
  }
}

function formatPlanNode(node: PlanNode, level = 0): string {
  const indent = '  '.repeat(level);
  let output = `${indent}→ ${node.nodeType} (Cost: ${node.startupCost.toFixed(2)}..${node.totalCost.toFixed(2)})`;

  // Add table name if present
  if (node.relationName) {
    output += ` on ${node.relationName}`;
  }

  // Add rows information
  output += ` [Rows: ${node.planRows}]`;

  // Add actual metrics if available in a compact form
  if (node.actualTotalTime !== null) {
    output += ` [Actual: ${node.actualStartupTime?.toFixed(2)}..${node.actualTotalTime.toFixed(2)} ms, Rows: ${node.actualRows}, Loops: ${node.actualLoops}]`;
  }

  // Add filter if present
  if (node.filter) {
    // Truncate long filters for readability (by code point)
    // oxlint-disable-next-line typescript/no-misused-spread -- truncation is by code point on purpose
    const chars = [...node.filter];
    const filterText =
      chars.length > MAX_FILTER_LENGTH ? `${chars.slice(0, MAX_FILTER_LENGTH - 3).join('')}...` : node.filter;
    output += `\n${indent}  Filter: ${filterText}`;
  }

  // Add buffer information if available in a compact form
  if (node.sharedHitBlocks !== null) {
    output += `\n${indent}  Buffers - hit: ${node.sharedHitBlocks}, read: ${node.sharedReadBlocks}, written: ${node.sharedWrittenBlocks}`;
  }

  // Recursively format children
  for (const child of node.children) {
    output += `\n${formatPlanNode(child, level + 1)}`;
  }

  return output;
}

function extractNodeTypes(node: PlanNode, level = 0, result: string[] = []): string[] {
  const indent = '  '.repeat(level);
  let nodeInfo = `${indent}→ ${node.nodeType}`;
  if (node.relationName) {
    nodeInfo += ` on ${node.relationName}`;
  }
  result.push(nodeInfo);
  for (const child of node.children) {
    extractNodeTypes(child, level + 1, result);
  }
  return result;
}

/** Format a range the way Python's difflib does for unified diffs. */
function formatRange(start: number, length: number): string {
  if (length === 1) {
    return String(start);
  }
  return `${length === 0 ? start - 1 : start},${length}`;
}

/** Equivalent of `difflib.unified_diff(a, b, n=1, lineterm="")`. */
function unifiedDiff(before: readonly string[], after: readonly string[]): string[] {
  const joinLines = (items: readonly string[]): string =>
    items
      .map(
        (line) => `${line}
`
      )
      .join('');
  const patch = structuredPatch('', '', joinLines(before), joinLines(after), '', '', {
    context: 1,
  });
  if (patch.hunks.length === 0) {
    return [];
  }
  const lines = ['--- ', '+++ '];
  for (const hunk of patch.hunks) {
    lines.push(
      `@@ -${formatRange(hunk.oldStart, hunk.oldLines)} +${formatRange(hunk.newStart, hunk.newLines)} @@`,
      ...hunk.lines
    );
  }
  return lines;
}

export class ExplainPlanArtifact {
  value: string;
  planTree: PlanNode;
  planningTime: number | null;
  executionTime: number | null;

  constructor(
    value: string,
    planTree: PlanNode,
    planningTime: number | null = null,
    executionTime: number | null = null
  ) {
    this.value = value;
    this.planTree = planTree;
    this.planningTime = planningTime;
    this.executionTime = executionTime;
  }

  /** A string representation of the execution plan with timing information. */
  toText(): string {
    const result: string[] = [];

    // Add timing information if available
    if (this.planningTime !== null) {
      result.push(`Planning Time: ${this.planningTime.toFixed(3)} ms`);
    }
    if (this.executionTime !== null) {
      result.push(`Execution Time: ${this.executionTime.toFixed(3)} ms`);
    }

    // Add plan tree representation
    result.push(formatPlanNode(this.planTree));

    return result.join('\n');
  }

  static fromJsonData(planData: unknown): ExplainPlanArtifact {
    if (!(isJsonObject(planData) && 'Plan' in planData)) {
      throw new Error("Missing 'Plan' field in explain plan data");
    }

    // Create plan tree from the "Plan" field
    const planTree = PlanNode.fromJsonData(planData.Plan);

    // Extract optional timing information
    const planningTime = planData['Planning Time'];
    const executionTime = planData['Execution Time'];

    return new ExplainPlanArtifact(
      JSON.stringify(planData, null, 2),
      planTree,
      typeof planningTime === 'number' ? planningTime : null,
      typeof executionTime === 'number' ? executionTime : null
    );
  }

  /** Extract and format key information from raw plan data. */
  static formatPlanSummary(planData: Record<string, unknown> | null | undefined): string {
    if (!planData || Object.keys(planData).length === 0) {
      return 'No plan data available';
    }

    try {
      if ('Plan' in planData) {
        return formatPlanNode(PlanNode.fromJsonData(planData.Plan), 0);
      }
      return 'Invalid plan data (missing Plan field)';
    } catch (error) {
      return `Error summarizing plan: ${errorMessage(error)}`;
    }
  }

  /** Generate a textual diff between two explain plans. */
  static createPlanDiff(
    beforePlan: Record<string, unknown> | null | undefined,
    afterPlan: Record<string, unknown> | null | undefined
  ): string {
    if (!beforePlan || Object.keys(beforePlan).length === 0 || !afterPlan || Object.keys(afterPlan).length === 0) {
      return 'Cannot generate diff: Missing plan data';
    }

    try {
      const beforeTree = 'Plan' in beforePlan ? PlanNode.fromJsonData(beforePlan.Plan) : null;
      const afterTree = 'Plan' in afterPlan ? PlanNode.fromJsonData(afterPlan.Plan) : null;

      if (!(beforeTree && afterTree)) {
        return 'Cannot generate diff: Invalid plan structure';
      }

      const beforeLines = formatPlanNode(beforeTree).split('\n');
      const afterLines = formatPlanNode(afterTree).split('\n');

      const diffLines: string[] = ['PLAN CHANGES:', '------------'];

      const beforeCost = beforeTree.totalCost;
      const afterCost = afterTree.totalCost;
      const improvement = calculateImprovementMultiple(beforeCost, afterCost);

      diffLines.push(
        `Cost: ${beforeCost.toFixed(2)} → ${afterCost.toFixed(2)} (${improvement.toFixed(1)}x improvement)`,
        '',
        'Operation Changes:'
      );

      const structureDiff = unifiedDiff(extractNodeTypes(beforeTree), extractNodeTypes(afterTree));
      if (structureDiff.length > 0) {
        diffLines.push(...structureDiff);
      } else {
        diffLines.push('No structural changes detected');
      }

      diffLines.push('', 'Major Changes:');

      if (beforeTree.nodeType !== afterTree.nodeType) {
        diffLines.push(`- Root operation changed: ${beforeTree.nodeType} → ${afterTree.nodeType}`);
      }

      // Compare scan methods used
      const countMatching = (lines: string[], needle: string): number =>
        lines.filter((line) => line.includes(needle)).length;
      const beforeScans = countMatching(beforeLines, 'Seq Scan');
      const afterScans = countMatching(afterLines, 'Seq Scan');
      if (beforeScans > afterScans) {
        diffLines.push(`- ${beforeScans - afterScans} sequential scans replaced with more efficient access methods`);
      }

      // Look for new index scans
      const beforeIdxScans = countMatching(beforeLines, 'Index Scan');
      const afterIdxScans = countMatching(afterLines, 'Index Scan');
      if (afterIdxScans > beforeIdxScans) {
        diffLines.push(`- ${afterIdxScans - beforeIdxScans} new index scans used`);
      }

      return diffLines.join('\n');
    } catch (error) {
      return `Error generating plan diff: ${errorMessage(error)}`;
    }
  }
}
