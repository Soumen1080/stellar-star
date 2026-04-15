import { rpc } from "@stellar/stellar-sdk";
import { SOROBAN_RPC_URL } from "@/lib/utils/constants";

export const sorobanServer = new rpc.Server(SOROBAN_RPC_URL, {
  allowHttp: SOROBAN_RPC_URL.startsWith("http://"),
});
