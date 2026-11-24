# Manutenção e Releases do GSpotify Lab

## Fluxo de validação

PRs para `main` e pushes na `main` executam `.github/workflows/validate.yml`.
Também é possível executar a validação manualmente pela aba Actions.

O workflow instala ferramentas no runner Ubuntu 24.04, executa o mesmo
`python3 scripts/package.py` usado localmente e guarda o ZIP e o checksum como
artefatos por 14 dias. Isso não publica uma Release nem instala a extensão.

O script verifica sintaxe dos módulos JavaScript, imports relativos, schemas
com compilação estrita, integridade do ZIP, correspondência dos arquivos com o
checkout e inclusão dos recursos de execução. Os schemas são compilados em uma
pasta temporária. O ZIP não contém `.git`, `node_modules`, documentação de
desenvolvimento ou dados de autenticação do usuário.

O CI não comprova o funcionamento da interface, MPRIS, Secret Service, OAuth ou
downloads. Antes de uma Release, registre a versão do GNOME usada no teste manual
e verifique player, preferências, controles, troca de faixa e reabertura do menu.
Quando aplicável, verifique autenticação e downloads separadamente.

Os testes de regressão exercitam rejeição de tag incorreta, dependência local
ausente e arquivos ZIP incompletos ou com caminhos inseguros. Um teste com GJS e
backend GSettings em memória confirma que alterações nas preferências do Lab
não escrevem no caminho do original, sem alterar as configurações da sessão.
Para executá-los:

```bash
python3 -B -m unittest discover -s tests -v
```

## Versionamento

- `metadata.json` → `version-name`: versão pública do Lab, como `1.0.0`.
- Tag: a mesma versão com prefixo `v`, como `v1.0.0`.
- `metadata.json` → `version`: inteiro crescente do GNOME, começando em `24`
  nesta preparação do Lab, acima do valor herdado `23`. Incremente a cada Release.

O script aceita versões estáveis `MAJOR.MINOR.PATCH`. Pré-releases não fazem
parte deste primeiro fluxo. A numeração do Lab é independente das releases do
upstream. Uma versão preparada nos arquivos ainda não é uma Release publicada.

## Preparar a primeira publicação

1. Revisar e concluir o merge local das customizações e as alterações de distribuição.
2. Com autorização para publicar, enviar `main` para `origin` e configurá-la como
   branch padrão do fork no GitHub. Conferir se Actions está habilitado no fork.
3. Aguardar o workflow de validação e conferir o artefato.
4. Fazer o teste manual de instalação em uma sessão apropriada. A automação não
   reinicia o GNOME nem altera a instalação do mantenedor.
5. Publicar a tag apenas quando o pacote estiver aprovado.

## Publicar uma versão

Com a árvore limpa, na `main` validada e enviada ao fork, e depois de revisar
as versões do metadata e as notas da mudança:

```bash
python3 scripts/package.py --release-tag v1.0.0
git tag -a v1.0.0 -m "GSpotify Lab v1.0.0"
git push origin v1.0.0
```

Esses comandos são instruções para o mantenedor: não são executados pelo script.
O push da tag é o gatilho de publicação; um push comum da `main` não publica.

O workflow `.github/workflows/release.yml`:

1. Executa somente no repositório `leogouveia/gspotify`, para tags `v*`.
2. Confirma que o commit da tag pertence ao histórico de `origin/main`.
3. Exige correspondência exata entre a tag e `metadata.version-name`.
4. Gera e verifica o ZIP e o checksum em um job sem permissão de escrita.
5. Transfere os arquivos para o job de publicação, que usa `GITHUB_TOKEN` com
   `contents: write` para criar a Release com os anexos e notas automáticas.

Não é necessário cadastrar um token pessoal. As notas automáticas podem ser
editadas para explicar compatibilidade, alterações e limitações da versão.
Não há envio ao GNOME Extensions, nem alteração do repositório upstream.

Se o build falhar, nenhuma Release será criada. Se já existir uma Release com a
mesma tag, o comando de criação falhará em vez de substituir seus anexos. Examine
a execução antes de tentar novamente; não mova tags de versões já distribuídas.

## Atualizar a base do upstream

Busque o original, crie uma branch de atualização a partir da nossa `main`, faça
merge da branch principal do upstream e valide o resultado antes de incorporá-lo.
Revise especialmente o metadata: nome, URL, identidade e versões do Lab precisam
continuar corretos. Preserve o arquivo LICENSE e os créditos do projeto original.

## Identidade independente do Lab

O Lab usa o UUID `gspotify-lab@leogouveia.com`, nome visível **GSpotify Lab**
e schema `org.gnome.shell.extensions.gspotify-lab`, no caminho
`/org/gnome/shell/extensions/gspotify-lab/`. Estatísticas, entradas do Secret
Service, classes CSS, tipos GObject e arquivos temporários têm nomes próprios
para evitar colisões com a extensão original. Os IDs da área de status já são
calculados a partir do UUID.

Não há migração automática dos dados da extensão original. O callback OAuth do
Lab usa porta 9001 por padrão, e o destino padrão de downloads é
`~/GSpotifyLabDownloads`. Mesmo com identidades separadas, ambas controlam a mesma
instância do Spotify quando ativadas na mesma sessão.

Antes da primeira Release com essa identidade, confira a instalação lado a lado
em uma sessão gráfica: nomes na lista de extensões, ativação, preferências,
estilos e desativação de cada extensão sem afetar a outra. Os testes isolados de
configurações não substituem essa verificação.

## Troca do UUID do Lab

O UUID anterior era `gspotify-lab@leogouveia.github.io`. O GNOME considera o novo
UUID uma extensão diferente, portanto instalar o pacote novo não substitui a
pasta da instalação anterior.

Antes de instalar o novo pacote, desative a identidade antiga:

```bash
gnome-extensions disable gspotify-lab@leogouveia.github.io
```

Após instalar, saia e entre novamente na sessão e ative somente
`gspotify-lab@leogouveia.com`. As duas identidades do Lab não devem ficar ativas
ao mesmo tempo: compartilham o schema, as credenciais, as estatísticas e os tipos
GObject. Esses identificadores de armazenamento foram preservados para manter
compatibilidade com os dados existentes do Lab; a porta padrão continua 9001.

Depois de validar a nova instalação, a identidade antiga pode ser desinstalada.
