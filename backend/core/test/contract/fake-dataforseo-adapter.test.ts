import {
  FakeDataForSeoAdapter,
  FakeDataForSeoError,
} from "../../src/modules/backlinks/adapters/dataforseo/fake-dataforseo.adapter.js";
import { describeDataForSeoPortContract } from "./dataforseo-adapter.contract.js";

describeDataForSeoPortContract("FakeDataForSeoAdapter contract", {
  create: (outcome, snapshot) => {
    const adapter = new FakeDataForSeoAdapter({
      outcome,
      snapshot:
        outcome === "malformed"
          ? { ...snapshot, payloadHash: "not-a-sha256" }
          : snapshot,
    });

    return {
      port: adapter,
      calls: () => adapter.calls,
    };
  },
  classifyFailure: (error) =>
    error instanceof FakeDataForSeoError
      ? { outcome: error.outcome, statusCode: error.statusCode }
      : undefined,
});
