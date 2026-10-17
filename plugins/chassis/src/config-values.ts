export function isMissingOrPlaceholder(value: string | undefined): boolean {
  const candidate = value?.trim();
  return !candidate || /^(replace-me|placeholder|changeme|todo)$/i.test(candidate);
}
