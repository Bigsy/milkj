import { describe, expect, it } from "vitest";
import { matchSequences } from "./sequence-align";

/** Length of the longest common subsequence, by dynamic programming. */
function lcsLength(a: number[], b: number[]): number {
  const table = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      table[i][j] = a[i - 1] === b[j - 1]
        ? table[i - 1][j - 1] + 1
        : Math.max(table[i - 1][j], table[i][j - 1]);
    }
  }
  return table[a.length][b.length];
}

describe("matchSequences", () => {
  it("matches identical sequences one to one", () => {
    expect(matchSequences([1, 2, 3], [1, 2, 3], 0)).toEqual([[0, 0], [1, 1], [2, 2]]);
  });

  it("aligns around an insertion, a deletion and a replacement", () => {
    expect(matchSequences([1, 2, 3, 4], [1, 9, 2, 4, 5], 10)).toEqual([[0, 0], [1, 2], [3, 3]]);
  });

  it("finds a longest common subsequence of random sequences", () => {
    let seed = 7;
    const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) % 4;
    for (let round = 0; round < 200; round++) {
      const a = Array.from({ length: random() * 3 + random() }, random);
      const b = Array.from({ length: random() * 3 + random() }, random);

      const pairs = matchSequences(a, b, a.length + b.length)!;

      expect(pairs).toHaveLength(lcsLength(a, b));
      for (let i = 0; i < pairs.length; i++) {
        expect(a[pairs[i][0]]).toBe(b[pairs[i][1]]);
        if (i > 0) {
          expect(pairs[i][0]).toBeGreaterThan(pairs[i - 1][0]);
          expect(pairs[i][1]).toBeGreaterThan(pairs[i - 1][1]);
        }
      }
    }
  });

  it("gives up once the edit budget is exceeded", () => {
    expect(matchSequences([1, 2, 3], [4, 5, 6], 5)).toBeUndefined();
    expect(matchSequences([1, 2, 3], [4, 5, 6], 6)).toEqual([]);
  });
});
