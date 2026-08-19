import type { TargetRequirements } from '../schema/config.js';
import type { CapabilityFinding, CapabilityId, Fidelity } from './codex.js';

/**
 * Checks lowering results against configured requirements.
 *
 * Lives beside the lowering rather than in `src/enforcement/` on purpose: this
 * consumes a Codex type and judges one provider's lowering, while enforcement
 * is provider-neutral by construction and may not import from generators.
 */

export interface RequirementViolation {
  target: 'codex';
  agent: string;
  capability: CapabilityId;
  actual: Fidelity;
  accepted: Fidelity[];
}

/** The accepted set for one capability: its override, else the target default. */
function acceptedFor(reqs: TargetRequirements, capability: CapabilityId): Fidelity[] {
  return reqs[capability] ?? reqs.default;
}

/**
 * Membership, not comparison. A finding passes when its fidelity is in the
 * accepted set; there is no ordering to be "at least as good as".
 */
export function checkRequirements(
  agents: { name: string; findings: CapabilityFinding[] }[],
  reqs: TargetRequirements,
): RequirementViolation[] {
  const violations: RequirementViolation[] = [];
  for (const { name, findings } of agents) {
    for (const f of findings) {
      const accepted = acceptedFor(reqs, f.capability);
      if (!accepted.includes(f.fidelity)) {
        violations.push({ target: 'codex', agent: name, capability: f.capability, actual: f.fidelity, accepted });
      }
    }
  }
  return violations;
}

/** Aligned block per violation; names all four facts so a too-strict requirement is distinguishable from a lowering regression. */
export function formatViolation(v: RequirementViolation): string {
  return [
    'Capability requirement failed',
    '',
    `  target:      ${v.target}`,
    `  agent:       ${v.agent}`,
    `  capability:  ${v.capability}`,
    `  actual:      ${v.actual}`,
    `  accepted:    ${v.accepted.join(', ')}`,
  ].join('\n');
}
