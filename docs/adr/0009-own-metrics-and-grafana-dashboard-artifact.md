# ADR 0009: Own metrics and the Grafana dashboard artifact

Kepos owns the meaning of its publisher metrics, so it also owns the Jsonnet
source and rendered Grafana dashboard that interpret them. Deployments consume
the rendered dashboard as an opaque artifact and provide the metrics backend
and Grafana runtime; Kepos does not embed a dashboard server or operate the
observability stack.
