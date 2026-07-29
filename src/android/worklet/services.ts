import type { SubscriberService } from "../../runtime/subscriber.js";

export function createAndroidSubscriberServices(
  mihomoPort: number,
): SubscriberService[] {
  return [{ id: "mihomo", localPort: mihomoPort }];
}
