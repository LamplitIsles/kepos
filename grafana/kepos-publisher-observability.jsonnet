local console = import "traffic-console.libsonnet";

// Kepos owns this small raw dashboard object. It intentionally avoids a
// generator dependency so the rendered artifact has one local source of truth.
local datasource = "${DS_PROMETHEUS}";
local subscriberFilter = "subscriber_label=~\"$subscriber_label\"";
local connected = "kepos_publisher_subscriber_connected{" + subscriberFilter + "}";
local connectionBytes = "kepos_publisher_subscriber_connection_bytes";
local subscriberBytes = "kepos_publisher_subscriber_bytes_total";
local lastConnected = "kepos_publisher_subscriber_last_connected_timestamp_seconds{" + subscriberFilter + "}";
local authorized = "kepos_publisher_service_authorized{" + subscriberFilter + "} == 1";
local active = "kepos_publisher_service_active_channels{" + subscriberFilter + "}";
local serviceBytes = "kepos_publisher_service_bytes_total";
local sendDirection = "publisher_to_subscriber";
local receiveDirection = "subscriber_to_publisher";
local currentSendRate = "sum(rate(" + subscriberBytes + "{" + subscriberFilter + ",direction=\"" + sendDirection + "\"}[5m]))";
local currentReceiveRate = "sum(rate(" + subscriberBytes + "{" + subscriberFilter + ",direction=\"" + receiveDirection + "\"}[5m]))";
local connectedRate(direction) =
  "sum by (subscriber_id, subscriber_label) (rate(" + subscriberBytes + "{" + subscriberFilter + ",direction=\"" + direction + "\"}[5m])) and on (subscriber_id, subscriber_label) (" + connected + " == 1)";
local serviceRate(direction) =
  "label_join(sum by (subscriber_id, subscriber_label, service) (rate(" + serviceBytes + "{" + subscriberFilter + ",direction=\"" + direction + "\"}[5m])) and on (subscriber_id, subscriber_label, service) (" + authorized + "), \"device_service\", \"/\", \"subscriber_id\", \"service\")";

local steelFieldConfig = {
  defaults+: {
    color: { mode: "fixed", fixedColor: "#b8c8d3" },
  },
};

local tableOptions = {
  options: {
    showHeader: true,
    cellHeight: "sm",
    footer: { show: false },
    frameIndex: 0,
    sortBy: [{ displayName: "Subscriber device", desc: false }],
  },
};

local connectedDevices = console.panel(
  "Connected Devices",
  "table",
  [
    { refId: "A", expr: connected + " == 1", legendFormat: "Online" },
    {
      refId: "B",
      expr: "sum by (subscriber_id, subscriber_label) (" + connectionBytes + "{" + subscriberFilter + ",direction=\"publisher_to_subscriber\"} and on (subscriber_id, subscriber_label) (" + connected + " == 1))",
      legendFormat: "Send bytes · publisher→subscriber",
    },
    {
      refId: "C",
      expr: "sum by (subscriber_id, subscriber_label) (" + connectionBytes + "{" + subscriberFilter + ",direction=\"subscriber_to_publisher\"} and on (subscriber_id, subscriber_label) (" + connected + " == 1))",
      legendFormat: "Receive bytes · subscriber→publisher",
    },
    {
      refId: "D",
      expr: connectedRate(sendDirection),
      legendFormat: "Send rate · publisher→subscriber",
    },
    {
      refId: "E",
      expr: connectedRate(receiveDirection),
      legendFormat: "Receive rate · subscriber→publisher",
    },
  ],
  { h: 8, w: 24, x: 0, y: 4 },
  null,
  "Current publisher-to-subscriber and subscriber-to-publisher payload bytes and rates for each online device. Rows are joined on the stable subscriber identity; send is the publisher-to-subscriber direction.",
  tableOptions + {
    transformations: [
      { id: "joinByField", options: { byField: "subscriber_id", mode: "outer" } },
      {
        id: "organize",
        options: {
          excludeByName: {
            Time: true,
            "Time 1": true,
            "Time 2": true,
            "Time 3": true,
            "Time 4": true,
            "Time 5": true,
            "subscriber_label 2": true,
            "subscriber_label 3": true,
            "subscriber_label 4": true,
            "subscriber_label 5": true,
            "subscriber_id 1": true,
            "subscriber_id 2": true,
            "subscriber_id 3": true,
            "subscriber_id 4": true,
          },
          renameByName: {
            "subscriber_label 1": "Subscriber device",
            subscriber_id: "Subscriber ID",
            "Value #A": "Status",
            "Value #B": "Send bytes",
            "Value #C": "Receive bytes",
            "Value #D": "Send rate",
            "Value #E": "Receive rate",
          },
        },
      },
    ],
    fieldConfig+: {
      defaults+: steelFieldConfig.defaults,
      overrides: [
        {
          matcher: { id: "byName", options: "Status" },
          properties: [
            { id: "color", value: { mode: "fixed", fixedColor: "#5cc8d7" } },
            { id: "custom.cellOptions", value: { type: "color-text" } },
            {
              id: "mappings",
              value: [
                {
                  type: "value",
                  options: { "1": { text: "Online", color: "#5cc8d7" } },
                },
              ],
            },
          ],
        },
        {
          matcher: { id: "byName", options: "Subscriber ID" },
          properties: [{ id: "unit", value: "string" }],
        },
        {
          matcher: { id: "byName", options: "Send bytes" },
          properties: [
            { id: "unit", value: "bytes" },
            { id: "color", value: { mode: "fixed", fixedColor: "#f2a65a" } },
            { id: "custom.cellOptions", value: { type: "color-text" } },
          ],
        },
        {
          matcher: { id: "byName", options: "Receive bytes" },
          properties: [
            { id: "unit", value: "bytes" },
            { id: "color", value: { mode: "fixed", fixedColor: "#5cc8d7" } },
            { id: "custom.cellOptions", value: { type: "color-text" } },
          ],
        },
        {
          matcher: { id: "byName", options: "Send rate" },
          properties: [
            { id: "unit", value: "Bps" },
            { id: "color", value: { mode: "fixed", fixedColor: "#f2a65a" } },
            { id: "custom.cellOptions", value: { type: "color-text" } },
          ],
        },
        {
          matcher: { id: "byName", options: "Receive rate" },
          properties: [
            { id: "unit", value: "Bps" },
            { id: "color", value: { mode: "fixed", fixedColor: "#5cc8d7" } },
            { id: "custom.cellOptions", value: { type: "color-text" } },
          ],
        },
      ],
    },
  },
);

