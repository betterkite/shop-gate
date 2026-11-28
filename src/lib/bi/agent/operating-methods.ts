import guides from '../../../../.pi/skills/commerce-metrics/assets/ledger-methods.json';
import lock from '../../../../.pi/skills.lock.json';
import type { BiAgentPageScope } from './contracts';

type Module = BiAgentPageScope['module'];
const skill = 'commerce-metrics';
const { version, sourceSha256 } = lock.skills[skill];

export function operatingMethod(module: Module) {
  const { title, guidance } = guides[module];
  return {
    module, title, guidance, skill, version, sourceSha256,
    uri: `shopgate://methods/${skill}/${version}/${module}`,
  };
}

export const operatingMethods = (Object.keys(guides) as Module[]).map(operatingMethod);

const normalize = (value: string) => value.normalize('NFKC').trim().toLowerCase();

/** Search only the shipped public vocabulary. A question can match multiple methods. */
export function searchOperatingMethods(query: string) {
  const text = normalize(query);
  return operatingMethods.map(method => ({
    method,
    score: guides[method.module].keywords.reduce((sum, term) =>
      sum + (text.includes(normalize(term)) ? term.length : 0), 0),
  })).filter(hit => hit.score > 0).sort((a, b) => b.score - a.score)
    .map(hit => hit.method);
}

export function operatingMethodPrompt(module: Module) {
  const method = operatingMethod(module);
  return `当前页面的经营方法（${method.skill} ${method.version}）\n${method.guidance}`;
}
