// Pure pagination over an array. No I/O, no DOM, no imports — safe to run in the
// browser via `<script type="module">` and in Node (Vitest) alike.
//
// paginate(items, page, pageSize) returns a normalized slice descriptor:
//   { pageItems, page, pageCount, total }
// where `page` is the 1-based page actually used after clamping, `pageCount` is
// always at least 1 (an empty list still has one — empty — page), and `total`
// is the input length.

function toPositiveInt(value, min) {
  const n = Math.floor(Number(value));
  // NaN and out-of-range values collapse to the floor `min` rather than
  // throwing, so callers can pass through raw/user-supplied input safely.
  if (!Number.isFinite(n) || n < min) return min;
  return n;
}

export function paginate(items, page, pageSize) {
  const list = Array.isArray(items) ? items : [];
  const total = list.length;
  const size = toPositiveInt(pageSize, 1);
  const pageCount = Math.max(1, Math.ceil(total / size));
  const normalizedPage = Math.min(toPositiveInt(page, 1), pageCount);
  const start = (normalizedPage - 1) * size;

  return {
    pageItems: list.slice(start, start + size),
    page: normalizedPage,
    pageCount,
    total,
  };
}
