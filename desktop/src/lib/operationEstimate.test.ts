import { describe, expect, it } from "vitest";
import { createOperationEstimator, estimateText } from "./operationEstimate";

function steady() {
  const sample = createOperationEstimator();
  [0, 2, 4].forEach(seconds => expect(sample("write", seconds * 10, 300, seconds * 1000)).toBeUndefined());
  const estimate = sample("write", 60, 300, 6000);
  return { sample, estimate };
}

describe("真实进度估时", () => {
  it("uses measured rates and expires when progress stops arriving", () => {
    const { sample, estimate } = steady();
    expect(estimateText(estimate, 6200)).toBe("预计还需约 20–25 秒");
    expect(estimateText(estimate, 10_000)).toBeUndefined();
    expect(sample("write", 70, 300, 10_001)).toBeUndefined();
  });
  it("withdraws on stalled throughput, unknown totals and new phases", () => {
    expect(steady().sample("write", 60, 300, 8000)).toBeUndefined();
    expect(steady().sample("write", 61, 300, 8000)).toBeUndefined();
    expect(steady().sample("write", 80, null, 8000)).toBeUndefined();
    expect(steady().sample("write", 80, 400, 8000)).toBeUndefined();
    expect(steady().sample("verify", 80, 300, 8000)).toBeUndefined();
    expect(steady().sample("write", 300, 300, 8000)).toBeUndefined();
  });
});
