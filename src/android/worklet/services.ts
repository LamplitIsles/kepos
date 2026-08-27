import type { SubscriberService } from "../../runtime/subscriber.js";

export function createAndroidSubscriberServices(
  mihomoPort: number,
  dshPort: number,
  openClawPort: number,
  sshPort: number,
): SubscriberService[] {
  return [
    { id: "mihomo", localPort: mihomoPort },
    { id: "dsh", localPort: dshPort },
    { id: "openclaw", localPort: openClawPort },
    { id: "ssh", localPort: sshPort },
  ];
}
