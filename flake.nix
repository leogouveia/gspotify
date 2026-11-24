{
  description = "GSpotify Lab - GNOME Shell Extension";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs =
    { self, nixpkgs }:
    let
      systems = [
        "x86_64-linux"
        "aarch64-linux"
      ];
      metadata = builtins.fromJSON (builtins.readFile ./metadata.json);
    in
    {
      packages = nixpkgs.lib.genAttrs systems (
        system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
        in
        {
          default = pkgs.stdenvNoCC.mkDerivation {
            pname = "gspotify-lab";
            version = metadata."version-name";

            src = self;

            nativeBuildInputs = with pkgs; [
              python3
              nodejs
              glib.dev
              gnome-shell
              zip
              unzip
            ];

            buildPhase = ''
              runHook preBuild
              python3 scripts/package.py --out-dir "$TMPDIR/bundle"
              runHook postBuild
            '';

            installPhase = ''
              runHook preInstall
              target="$out/share/gnome-shell/extensions/${metadata.uuid}"
              mkdir -p "$target"
              unzip "$TMPDIR/bundle/gspotify-lab-v${metadata."version-name"}.shell-extension.zip" -d "$target"
              runHook postInstall
            '';

            passthru.extensionUuid = metadata.uuid;

            meta = {
              description = "GSpotify Lab - GNOME Shell Extension";
              homepage = metadata.url;
              license = pkgs.lib.licenses.mit;
              platforms = systems;
            };
          };
        }
      );
    };
}
