# GSpotify Lab

Versão experimental do [GSpotify](https://github.com/sxoxgxi/gspotify), mantida
no fork [leogouveia/gspotify](https://github.com/leogouveia/gspotify).
Reúne personalizações de interface e melhorias que podem ser propostas ao
projeto original. Não é uma edição oficial do upstream nem é afiliada ao Spotify.
A distribuição é feita pelas Releases deste fork, fora do GNOME Extensions.

## O que muda

- Player com largura configurável, capa maior, controles separados e degradê
  baseado na capa.
- Menu ancorado enquanto a faixa muda e dicas por notificações de exibição única.
- Detecção do SpotDL instalado no diretório do usuário, inclusive via uv, e
  notificações de início, conclusão e falha de downloads.
- Controles adicionais reordenáveis por arraste e teclado. Essa contribuição
  também já foi incorporada ao GSpotify original no PR #16.

Mantém os recursos do GSpotify: controles MPRIS, progresso, estatísticas locais,
conexão com a conta Spotify e downloads opcionais via SpotDL.

## Compatibilidade e dependências

Requer uma **sessão GNOME Shell**. A distribuição Linux, por si só, não determina
compatibilidade; a versão do GNOME e suas bibliotecas também precisam ser compatíveis.

O metadata herdado declara GNOME 46–51. Há registros de testes anteriores das
personalizações no GNOME 51. A preparação do pacote Lab foi feita em um host com
GNOME 51.1; isso não equivale a testar a instalação ou a interface desta versão.
GNOME 46–50 ainda precisam de validação específica das personalizações.
O CI testa o pacote, sem iniciar uma sessão gráfica.

Dependências de execução:

| Componente | Uso |
| --- | --- |
| GNOME Shell / GJS e GLib/GIO | Execução da extensão |
| GTK4 e libadwaita, com bindings GI | Preferências |
| libsoup 3 e GdkPixbuf, com bindings GI | Rede e imagens |
| libsecret, com bindings GI, e um serviço Secret Service | Autenticação Spotify |
| Spotify com interface MPRIS disponível na sessão | Reprodução e controles |
| SpotDL e suas dependências, incluindo FFmpeg | Downloads opcionais |

Os nomes dos pacotes variam entre distros. Instale esses componentes pelo
mecanismo da sua distribuição. O SpotDL não é necessário para usar os controles;
nenhum script deste projeto instala dependências automaticamente.
A conexão com a conta usa seu próprio Client ID, configurado nas preferências.

## Instalação por download

Quando a primeira Release estiver publicada:

1. Acesse [Releases do GSpotify Lab](https://github.com/leogouveia/gspotify/releases).
2. Baixe `gspotify-lab-vX.Y.Z.shell-extension.zip` e seu arquivo `.sha256`.
   Use o ZIP anexado pela pipeline, não o arquivo automático “Source code”.
3. Na pasta dos downloads, confira o checksum e instale. Exemplo para `v1.0.0`:

   ```bash
   sha256sum -c gspotify-lab-v1.0.0.shell-extension.zip.sha256
   gnome-extensions install --force ./gspotify-lab-v1.0.0.shell-extension.zip
   ```

4. Saia e entre novamente na sessão GNOME para carregar o código instalado.
5. Ative e abra as preferências:

   ```bash
   gnome-extensions enable gspotify-lab@leogouveia.com
   gnome-extensions prefs gspotify-lab@leogouveia.com
   ```

**O Lab possui UUID próprio**: `gspotify-lab@leogouveia.com`.
Na lista de extensões, ele aparece como **GSpotify Lab**, separado do
**GSpotify & Downloader** original. As duas extensões podem permanecer instaladas.
O ZIP do Lab não substitui nem atualiza a extensão original.

Se você instalou o Lab com o UUID antigo, consulte as
[instruções de troca de UUID](docs/releases.md#troca-do-uuid-do-lab) antes de instalar.

As configurações, credenciais e estatísticas são independentes:

- Schema: `org.gnome.shell.extensions.gspotify-lab`.
- Estatísticas: `$XDG_CONFIG_HOME/gspotify-lab` (normalmente `~/.config/gspotify-lab`).
- Credenciais Spotify: entradas próprias do Lab no serviço de segredos.
- Downloads por padrão: `~/GSpotifyLabDownloads`.
- Callback OAuth por padrão: `http://127.0.0.1:9001/callback`.

O Lab começa com configurações novas; não copia preferências, histórico ou tokens
do original. Configure seu Client ID e registre o endereço de callback acima no
aplicativo Spotify que você usa para autenticação. A porta pode ser alterada nas
preferências; nesse caso, ajuste também o endereço registrado no Spotify.

Se ambas estiverem ativadas, cada uma poderá mostrar seu indicador e controlar
o mesmo Spotify. Ações como volume e silenciamento de anúncios afetam o player
compartilhado. Para comparar as interfaces, você pode alternar qual delas fica ativa.

## Atualização e retorno a uma versão anterior

Baixe o ZIP da versão desejada e repita a instalação com `--force`, seguida de
uma nova entrada na sessão. Guarde o ZIP anterior para poder reinstalá-lo.
As configurações permanecem no mesmo schema; uma versão antiga pode não entender
opções criadas posteriormente. Para usar apenas o upstream, desative o Lab e ative a extensão original;
a instalação e os dados do original permanecem separados.

Para desativar sem apagar configurações:

```bash
gnome-extensions disable gspotify-lab@leogouveia.com
```

## Empacotamento local

Ferramentas: Python 3.9+, Node.js (checagem de sintaxe), `gnome-extensions` e
`glib-compile-schemas`. Não é necessário instalar dependências npm para empacotar.
Os testes de isolamento também usam o executável `gjs`, sem abrir uma sessão gráfica.

```bash
git clone --branch main https://github.com/leogouveia/gspotify.git
cd gspotify
python3 scripts/package.py --check
python3 scripts/package.py
```

O comando produz o ZIP e o checksum em `dist/`, sem instalar a extensão ou
alterar os schemas do checkout. Os arquivos temporários são removidos ao terminar.
O pacote é extraído e verificado antes de ser disponibilizado em `dist/`.

Para informações sobre branches, validação e publicação, consulte
[o guia de Releases](docs/releases.md).

## Desenvolvimento

A `main` contém a versão Lab. O remoto `upstream` aponta para o projeto original.
Contribuições ao upstream devem partir de uma branch do original, levando apenas
a alteração proposta. A branch `personal/customizations` preserva o trabalho anterior.

Logs da sessão:

```bash
journalctl -f -o cat /usr/bin/gnome-shell
```

## Licença e créditos

Distribuído sob a [licença MIT](LICENSE), preservando o aviso de copyright original.
O projeto original e seus autores são responsáveis pela base do GSpotify;
este fork reúne as modificações do Lab.
