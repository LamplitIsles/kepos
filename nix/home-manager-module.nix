{
  config,
  lib,
  pkgs,
  ...
}: let
  cfg = config.services.kepos.peer;
  toml = pkgs.formats.toml {};
  keyPattern = "[0-9a-f]{64}";
  serviceIdPattern = "^[a-z][a-z0-9-]*$";
  endpointPathType = lib.types.nullOr lib.types.str;

  peerType = lib.types.submodule {
    options = {
      publicKey = lib.mkOption {
        type = lib.types.strMatching keyPattern;
        description = "Configured peer public key in lowercase hexadecimal.";
      };
      connection = lib.mkOption {
        type = lib.types.enum ["dial" "accept"];
        description = "Direction owned by this peer runtime for the relationship.";
      };
    };
  };

  sourceType = lib.types.submodule {
    options = {
      localPort = lib.mkOption {
        type = lib.types.nullOr (lib.types.ints.between 1 65535);
        default = null;
        description = "Fixed loopback TCP service source port.";
      };
      unixSocket = lib.mkOption {
        type = endpointPathType;
        default = null;
        description = "Absolute Unix socket service source path.";
      };
      peer = lib.mkOption {
        type = lib.types.nullOr lib.types.str;
        default = null;
        description = "Named configured upstream peer.";
      };
      service = lib.mkOption {
        type = lib.types.nullOr (lib.types.strMatching serviceIdPattern);
        default = null;
        description = "Service ID selected from the upstream peer.";
      };
    };
  };

  serviceType = lib.types.submodule {
    options = {
      name = lib.mkOption {
        type = lib.types.nonEmptyStr;
        description = "Human-readable service name shown by Kepos Home.";
      };
      kind = lib.mkOption {
        type = lib.types.enum ["tcp" "http" "udp"];
        default = "tcp";
        description = "Published service transport kind.";
      };
      source = lib.mkOption {
        type = sourceType;
        default = {};
        description = "Exactly one loopback port, Unix socket, or peer/service source.";
      };
      allow = lib.mkOption {
        type = lib.types.listOf (lib.types.strMatching keyPattern);
        default = [];
        description = "Immediate peer public keys allowed to open this service.";
      };
      maxPublisherToSubscriberBps = lib.mkOption {
        type = lib.types.nullOr lib.types.ints.positive;
        default = null;
        description = "Optional publisher-to-consumer byte rate limit.";
      };
    };
  };

  bindingType = lib.types.submodule {
    options = {
      peer = lib.mkOption {
        type = lib.types.str;
        description = "Configured peer label selected for this local binding.";
      };
      service = lib.mkOption {
        type = lib.types.strMatching serviceIdPattern;
        description = "Remote service ID selected for this binding.";
      };
      localPort = lib.mkOption {
        type = lib.types.nullOr (lib.types.ints.between 0 65535);
        default = null;
        description = "Loopback TCP port to own for the binding.";
      };
      unixSocket = lib.mkOption {
        type = endpointPathType;
        default = null;
        description = "Absolute Unix socket path to own for the binding.";
      };
    };
  };

  peerEntries = lib.mapAttrsToList (label: peer: {
    inherit label;
    public_key = peer.publicKey;
    inherit (peer) connection;
  }) cfg.peers;

  sourceValue = source:
    if source.localPort != null then {local_port = source.localPort;}
    else if source.unixSocket != null then {unix_socket = source.unixSocket;}
    else {inherit (source) peer service;};

  serviceEntries = lib.mapAttrsToList (id: service:
    {
      inherit id;
      inherit (service) name;
      source = sourceValue service.source;
    }
    // lib.optionalAttrs (service.kind != "tcp") {inherit (service) kind;}
    // lib.optionalAttrs (service.allow != []) {inherit (service) allow;}
    // lib.optionalAttrs (service.maxPublisherToSubscriberBps != null) {
      max_publisher_to_subscriber_bps = service.maxPublisherToSubscriberBps;
    }) cfg.services;

  bindingListen = binding:
    if binding.localPort != null then {local_port = binding.localPort;}
    else {unix_socket = binding.unixSocket;};

  bindingEntries = map (binding: {
    inherit (binding) peer service;
    listen = bindingListen binding;
  }) cfg.bindings;

  configValue = {
    network.bootstrap = cfg.bootstrap;
    peers = peerEntries;
    services = serviceEntries;
    bindings = bindingEntries;
    gateway = {
      port = cfg.gateway.port;
      host = cfg.gateway.host;
    } // lib.optionalAttrs (cfg.gateway.domain != null) { domain = cfg.gateway.domain; };
  };
  configFile = toml.generate "kepos-config.toml" configValue;
  initialize = pkgs.writeShellApplication {
    name = "kepos-initialize-peer";
    text = ''
      state_dir=${lib.escapeShellArg cfg.stateDir}
      umask 077
      exec ${lib.getExe cfg.package} setup peer --state "$state_dir"
    '';
  };
