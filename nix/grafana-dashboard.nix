{
  jsonnet,
  jq,
  lib,
  stdenvNoCC,
}:
stdenvNoCC.mkDerivation {
  pname = "kepos-grafana-dashboard";
  version = "0.0.0";
  src = lib.fileset.toSource {
    root = ../.;
    fileset = lib.fileset.unions [
      ../grafana
    ];
  };
  nativeBuildInputs = [jsonnet jq];
  dontConfigure = true;
  installPhase = ''
    runHook preInstall
    mkdir -p "$out/share/kepos/grafana"
    jsonnet -J grafana grafana/kepos-publisher-observability.jsonnet \
      > "$out/share/kepos/grafana/kepos-publisher-observability.json"
    jq -e 'type == "object" and .title == "Kepos Publisher Observability" and (.panels | length) >= 7' \
      "$out/share/kepos/grafana/kepos-publisher-observability.json" >/dev/null
    runHook postInstall
  '';
  meta = {
    description = "Kepos publisher observability Grafana dashboard";
    license = lib.licenses.asl20;
    platforms = lib.platforms.unix;
  };
}
