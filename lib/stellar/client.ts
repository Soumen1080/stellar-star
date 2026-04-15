import { Horizon } from "@stellar/stellar-sdk";
import { HORIZON_URL } from "@/lib/utils/constants";

export const server = new Horizon.Server(HORIZON_URL, {
  allowHttp: HORIZON_URL.startsWith("http://"),
});
