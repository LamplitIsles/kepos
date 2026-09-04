local panelTarget(value, panelType) =
  local target = if std.type(value) == "string" then { expr: value } else value;
  {
    refId: if std.objectHas(target, "refId") then target.refId else "A",
    expr: target.expr,
    format: if std.objectHas(target, "format") then target.format else if panelType == "table" then "table" else "time_series",
    legendFormat: if std.objectHas(target, "legendFormat") then target.legendFormat else "{{subscriber_label}} {{service}} {{direction}}",
  }
  + if panelType == "table" then { instant: true, range: false } else {};

local panel(title, panelType, targets, gridPos, unit=null, description="", options={}) = {
  title: title,
  type: panelType,
  gridPos: gridPos,
  description: description,
  transparent: false,
  datasource: { type: "prometheus", uid: "${DS_PROMETHEUS}" },
  targets: [panelTarget(target, panelType) for target in targets],
  fieldConfig: {
    defaults: {
      unit: if unit == null then "short" else unit,
      color: { mode: "fixed", fixedColor: "#b8c8d3" },
      thresholds: {
        mode: "absolute",
        steps: [
          { color: "#596975", value: null },
          { color: "#f2a65a", value: 1 },
        ],
      },
    },
    overrides: [],
  },
} + options;

{
  panel: panel,
}
