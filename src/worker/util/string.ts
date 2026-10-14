import {randomString} from '../../security/random'

const maxFileNameLength = 100 - 7 // 7 is for random string
export function normalizeFileName(name: string, suffix?: string){
    const parts = name.split('.')
    const originalExt = parts.length > 1 ? parts.pop()! : ''
    let cleanExt = originalExt.replace(/[^\w\.\*\-_\+\=\#]+/g, '')
    if(!cleanExt) cleanExt = 'dat'
    let cleanName = Snakecase(parts.join('.').replace(/[^a-zA-Z0-9_\.]/g, '_'))
    if(cleanName.length < 3) {
        cleanName += randomString(5)
    }else if(cleanName.length > maxFileNameLength){
        cleanName = cleanName.substring(0, maxFileNameLength)
    }
    return `${cleanName}${suffix ?? ('_'+randomString(10))}.${cleanExt}`
}

// ────────────────────────────────────────────────────────────────────────────
// ported from change-case (MIT). Source: https://github.com/blakeembrey/change-case/blob/main/packages/change-case/src/index.ts
// ────────────────────────────────────────────────────────────────────────────

// Regexps involved with splitting words in various case formats.
const SPLIT_LOWER_UPPER_RE = /([\p{Ll}\d])(\p{Lu})/gu;
const SPLIT_UPPER_UPPER_RE = /(\p{Lu})([\p{Lu}][\p{Ll}])/gu;

// Regexp involved with stripping non-word characters from the result.
const DEFAULT_STRIP_REGEXP = /[^\p{L}\d]+/giu;

// The replacement value for splits.
const SPLIT_REPLACE_VALUE = "$1\0$2";

/**
 * Split any cased input strings into an array of words.
 */
export function split(value: string) {
  let result = value.trim();

  result = result
    .replace(SPLIT_LOWER_UPPER_RE, SPLIT_REPLACE_VALUE)
    .replace(SPLIT_UPPER_UPPER_RE, SPLIT_REPLACE_VALUE);

  result = result.replace(DEFAULT_STRIP_REGEXP, "\0");

  let start = 0;
  let end = result.length;

  // Trim the delimiter from around the output string.
  while (result.charAt(start) === "\0") start++;
  if (start === end) return [];
  while (result.charAt(end - 1) === "\0") end--;

  return result.slice(start, end).split(/\0/g);
}

// ────────────────────────────────────────────────────────────────────────────
// End of change-case port.
// ────────────────────────────────────────────────────────────────────────────

// Snakecase removes all non word characters and converts any english text into a snakecase.
// "ABBREVIATIONS" are preserved, eg. "myTestDB" will become "my_test_db".
export function Snakecase(str: string): string {
    return split(str).map(w => w.toLowerCase()).join('_')
}