local authorizedServices = console.panel(
  "Authorized Services",
  "table",
  [
    {
      refId: "A",
      expr: "label_join(" + authorized + ", \"device_service\", \"/\", \"subscriber_id\", \"service\")",
      legendFormat: "Authorized",
    },
    {
      refId: "B",
      expr: "label_join(sum by (subscriber_id, subscriber_label, service) (" + active + " and on (subscriber_id, subscriber_label, service) (" + authorized + ")), \"device_service\", \"/\", \"subscriber_id\", \"service\")",
      legendFormat: "Active channels",
    },
    {
      refId: "C",
      expr: serviceRate(sendDirection),
      legendFormat: "Send rate · publisher→subscriber",
    },
    {
      refId: "D",
      expr: serviceRate(receiveDirection),
      legendFormat: "Receive rate · subscriber→publisher",
    },
  ],
  { h: 8, w: 24, x: 0, y: 12 },
  null,
  "Every authorized device/service pair remains listed, including idle authorization. Active channel counts and current directional rates stay visible; nonzero activity uses a restrained warm highlight.",
  tableOptions + {
    transformations: [
      { id: "joinByField", options: { byField: "device_service", mode: "outer" } },
      {
        id: "organize",
        options: {
          excludeByName: {
            Time: true,
            "Time 1": true,
            "Time 2": true,
            "Time 3": true,
            "Time 4": true,
            device_service: true,
            "device_service 1": true,
            "device_service 2": true,
            "device_service 3": true,
            "service 2": true,
            "service 3": true,
            "service 4": true,
            "subscriber_id 1": true,
            "subscriber_label 2": true,
            "subscriber_label 3": true,
            "subscriber_label 4": true,
            "subscriber_id 2": true,
            "subscriber_id 3": true,
            "subscriber_id 4": true,
          },
          renameByName: {
            "subscriber_label 1": "Subscriber device",
            "service 1": "Published service",
            "Value #A": "Authorization",
            "Value #B": "Active channels",
            "Value #C": "Send rate",
            "Value #D": "Receive rate",
          },
        },
      },
    ],
    fieldConfig+: {
      defaults+: steelFieldConfig.defaults,
      overrides: [
        {
          matcher: { id: "byName", options: "Authorization" },
          properties: [
            { id: "color", value: { mode: "fixed", fixedColor: "#5cc8d7" } },
            { id: "custom.cellOptions", value: { type: "color-text" } },
            {
              id: "mappings",
              value: [
                {
                  type: "value",
                  options: { "1": { text: "Authorized", color: "#5cc8d7" } },
                },
              ],
            },
          ],
        },
        {
          matcher: { id: "byName", options: "Active channels" },
          properties: [
            { id: "color", value: { mode: "thresholds" } },
            { id: "custom.cellOptions", value: { type: "color-text" } },
            {
              id: "thresholds",
              value: {
                mode: "absolute",
                steps: [
                  { color: "#596975", value: null },
                  { color: "#f2a65a", value: 1 },
                ],
              },
            },
          ],
        },
        {
          matcher: { id: "byName", options: "Send rate" },
          properties: [
            { id: "unit", value: "Bps" },
            { id: "color", value: { mode: "fixed", fixedColor: "#f2a65a" } },
            { id: "custom.cellOptions", value: { type: "color-text" } },
          ],
        },
        {
          matcher: { id: "byName", options: "Receive rate" },
          properties: [
            { id: "unit", value: "Bps" },
            { id: "color", value: { mode: "fixed", fixedColor: "#5cc8d7" } },
            { id: "custom.cellOptions", value: { type: "color-text" } },
          ],
        },
      ],
    },
  },
);

