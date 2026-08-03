{
  importNpmLock,
  lib,
  makeWrapper,
  nodejs_24,
  stdenvNoCC,
}: let
  rootPackage = builtins.fromJSON (builtins.readFile ../package.json);
  rootLock = builtins.fromJSON (builtins.readFile ../package-lock.json);
  # App and package workspaces share the root lock but are not part of
  # the headless CLI closure. Keep one lockfile and select its production graph.
  package = removeAttrs rootPackage ["devDependencies" "workspaces"];
  packageLock =
    rootLock
    // {
      packages =
        lib.filterAttrs (
          path: entry:
            path
            == ""
            || (!(entry.dev or false)
              && !(entry.link or false)
              && !lib.hasPrefix "apps/" path
              && !lib.hasPrefix "packages/" path)
        )
        rootLock.packages
        // {
          "" = removeAttrs rootLock.packages."" ["devDependencies" "workspaces"];
        };
    };
  nodeModules = importNpmLock.buildNodeModules {
    inherit package packageLock;
    nodejs = nodejs_24;
    derivationArgs.npmFlags = ["--omit=dev"];
  };
in
  stdenvNoCC.mkDerivation {
    pname = "kepos-neo";
    version = "0.0.0";

    src = lib.fileset.toSource {
      root = ../.;
      fileset = lib.fileset.unions [
        ../src
        ../LICENSE
        ../package-lock.json
        ../package.json
      ];
    };

    npmDeps = nodeModules;

    nativeBuildInputs = [importNpmLock.linkNodeModulesHook makeWrapper];

    installPhase = ''
      runHook preInstall

      app="$out/lib/kepos-neo"
      mkdir -p "$app" "$out/bin"
      cp -r node_modules package.json src "$app/"
      makeWrapper ${lib.getExe nodejs_24} "$out/bin/kepos" \
        --add-flags "--import=$app/node_modules/tsx/dist/loader.mjs" \
        --add-flags "$app/src/cli/main.ts"

      runHook postInstall
    '';

    meta = {
      description = "Persistent P2P access to a publisher's local TCP services";
      homepage = "https://github.com/tta-lab/kepos-neo";
      license = lib.licenses.asl20;
      mainProgram = "kepos";
      platforms = lib.platforms.linux;
    };
  }
