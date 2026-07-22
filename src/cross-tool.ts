import type {
  Axis,
  CapabilityImbalance,
  ClassificationOutput,
  CrossToolDuplicate,
  CrossToolReport,
  Inventory,
  RulesOverlap,
  ToolMeta,
  Usage,
} from './types.js';
import { AXES } from './types.js';

/**
 * Cross-tool diagnostics (SPEC_V2 §4.5) — the insights only a unified map
 * can give. Pure function, no I/O; every guard errs toward silence over a
 * wrong claim.
 */

const IMBALANCE_THRESHOLD = 0.8;

/** Instruction-file names worth flagging when they coexist across tools. */
const RULES_FILE_PATTERN = /(AGENTS\.md|CLAUDE\.md|GEMINI\.md|\.cursorrules|\.mdc)$/i;

function displayName(tools: ToolMeta[], name: string): string {
  return tools.find((t) => t.name === name)?.displayName ?? name;
}

function duplicates(
  inventory: Inventory,
  usage: Usage,
  tools: ToolMeta[],
): CrossToolDuplicate[] {
  const byIdentity = new Map<string, typeof inventory.items>();
  for (const item of inventory.items) {
    if (item.kind !== 'mcp' || item.identity === undefined) continue;
    byIdentity.set(item.identity, [...(byIdentity.get(item.identity) ?? []), item]);
  }

  const findings: CrossToolDuplicate[] = [];
  for (const [key, items] of byIdentity) {
    const toolNames = [...new Set(items.map((i) => i.tool).filter((t): t is string => t !== undefined))];
    if (toolNames.length < 2) continue;

    const usageSupportOf = (tool: string): string =>
      tools.find((t) => t.name === tool)?.usageSupport ?? 'none';
    const measurable = toolNames.filter((t) => usageSupportOf(t) !== 'none');
    const usedIn = toolNames.filter((tool) =>
      items.some(
        (i) => i.tool === tool && (usage.items[i.id]?.count ?? 0) > 0,
      ),
    );

    const serverName = items[0]?.name ?? key;
    const toolLabels = toolNames.map((t) => displayName(tools, t));
    let line = `\`${serverName}\` MCP is installed in ${toolLabels.join(', ')}`;
    if (measurable.length > 0) {
      line +=
        usedIn.length === 0
          ? ' — it has never fired in any tool with usage data.'
          : ` — it only ever fires in ${usedIn.map((t) => displayName(tools, t)).join(', ')}.`;
    } else {
      line += '.'; // no owner has usage data — make no usage claim (SPEC_V2 §4.5)
    }

    findings.push({ key, itemIds: items.map((i) => i.id), usedIn, line });
  }
  return findings.sort((a, b) => b.itemIds.length - a.itemIds.length);
}

function imbalance(
  inventory: Inventory,
  classification: ClassificationOutput,
  tools: ToolMeta[],
): CapabilityImbalance[] {
  const toolOf = new Map(inventory.items.map((i) => [i.id, i.tool]));
  const perAxisPerTool = new Map<Axis, Map<string, number>>();
  const classifiableTools = new Set<string>();

  for (const c of classification.items) {
    const tool = toolOf.get(c.itemId);
    if (tool === undefined) continue;
    classifiableTools.add(tool);
    for (const axis of AXES) {
      const perTool = perAxisPerTool.get(axis) ?? new Map<string, number>();
      perTool.set(tool, (perTool.get(tool) ?? 0) + (c.weights[axis] || 0));
      perAxisPerTool.set(axis, perTool);
    }
  }
  if (classifiableTools.size < 2) return [];

  const findings: CapabilityImbalance[] = [];
  for (const axis of AXES) {
    const perTool = perAxisPerTool.get(axis) ?? new Map<string, number>();
    const total = [...perTool.values()].reduce((a, b) => a + b, 0);
    if (total <= 0.5) continue; // negligible capability — a gap, not an imbalance
    for (const [tool, weight] of perTool) {
      const share = weight / total;
      if (share >= IMBALANCE_THRESHOLD) {
        const others = [...classifiableTools].filter((t) => t !== tool);
        findings.push({
          axis,
          concentratedIn: tool,
          share,
          line: `${share >= 0.99 ? 'All' : 'Most'} ${axis} capability lives in ${displayName(tools, tool)}; ${others.map((t) => displayName(tools, t)).join(' and ')} ${others.length === 1 ? 'has' : 'have'} ${share >= 0.99 ? 'none' : 'little'}.`,
        });
      }
    }
  }
  return findings.sort((a, b) => b.share - a.share);
}

function rulesOverlaps(inventory: Inventory, tools: ToolMeta[]): RulesOverlap[] {
  const rules = inventory.items.filter(
    (i) => i.kind === 'memory' && RULES_FILE_PATTERN.test(i.sourcePath),
  );
  const byTool = new Map<string, typeof rules>();
  for (const item of rules) {
    if (item.tool === undefined) continue;
    byTool.set(item.tool, [...(byTool.get(item.tool) ?? []), item]);
  }
  if (byTool.size < 2) return [];

  // One finding across the whole set — human review, no content diffing (SPEC_V2 §4.5.3).
  const names = rules.map((i) => `${i.name} (${displayName(tools, i.tool ?? '')})`);
  return [
    {
      itemIds: rules.map((i) => i.id),
      line: `${names.join(', ')} all give standing instructions — worth checking they agree.`,
    },
  ];
}

export function crossToolDiagnose(
  inventory: Inventory,
  usage: Usage,
  classification: ClassificationOutput,
  tools: ToolMeta[],
): CrossToolReport {
  return {
    duplicates: duplicates(inventory, usage, tools),
    imbalance: imbalance(inventory, classification, tools),
    rulesOverlaps: rulesOverlaps(inventory, tools),
  };
}
