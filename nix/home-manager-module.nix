{
  config,
  lib,
  pkgs,
  ...
}: let
  cfg = config.services.kepos.publisher;
  toml = pkgs.formats.toml {};
  serviceIdPattern = "^[a-z][a-z0-9-]*$";
  subscriberDeviceType = lib.types.submodule {
    options = {
      label = lib.mkOption {
        type = lib.types.nonEmptyStr;
        description = "Publisher-local label for a trusted subscriber device.";
      };
      publicKey = lib.mkOption {
        type = lib.types.strMatching "[0-9a-f]{64}";
        description = "Subscriber device public key in lowercase hexadecimal.";
      };
    };
  };
  subscriberLabels = map (subscriber: subscriber.label) cfg.subscribers;
  subscriberKeys = map (subscriber: subscriber.publicKey) cfg.subscribers;
  serviceType = lib.types.submodule {
    options = {
      name = lib.mkOption {
        type = lib.types.nonEmptyStr;
        description = "Human-readable service name shown by Kepos Home.";
      };
      targetPort = lib.mkOption {
        type = lib.types.ints.between 1 65535;
        description = "Publisher loopback TCP port.";
      };
      allow = lib.mkOption {
        type = lib.types.nullOr (lib.types.listOf (lib.types.strMatching "[0-9a-f]{64}"));
        default = null;
        description = "Subscriber public keys allowed to open this service; null inherits publisher subscriber devices.";
      };
    };
  };
  publisherServices = lib.mapAttrsToList (id: service:
    {
      inherit id;
      inherit (service) name;
      target_port = service.targetPort;
    }
    // lib.optionalAttrs (service.allow != null) {
      inherit (service) allow;
    })
  cfg.services;
  configFile = toml.generate "kepos-config.toml" {
    network.bootstrap = cfg.bootstrap;
    publisher = {
      display_name = cfg.displayName;
      subscribers =
        map (subscriber: {
          inherit (subscriber) label;
          public_key = subscriber.publicKey;
        })
        cfg.subscribers;
      services = publisherServices;
    };
  };
  initialize = pkgs.writeShellApplication {
    name = "kepos-initialize-publisher";
    runtimeInputs = [pkgs.coreutils];
    text = ''
      state_dir=${lib.escapeShellArg cfg.stateDir}
      if [[ -f "$state_dir/publisher.manifest.json" && -f "$state_dir/publisher.json" ]]; then
        exit 0
      fi
      if [[ -e "$state_dir" ]]; then
        echo "Kepos publisher state is partial or invalid: $state_dir" >&2
        exit 1
      fi

      umask 077
      mkdir -p "$(dirname "$state_dir")"
      exec ${lib.getExe cfg.package} setup publisher \
        --state "$state_dir" \
        --config ${lib.escapeShellArg (toString configFile)}
    '';
  };
in {
  options.services.kepos.publisher = {
    enable = lib.mkEnableOption "Kepos publisher";

    package = lib.mkOption {
      type = lib.types.package;
      default = pkgs.callPackage ./package.nix {};
      defaultText = lib.literalExpression "pkgs.callPackage ./nix/package.nix {}";
      description = "Kepos package used by the publisher service.";
    };

    stateDir = lib.mkOption {
      type = lib.types.str;
      default = "${config.xdg.stateHome}/kepos-neo/publisher";
      description = "Mutable publisher identity directory outside the Nix store.";
    };

    bootstrap = lib.mkOption {
      type = lib.types.listOf lib.types.nonEmptyStr;
      default = [];
      description = "HyperDHT bootstrap host:port endpoints; empty uses HyperDHT defaults.";
    };

    displayName = lib.mkOption {
      type = lib.types.nonEmptyStr;
      default = "Local Publisher";
      description = "Publisher name displayed by Kepos Home.";
    };

    subscribers = lib.mkOption {
      type = lib.types.listOf subscriberDeviceType;
      default = [];
      description = "Trusted subscriber devices; an empty list denies every subscriber.";
    };

    services = lib.mkOption {
      type = lib.types.attrsOf serviceType;
      default = {};
      description = "Loopback TCP services published over the shared Kepos connection.";
    };
  };

  config = lib.mkIf cfg.enable {
    assertions = [
      {
        assertion = lib.hasPrefix "/" cfg.stateDir;
        message = "services.kepos.publisher.stateDir must be an absolute path";
      }
      {
        assertion = lib.all (
          id: id != "home" && builtins.match serviceIdPattern id != null
        ) (lib.attrNames cfg.services);
        message = "services.kepos.publisher.services names must be lowercase, non-reserved service IDs";
      }
      {
        assertion = lib.length (lib.unique subscriberLabels) == lib.length subscriberLabels;
        message = "services.kepos.publisher.subscribers labels must be unique";
      }
      {
        assertion = lib.length (lib.unique subscriberKeys) == lib.length subscriberKeys;
        message = "services.kepos.publisher.subscribers public keys must be unique";
      }
    ];

    home.packages = [cfg.package];
    xdg.configFile."kepos/config.toml".source = configFile;

    systemd.user.services.kepos-publisher = {
      Unit = {
        Description = "Kepos publisher";
        After = ["network-online.target"];
      };
      Install.WantedBy = ["default.target"];
      Service = {
        Type = "simple";
        ExecStartPre = lib.getExe initialize;
        ExecStart = lib.escapeShellArgs [
          (lib.getExe cfg.package)
          "publisher"
          "run"
          "--state"
          cfg.stateDir
          "--config"
          (toString configFile)
          "--observations"
          "ndjson"
        ];
        Restart = "always";
        RestartSec = 5;
        KillMode = "mixed";
        TimeoutStopSec = 15;
        UMask = "0077";
        NoNewPrivileges = true;
        PrivateTmp = true;
      };
    };
  };
}
