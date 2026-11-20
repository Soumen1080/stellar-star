import { paymentSubmissionTracker } from "@/lib/routing/consistency";
import { __resetRateLimitsForTests } from "@/lib/auth/rateLimiter";

afterEach(() => {
  try {
    paymentSubmissionTracker.clear();
  } catch {
    // ignore
  }
  try {
    __resetRateLimitsForTests();
  } catch {
    // ignore
  }
});
