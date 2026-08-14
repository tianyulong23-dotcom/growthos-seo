import {
  backlinkSnapshotRequestSchema,
  providerRequestContextSchema,
  type DataForSeoPort,
} from "../../ports/dataforseo.port.js";
import type {
  DataForSeoClient,
} from "./client.js";
import {
  mapDataForSeoBacklinkSnapshot,
} from "./mapper.js";

export class DataForSeoAdapter implements DataForSeoPort {
  constructor(
    private readonly client: Pick<DataForSeoClient, "fetchBacklinkSnapshot">,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async fetchBacklinkSnapshot(context: unknown, request: unknown) {
    providerRequestContextSchema.parse(context);
    const parsedRequest = backlinkSnapshotRequestSchema.parse(request);
    const requestedAt = this.now().toISOString();
    const raw = await this.client.fetchBacklinkSnapshot(parsedRequest);
    const completedAt = this.now().toISOString();
    return mapDataForSeoBacklinkSnapshot({
      raw,
      requestedAt,
      completedAt,
    });
  }
}
