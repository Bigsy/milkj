/**
 * Matches two sequences of interned ids with Myers' diff, giving up once more than `maxEdits`
 * insertions and deletions would be needed. Cost is O((N + M) · D) for D ≤ maxEdits edits, so a
 * heavily changed pair of documents costs a bounded amount of work and yields "no alignment"
 * instead of an arbitrarily expensive one.
 *
 * Returns the matched index pairs in increasing order, or undefined past the budget.
 */
export function matchSequences(
  a: ArrayLike<number>,
  b: ArrayLike<number>,
  maxEdits: number,
): Array<[number, number]> | undefined {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) {
    start++;
  }
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }

  const middle = myers(a, b, start, endA, start, endB, maxEdits);
  if (!middle) {
    return undefined;
  }
  const pairs: Array<[number, number]> = [];
  for (let i = 0; i < start; i++) {
    pairs.push([i, i]);
  }
  pairs.push(...middle);
  for (let i = 0; endA + i < a.length; i++) {
    pairs.push([endA + i, endB + i]);
  }
  return pairs;
}

function myers(
  a: ArrayLike<number>,
  b: ArrayLike<number>,
  startA: number,
  endA: number,
  startB: number,
  endB: number,
  maxEdits: number,
): Array<[number, number]> | undefined {
  const n = endA - startA;
  const m = endB - startB;
  const max = Math.min(maxEdits, n + m);
  const offset = max + 1;
  const v = new Int32Array(2 * max + 3);
  // trace[d] holds the furthest-reaching x of every diagonal before round d.
  const trace: Int32Array[] = [];
  for (let d = 0; d <= max; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])
        ? v[offset + k + 1]
        : v[offset + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[startA + x] === b[startB + y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        return backtrack(trace, offset, n, m, d, startA, startB);
      }
    }
  }
  return undefined;
}

function backtrack(
  trace: Int32Array[],
  offset: number,
  n: number,
  m: number,
  edits: number,
  startA: number,
  startB: number,
): Array<[number, number]> {
  const reversed: Array<[number, number]> = [];
  let x = n;
  let y = m;
  for (let d = edits; d > 0; d--) {
    const v = trace[d];
    const k = x - y;
    const previousK = k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1]) ? k + 1 : k - 1;
    const previousX = v[offset + previousK];
    const previousY = previousX - previousK;
    while (x > previousX && y > previousY) {
      reversed.push([startA + --x, startB + --y]);
    }
    x = previousX;
    y = previousY;
  }
  while (x > 0 && y > 0) {
    reversed.push([startA + --x, startB + --y]);
  }
  return reversed.reverse();
}