in {
  options.services.kepos.peer = {
    enable = lib.mkEnableOption "Kepos peer";

    package = lib.mkOption {
      type = lib.types.package;
      default = pkgs.callPackage ./package.nix {};
      defaultText = lib.literalExpression "pkgs.callPackage ./nix/package.nix {}";
      description = "Kepos package that runs the canonical peer runtime.";
    };

    stateDir = lib.mkOption {
      type = lib.types.str;
      default = "${config.xdg.stateHome}/kepos-neo/peer";
      description = "Mutable canonical peer identity directory outside the Nix store.";
    };

    bootstrap = lib.mkOption {
      type = lib.types.listOf lib.types.nonEmptyStr;
      default = [];
      description = "HyperDHT bootstrap host:port endpoints.";
    };

    peers = lib.mkOption {
      type = lib.types.attrsOf peerType;
      default = {};
      description = "Named peers with an explicit local dial or accept direction.";
    };

    services = lib.mkOption {
      type = lib.types.attrsOf serviceType;
      default = {};
      description = "Explicit local or peer/service sources and immediate grants.";
    };

    bindings = lib.mkOption {
      type = lib.types.listOf bindingType;
      default = [];
      description = "Locally owned TCP or Unix bindings for remote services.";
    };

    gateway = {
      port = lib.mkOption {
        type = lib.types.ints.between 0 65535;
        default = 17480;
        description = "Loopback HTTP gateway port; zero selects an ephemeral port.";
      };
      host = lib.mkOption {
        type = lib.types.nonEmptyStr;
        default = "127.0.0.1";
        description = "HTTP gateway bind host.";
      };
      domain = lib.mkOption {
        type = lib.types.nullOr lib.types.nonEmptyStr;
        default = null;
        description = "Optional additional HTTP gateway domain.";
      };
    };
  };

  config = lib.mkIf cfg.enable {
    assertions = [
      {
        assertion = lib.hasPrefix "/" cfg.stateDir;
        message = "services.kepos.peer.stateDir must be an absolute path";
      }
      {
        assertion = lib.all (id: id != "home" && builtins.match serviceIdPattern id != null) (lib.attrNames cfg.services);
        message = "services.kepos.peer.services names must be lowercase, non-reserved service IDs";
      }
      {
        assertion = lib.length (lib.unique (map (peer: peer.publicKey) (lib.attrValues cfg.peers))) == lib.length (lib.attrValues cfg.peers);
        message = "services.kepos.peer.peers public keys must be unique";
      }
      {
        assertion = lib.all (service:
          let source = service.source;
          in (source.localPort != null) + (source.unixSocket != null) + (source.peer != null || source.service != null) == 1
          && ((source.peer == null) == (source.service == null))) (lib.attrValues cfg.services);
        message = "services.kepos.peer.services sources must select exactly one complete variant";
      }
      {
        assertion = lib.all (service:
          service.source.unixSocket == null || (lib.hasPrefix "/" service.source.unixSocket && builtins.stringLength service.source.unixSocket <= 103)) (lib.attrValues cfg.services);
        message = "services.kepos.peer Unix socket sources must be absolute and at most 103 characters";
      }
      {
        assertion = lib.all (binding:
          (binding.localPort != null) + (binding.unixSocket != null) == 1
          && (binding.unixSocket == null || (lib.hasPrefix "/" binding.unixSocket && builtins.stringLength binding.unixSocket <= 103))) cfg.bindings;
        message = "services.kepos.peer bindings must select one valid local endpoint";
      }
    ];

    home.packages = [cfg.package];
    xdg.configFile."kepos/config.toml".source = configFile;

    systemd.user.services.kepos-peer = {
      Unit = {
        Description = "Kepos peer";
        After = ["network-online.target"];
      };
      Install.WantedBy = ["default.target"];
      Service = {
        Type = "simple";
        ExecStartPre = lib.getExe initialize;
        ExecStart = lib.escapeShellArgs [
          (lib.getExe cfg.package)
          "peer"
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
