import { matchRule, ONE_CLICK_CATEGORIES } from './manifest.js';

/**
 * Talos-style allow/ask/block engine.
 * Returns { decision, reason, oneClick }. Unknown tools are blocked.
 */
export class PolicyEngine {
  constructor(manifest) {
    this.manifest = manifest;
    this.byName = new Map(manifest.tools.map((t) => [t.name, t]));
  }

  base(toolName) {
    const tool = this.byName.get(toolName);
    if (!tool) return { decision: 'block', reason: `"${toolName}" is not on this pack's allowlist`, oneClick: false, tool: null };
    const rule = matchRule(this.manifest.policy.rules, tool);
    const oneClick = ONE_CLICK_CATEGORIES.includes(tool.category);
    if (!rule) return { decision: 'block', reason: 'no matching rule (default block)', oneClick, tool };
    return { decision: rule.decision, reason: rule.reason || `policy: ${rule.decision}`, oneClick, tool };
  }

  /**
   * Apply the mode on top of the base policy.
   * review: only read/report tools that the policy allows; everything else blocks.
   * assist: the policy as written; "ask" waits for a named human.
   * auto:   "ask" becomes "allow" only for tools the buyer opted in, and never for
   *         one-click categories. "block" is never upgraded.
   */
  decide(toolName, { mode = 'assist', autoActions = new Set() } = {}) {
    const b = this.base(toolName);
    if (!b.tool || b.decision === 'block') return { ...b, mode };
    if (mode === 'review') {
      if (b.tool.kind === 'read' || b.tool.kind === 'report') return { ...b, mode };
      return { ...b, decision: 'block', reason: 'Review mode is read-only', mode };
    }
    if (mode === 'auto' && b.decision === 'ask') {
      if (b.oneClick) return { ...b, reason: `${b.tool.category} stays one-click, even in Auto`, mode };
      if (autoActions.has(toolName)) return { ...b, decision: 'allow', reason: 'Auto mode: opted in for this action', auto: true, mode };
    }
    return { ...b, mode };
  }
}
