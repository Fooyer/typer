# Especificação

## Problema

Desenvolvedores ObjectScript/IRIS que preferem um editor moderno (Monaco, tema VS Code, busca,
SQL runner, tester de API REST) a Studio/Portal de Gerenciamento, e que querem um agente de IA
capaz de ler e propor mudanças no código do servidor com segurança (nunca gravando sem revisão
humana).

## Requisitos funcionais

- [x] Gerenciar conexões (host/porta/https/prefixo/usuário/senha/namespace), com teste de conexão.
- [x] Explorar documentos do namespace (classes, rotinas, CSP, qualquer tipo — via
      `%Library.RoutineMgr_StudioOpenDialog`), com filtro de itens de sistema/ruído.
- [x] Editar documentos com Monaco (syntax highlighting ObjectScript via TextMate/Oniguruma,
      completions, hover, navegação de referência de classe).
- [x] Salvar e compilar documentos no servidor.
- [x] Rodar SQL ad-hoc (`SqlRunner`) e testar rotas REST de uma classe `%CSP.REST` (`ApiTester`,
      via `apiRoutes.ts` extraindo `XData UrlMap`).
- [x] Busca de texto no código-fonte do namespace (servidor via v2 quando disponível, com fallback
      documentado quando o endpoint não existe).
- [x] Ações de menu de Studio / server-side source control (`getStudioMenus`,
      `invokeStudioUserAction`), incluindo abrir uma janela para uma ação CSP (ex: login).
- [x] Aba "Specs": notas/planejamento locais em `.md`, com scaffold SDD automático.
- [x] Agente de IA (opencode) por namespace conectado, com:
  - leitura/busca/listagem de documentos do servidor (ferramentas `iris_*`);
  - leitura/escrita de specs locais (ferramentas `specs_*`, sem aprovação — ver constituição);
  - **proposta** de escrita em documento (`iris_propose_write`) que **bloqueia até aprovação
    humana** na UI, mostrando o diff antes de decidir;
  - streaming do raciocínio/saída do agente linha a linha para a UI;
  - continuidade de sessão de chat entre prompts (mesmo `sessionId` do opencode).
- [x] Exportar classe como XML (`classXmlExport.ts`) e salvar em disco via diálogo nativo.
- [x] Auto-update (electron-updater, GitHub releases).

## Requisitos não funcionais

- **Segurança**: ver [[05-seguranca]] — isolamento de processo, sem persistência de dado de
  servidor no cliente, aprovação humana para escrita, defesa contra path traversal em nomes de
  spec/documento, timeouts em toda chamada de rede.
- **Resiliência a servidor instável/limitado**: timeout de 30s (120s para compile) em toda
  chamada Atelier; reaproveitamento de sessão/cookie; fila de concorrência por conexão para não
  esgotar o pool de sessões do IRIS Community/eval.
- **Auditabilidade do agente**: toda proposta de escrita mostra o diff completo antes de aprovar;
  toda saída do agente é logada, e não há caminho silencioso de gravação no servidor.
- **Erros sempre traduzidos e acionáveis**: mensagens de erro de rede/autenticação/formato de
  resposta devem dizer o que aconteceu e, quando possível, o que fazer (ex: "senha incorreta",
  "host não encontrado", "confirme se a API Atelier está habilitada").

## Critérios de aceite

- Nenhuma senha ou conteúdo de documento IRIS aparece em `localStorage`, em nenhum arquivo do
  diretório de specs, ou em qualquer valor retornado por IPC ao renderer além do necessário para
  a sessão atual em memória.
- Uma escrita de código proposta pelo agente nunca chega ao servidor sem uma ação explícita de
  aprovação do usuário na UI.
- Toda função exportada em `electron/*.ts` que faz I/O (rede ou disco) trata erro (try/catch ou
  `.catch`) e não deixa uma `Promise` rejeitar sem que o chamador tenha como reagir.
- Fechar o app com um agente rodando não deixa processo `opencode` órfão.

## Fora de escopo

- Suporte a múltiplos agentes rodando simultaneamente no mesmo app.
- Sincronização/armazenamento de código-fonte localmente (o projeto do agente é só configuração —
  ver [[02-plano]]).
- Autenticação diferente de Basic Auth contra a API Atelier.
