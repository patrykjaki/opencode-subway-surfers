{
  description = "Web Subway Surfers Tauri wrapper with OpenCode auto-pause";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = import nixpkgs { inherit system; };
        isLinux = pkgs.stdenv.isLinux;
        isDarwin = pkgs.stdenv.isDarwin;

        linuxRuntimeDeps = pkgs.lib.optionals isLinux (with pkgs; [
          webkitgtk_4_1
          gtk3
          libsoup_3
          glib
          cairo
          pango
          gdk-pixbuf
          librsvg
          libayatana-appindicator
          openssl
        ]);

        linuxBuildDeps = pkgs.lib.optionals isLinux (with pkgs; [
          pkg-config
          wrapGAppsHook4
        ]);

        darwinDeps = pkgs.lib.optionals isDarwin (with pkgs; [
          libiconv
        ]);

        subway-wrapper = pkgs.rustPlatform.buildRustPackage {
          pname = "subway-wrapper";
          version = "0.1.0";

          src = ./.;
          sourceRoot = "source/apps/subway/src-tauri";

          cargoLock = {
            lockFile = ./apps/subway/src-tauri/Cargo.lock;
          };

          nativeBuildInputs = [
            pkgs.pkg-config
          ] ++ linuxBuildDeps;

          buildInputs = linuxRuntimeDeps ++ darwinDeps;

          meta = with pkgs.lib; {
            description = "Tauri wrapper for web Subway Surfers with OpenCode auto-pause";
            platforms = platforms.unix;
            mainProgram = "subway-wrapper";
          };
        };
      in
      {
        packages = {
          default = subway-wrapper;
          inherit subway-wrapper;
        };

        apps.default = flake-utils.lib.mkApp {
          drv = subway-wrapper;
        };

        devShells.default = pkgs.mkShell {
          packages = with pkgs; [
            rustc
            cargo
            rust-analyzer
            clippy
            nodejs_22
            pkg-config
          ] ++ linuxRuntimeDeps ++ darwinDeps;

          shellHook = pkgs.lib.optionalString isLinux ''
            export LD_LIBRARY_PATH="${pkgs.lib.makeLibraryPath linuxRuntimeDeps}:$LD_LIBRARY_PATH"
          '';
        };
      });
}
