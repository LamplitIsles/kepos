# UDP direct-path capture — 2026-08-27

This is a record of one controlled macOS-subscriber to Linux-publisher restart
trial. No PCAP files, addresses, routes, hostnames, peer IDs, or raw packet
output are retained in the repository.

## Observations

The old outer closed at the restart stimulus. About eight seconds later, the
publisher recorded authenticated `outer.accepted` and `outer.connected` events
for a new outer. Both captures showed bidirectional UDP activity, and the
publisher then served channels successfully.

## Limits

The trial established a healthy direct path for that restart. It did not
reproduce the earlier long outage, whose root cause remains unknown. A future
outage must use the [UDP incident capture runbook](../udp-incident-capture.md)
before either peer is restarted.