local offlineDevices = console.panel(
  "Offline Devices",
  "table",
  [
    { refId: "A", expr: connected + " == 0", legendFormat: "Offline" },
    { refId: "B", expr: "(" + lastConnected + ") * 1000 and on (subscriber_id, subscriber_label) (" + connected + " == 0)", legendFormat: "Last connected" },
  ],
  { h: 8, w: 24, x: 0, y: 29 },
  null,
  "Configured subscriber devices with no current connection. The retained last-connected timestamp makes stale or newly provisioned devices easy to distinguish; zero is shown as Never.",
  tableOptions + {
    transformations: [
      { id: "joinByField", options: { byField: "subscriber_id", mode: "outer" } },
      {
        id: "organize",
        options: {
          excludeByName: {
            Time: true,
            "Time 1": true,
            "Time 2": true,
            "subscriber_label 2": true,
            "subscriber_id 1": true,
          },
          renameByName: {
            "subscriber_label 1": "Subscriber device",
            subscriber_id: "Subscriber ID",
            "Value #A": "Status",
            "Value #B": "Last connected",
          },
        },
      },
    ],
    fieldConfig+: {
      defaults+: {
        color: { mode: "fixed", fixedColor: "#59636b" },
        thresholds: {
          mode: "absolute",
          steps: [{ color: "#59636b", value: null }],
        },
      },
      overrides: [
        {
          matcher: { id: "byName", options: "Subscriber ID" },
          properties: [{ id: "unit", value: "string" }],
        },
        {
          matcher: { id: "byName", options: "Status" },
          properties: [
            { id: "color", value: { mode: "fixed", fixedColor: "#59636b" } },
            { id: "custom.cellOptions", value: { type: "color-text" } },
            {
              id: "mappings",
              value: [
                {
                  type: "value",
                  options: { "0": { text: "Offline", color: "#59636b" } },
                },
              ],
            },
          ],
        },
        {
          matcher: { id: "byName", options: "Last connected" },
          properties: [
            { id: "unit", value: "dateTimeAsIso" },
            { id: "noValue", value: "Never" },
            { id: "color", value: { mode: "fixed", fixedColor: "#59636b" } },
            { id: "custom.cellOptions", value: { type: "color-text" } },
            {
              id: "mappings",
              value: [
                {
                  type: "value",
                  options: { "0": { text: "Never", color: "#59636b" } },
                },
              ],
            },
          ],
        },
      ],
    },
  },
);

