{
  description = "Kepos Neo P2P service publisher and subscriber";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-25.11";
    home-manager = {
      url = "github:nix-community/home-manager/release-25.11";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs = {
    self,
    nixpkgs,
    home-manager,
    ...
  }: let
    systems = ["x86_64-linux" "aarch64-linux"];
    forAllSystems = nixpkgs.lib.genAttrs systems;
    pkgsFor = system: import nixpkgs {inherit system;};
  in {
    packages = forAllSystems (system: let
      pkgs = pkgsFor system;
    in rec {
      kepos = pkgs.callPackage ./nix/package.nix {};
      container-image = pkgs.dockerTools.buildImage {
        name = "ghcr.io/tta-lab/kepos-neo";
        tag = "local";
        copyToRoot = pkgs.buildEnv {
          name = "kepos-container-root";
          paths = [kepos];
        };
        extraCommands = ''
          mkdir -m 1777 tmp
        '';
        config = {
          Entrypoint = ["${kepos}/bin/kepos"];
          User = "10000:10000";
          Labels = {
            "org.opencontainers.image.source" = "https://github.com/tta-lab/kepos-neo";
            "org.opencontainers.image.licenses" = "Apache-2.0";
          };
        };
      };
      default = kepos;
    });

    apps = forAllSystems (system: {
      kepos = {
        type = "app";
        program = "${self.packages.${system}.kepos}/bin/kepos";
        meta.description = "Run the Kepos Neo CLI";
      };
      default = self.apps.${system}.kepos;
    });

    homeManagerModules.default = import ./nix/home-manager-module.nix;

    checks = forAllSystems (system: let
      pkgs = pkgsFor system;
      package = self.packages.${system}.kepos;
      containerImage = self.packages.${system}.container-image;
      home = home-manager.lib.homeManagerConfiguration {
        inherit pkgs;
        modules = [
          self.homeManagerModules.default
          {
            home = {
              username = "kepos-test";
              homeDirectory = "/home/kepos-test";
              stateVersion = "25.11";
            };
            xdg.enable = true;
            services.kepos.publisher = {
              enable = true;
              inherit package;
              stateDir = "/home/kepos-test/.local/state/kepos-neo/publisher";
              bootstrap = ["bootstrap.example:49737"];
              displayName = "test-publisher";
              allow = ["1111111111111111111111111111111111111111111111111111111111111111"];
              services.ssh = {
                name = "SSH";
                targetPort = 22;
              };
            };
          }
        ];
      };
      service = home.config.systemd.user.services.kepos-publisher.Service;
      configFile = home.config.xdg.configFile."kepos/config.toml".source;
      moduleCheck = assert service.Restart == "always";
      assert service.KillMode == "mixed";
        pkgs.runCommand "kepos-home-manager-module-check" {
          nativeBuildInputs = [pkgs.gnugrep];
        } ''
          grep -F 'display_name = "test-publisher"' ${configFile}
          grep -F 'bootstrap.example:49737' ${configFile}
          grep -F 'target_port = 22' ${configFile}
          grep -F -- '--observations ndjson' ${pkgs.writeText "kepos-exec-start" (toString service.ExecStart)}
          ${pkgs.lib.getExe package} --help | grep -F 'publisher run'
          touch "$out"
        '';
    in {
      inherit package;
      home-manager-module = moduleCheck;
      container-image = pkgs.runCommand "kepos-container-image-check" {
        nativeBuildInputs = [pkgs.gawk pkgs.jq pkgs.gnutar];
      } ''
        mkdir image
        tar -xf ${containerImage} -C image
        config="$(jq -r '.[0].Config' image/manifest.json)"
        layer="$(jq -r '.[0].Layers[-1]' image/manifest.json)"
        jq -e \
          --arg entrypoint "${package}/bin/kepos" \
          '.config.Entrypoint == [$entrypoint] and .config.User == "10000:10000"' \
          "image/$config" >/dev/null
        test "$(tar -tvf "image/$layer" ./tmp/ | awk 'NR == 1 { print $1 }')" = drwxrwxrwt
        touch "$out"
      '';
    });

    formatter = forAllSystems (system: (pkgsFor system).alejandra);
  };
}
