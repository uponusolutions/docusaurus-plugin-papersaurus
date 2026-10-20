import { LocalizedString } from './types';

/**
 * Resolves a localized option value for the given language: a string is returned as is, a map
 * returns the entry for the language, falling back to its first entry.
 */
export function resolveLocalized(value: LocalizedString | undefined, language: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value === 'string') {
    return value;
  }
  if (value[language] !== undefined) {
    return value[language];
  }
  const values = Object.values(value);
  return values.length > 0 ? values[0] : undefined;
}
