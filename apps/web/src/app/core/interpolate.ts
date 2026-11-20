/** Fills `{{name}}` placeholders in one pass, so a value that contains `{{x}}` stays as typed. */
export function interpolate(template: string, values: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (match, name: string) => values[name] ?? match);
}
