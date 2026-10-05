import { Horizon } from "@stellar/stellar-sdk";
import { HORIZON_URL } from "@/lib/utils/constants";
import { REQUEST_ID_HEADER } from "@/lib/observability/requestId";

export function createHorizonServer(requestId?: string): Horizon.Server {
  return new Horizon.Server(HORIZON_URL, {
    allowHttp: HORIZON_URL.startsWith("http://"),
    ...(requestId ? { headers: { [REQUEST_ID_HEADER]: requestId } } : {}),
  });
}

export const server = createHorizonServer();