{
  annotations: {
    list: [
      {
        builtIn: 1,
        enable: true,
        hide: true,
        iconColor: "#5cc8d7",
        name: "Annotations & Alerts",
        type: "dashboard",
      },
    ],
  },
  description: "Industrial NOC view of Kepos publisher reachability, authorization, channel activity, and directional payload traffic.",
  editable: true,
  fiscalYearStartMonth: 0,
  graphTooltip: 1,
  id: null,
  links: [],
  panels: [
    console.panel(
      "Online Devices",
      "stat",
      [{ refId: "A", expr: "sum(" + connected + ")", legendFormat: "Online" }],
      { h: 4, w: 7, x: 0, y: 0 },
      "short",
      "Configured subscriber devices with a live publisher connection.",
      {
        options: {
          colorMode: "value",
          graphMode: "none",
          justifyMode: "center",
          orientation: "horizontal",
          reduceOptions: { calcs: ["lastNotNull"], fields: "", values: false },
          textMode: "value_and_name",
        },
        fieldConfig+: {
          defaults+: {
            color: { mode: "fixed", fixedColor: "#5cc8d7" },
            noValue: "—",
          },
        },
      },
    ),
    console.panel(
      "Active Channels",
      "stat",
      [{ refId: "A", expr: "sum(" + active + ")", legendFormat: "Channels" }],
      { h: 4, w: 7, x: 7, y: 0 },
      "short",
      "Published-service channels currently open across connected devices.",
      {
        options: {
          colorMode: "value",
          graphMode: "none",
          justifyMode: "center",
          orientation: "horizontal",
          reduceOptions: { calcs: ["lastNotNull"], fields: "", values: false },
          textMode: "value_and_name",
        },
        fieldConfig+: {
          defaults+: {
            color: { mode: "fixed", fixedColor: "#f2a65a" },
            noValue: "—",
          },
        },
      },
    ),
    console.panel(
      "Current Send Rate",
      "stat",
      [{ refId: "A", expr: currentSendRate, legendFormat: "Send · publisher→subscriber" }],
      { h: 4, w: 5, x: 14, y: 0 },
      "Bps",
      "Current publisher send rate over the last five minutes, measured publisher-to-subscriber. Warm amber marks outbound payload.",
      {
        options: {
          colorMode: "value",
          graphMode: "none",
          justifyMode: "center",
          orientation: "horizontal",
          reduceOptions: { calcs: ["lastNotNull"], fields: "", values: false },
          textMode: "value_and_name",
        },
        fieldConfig+: {
          defaults+: {
            color: { mode: "fixed", fixedColor: "#f2a65a" },
            noValue: "—",
          },
        },
      },
    ),
    console.panel(
      "Current Receive Rate",
      "stat",
      [{ refId: "A", expr: currentReceiveRate, legendFormat: "Receive · subscriber→publisher" }],
      { h: 4, w: 5, x: 19, y: 0 },
      "Bps",
      "Current publisher receive rate over the last five minutes, measured subscriber-to-publisher. Cool cyan marks inbound payload.",
      {
        options: {
          colorMode: "value",
          graphMode: "none",
          justifyMode: "center",
          orientation: "horizontal",
          reduceOptions: { calcs: ["lastNotNull"], fields: "", values: false },
          textMode: "value_and_name",
        },
        fieldConfig+: {
          defaults+: {
            color: { mode: "fixed", fixedColor: "#5cc8d7" },
            noValue: "—",
          },
        },
      },
    ),
    connectedDevices,
    authorizedServices,
    console.panel(
      "Traffic History",
      "timeseries",
      [
        {
          refId: "A",
          expr: "sum by (subscriber_label, service, direction) (rate(kepos_publisher_service_bytes_total{" + subscriberFilter + "}[5m]))",
          legendFormat: "{{subscriber_label}} / {{service}} / {{direction}}",
        },
      ],
      { h: 9, w: 24, x: 0, y: 20 },
      "Bps",
      "Rolling directional service payload rate. Cool cyan marks publisher receive; warm amber marks publisher send.",
      {
        options: {
          legend: { calcs: [], displayMode: "table", placement: "bottom", showLegend: true },
          tooltip: { mode: "multi", sort: "desc" },
        },
        fieldConfig+: {
          defaults+: steelFieldConfig.defaults,
          overrides: [
            {
              matcher: { id: "byRegexp", options: "/publisher_to_subscriber/" },
              properties: [{ id: "color", value: { fixedColor: "#f2a65a", mode: "fixed" } }],
            },
            {
              matcher: { id: "byRegexp", options: "/subscriber_to_publisher/" },
              properties: [{ id: "color", value: { fixedColor: "#5cc8d7", mode: "fixed" } }],
            },
          ],
        },
      },
    ),
    offlineDevices,
  ],
  refresh: "15s",
  schemaVersion: 39,
  style: "dark",
  tags: ["kepos", "publisher", "observability", "noc"],
  templating: {
    list: [
      {
        name: "DS_PROMETHEUS",
        label: "Prometheus",
        type: "datasource",
        query: "prometheus",
        refresh: 1,
        current: {},
        options: [],
        includeAll: false,
        multi: false,
      },
      {
        name: "subscriber_label",
        label: "Subscriber device",
        type: "query",
        datasource: datasource,
        query: "label_values(kepos_publisher_subscriber_connected, subscriber_label)",
        refresh: 1,
        includeAll: true,
        multi: true,
        allValue: ".*",
        current: { text: "All", value: ["$__all"] },
        options: [],
      },
    ],
  },
  time: { from: "now-6h", to: "now" },
  timepicker: {},
  timezone: "browser",
  title: "Kepos Publisher Observability",
  uid: null,
  version: 1,
}
