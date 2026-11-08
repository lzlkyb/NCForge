import { expect, it } from "vitest";
import { servicePollInterval } from "./servicePolling";
it("backs stable state off to 30 seconds and resets for transitions", () => {
  const poll = servicePollInterval(); const query = { state: { data: { state: "running", runId: "a" } } };
  expect(Array.from({ length: 7 }, () => poll(query))).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000]);
  query.state.data.state = "starting"; expect(poll(query)).toBe(1000); expect(poll(query)).toBe(1000);
  query.state.data.state = "running"; query.state.data.runId = "b"; expect(poll(query)).toBe(1000);
});
