// Vestaboard Note: https://docs.vestaboard.com/docs/characterCodes
export const ROWS = 3;
export const COLUMNS = 15;
export const CODES = Object.fromEntries([
  [' ', 0],
  ...Array.from('ABCDEFGHIJKLMNOPQRSTUVWXYZ', (char, i) => [char, i + 1]),
  ...Array.from('1234567890', (char, i) => [char, i + 27]),
  ...Object.entries({ '!': 37, '@': 38, '#': 39, '$': 40, '(': 41, ')': 42,
    '-': 44, '+': 46, '&': 47, '=': 48, ';': 49, ':': 50, "'": 52,
    '"': 53, '%': 54, ',': 55, '.': 56, '/': 59, '?': 60, '♥': 62,
    '🟥': 63, '🟧': 64, '🟨': 65, '🟩': 66, '🟦': 67, '🟪': 68,
    '⬜': 69, '⬛': 70 }),
]);
export const SYMBOLS = Object.fromEntries(Object.entries(CODES).map(([char, code]) => [code, char]));

export function normalizeMessage(value) {
  return value.replace(/\r\n?/g, '\n').replace(/[\uFE0E\uFE0F]/g, '')
    .replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, '-')
    .replace(/❤/g, '♥').replace(/\t/g, ' ').toUpperCase();
}

export function layoutMessage(value) {
  const text = normalizeMessage(value).trim();
  const blank = () => Array.from({ length: ROWS }, () => Array(COLUMNS).fill(0));
  if (!text) return { characters: blank(), lines: 0, error: 'Write a little note first.' };
  const unsupported = [...new Set(Array.from(text).filter(char => char !== '\n' && CODES[char] === undefined))];
  if (unsupported.length) return { characters: blank(), lines: 0,
    error: `The Note cannot display: ${unsupported.join(' ')}. Try letters, numbers, punctuation, or the color buttons.` };

  const lines = [];
  for (const paragraph of text.split('\n')) {
    let line = [];
    for (const word of paragraph.trim().split(/ +/)) {
      let letters = Array.from(word);
      if (!letters.length) continue;
      if (line.length && line.length + 1 + letters.length > COLUMNS) {
        lines.push(line); line = [];
      }
      // Long words split across rows; nothing is silently discarded.
      while (letters.length > COLUMNS) {
        lines.push(letters.slice(0, COLUMNS)); letters = letters.slice(COLUMNS);
      }
      if (line.length) line.push(' ');
      line.push(...letters);
    }
    lines.push(line);
  }
  if (lines.length > ROWS) return { characters: blank(), lines: lines.length,
    error: `That needs ${lines.length} rows. Shorten your note to fit 3 rows of 15 tiles.` };
  const characters = blank();
  const top = Math.floor((ROWS - lines.length) / 2);
  lines.forEach((line, row) => {
    const left = Math.floor((COLUMNS - line.length) / 2);
    line.forEach((char, column) => { characters[top + row][left + column] = CODES[char]; });
  });
  return { characters, lines: lines.length, error: null };
}
