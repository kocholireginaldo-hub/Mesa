# XR18 Studio

Cópia fiel do **X AIR Edit** (Mixer, Channel, Input, Gate, EQ, Comp, Sends, Main, FX, Meter, DCA, mute groups, buses) para a **Behringer XR18**, com:

- **REC** – grava os 16 canais + Aux L/R em multipista pelo USB, importa/exporta WAV e reproduz de volta pelos retornos USB (virtual soundcheck).
- **IA (aba)** – *IA da Gravação*: analisa o áudio gravado (FFT, RMS, crista, LUFS…) e propõe ajustes que você aprova.
- **IA da Mesa (botão "IA" na barra superior, em todas as telas)** – operador auxiliar ao vivo, com 4 níveis de autonomia e camada de segurança.

> ⚠️ **Ainda NÃO foi testado com uma XR18 física.** Tudo foi validado só com um simulador da mesa (OSC/UDP) e com a sua `cena_2026.scn`. Veja "Limitações" e "O que depende da mesa real".

## Como executar
### No PC (recomendado: controla a mesa + IA em nuvem)
1. Instale o **Node.js LTS** (https://nodejs.org).
2. Windows: duplo clique em `iniciar-pc.bat`. Linux/Mac: `./iniciar-pc.sh`. Abra **Chrome ou Edge** em `http://localhost:8080`.
3. **Setup → IP da mesa → Conectar** (ou "Descobrir mesa"). Sem mesa, o app roda em **modo demo**.
4. **REC**: escolha a entrada USB da XR18 → Gravar. O USB leva só áudio; o **controle** vai por rede (OSC, porta 10024). Use os dois juntos.

Sem Node.js o `iniciar-pc.bat` abre o `index.html` em modo demo (sem mesa e sem IA em nuvem).

### No celular/tablet (controle pela rede local, sem internet)
Deixe o PC rodando o servidor e abra no navegador do celular `http://IP-DO-PC:8080` (ex.: `http://192.168.0.20:8080`), mesma rede Wi-Fi da mesa. O celular usa a ponte do PC. Em *Setup*, troque `localhost` no campo "Ponte" pelo IP do PC.

## Gravador: faixas
Cada faixa tem **R** (armar), **M** (mudo), **S** (solo), **📁** (carregar um arquivo de áudio nesta faixa; também dá para arrastar o arquivo sobre a faixa) e **✕** (remover o áudio da faixa; há **Desfazer remoção**). Se a saída escolhida tiver menos canais que as faixas (ex.: saída estéreo do PC), o app toca o **mix estéreo de todas as faixas** e avisa em laranja — antes só as 2 primeiras eram ouvidas. Retorno multicanal para a mesa exige um dispositivo de saída com 18 canais.

## Indicadores de modo (barra superior)
**MODO DEMO** (simulador) · **MESA CONECTADA** · **MESA DESCONECTADA** · **ERRO DE COMUNICAÇÃO** (inclui "sem resposta da mesa há 15 s").

## IA — arquitetura
Uma plataforma central (`ai-core.js`) e dois especialistas independentes:
| | IA da Mesa (`ai-mesa.js`) | IA da Gravação (`ai.js`) |
|---|---|---|
| Dados | medidores e estado da mesa (não precisa do gravador) | faixas gravadas/importadas |
| Faz | alertas, recomendações, correções limitadas | análise de níveis/espectro/loudness, sugestões que você aprova |
| Contexto/histórico | próprios | próprios |
Núcleo compartilhado: servidor das chaves, limites de consumo, erros, disponibilidade, logs e histórico. Os dados só vão à nuvem como **resumos numéricos**, em intervalos configuráveis, sem repetir dados idênticos.

### Níveis de autonomia (seletor na barra superior)
1. **Consultor** – só recomenda. 2. **Assistido** – pede sua autorização a cada alteração. 3. **Supervisionado** – executa sozinha só as classes que você autorizou (painel *IA → Autonomia e limites*). 4. **Autônomo** – corrige dentro de limites rígidos.
Botões globais: **IA ON/OFF**, **⏸ Pausar**, **■ Parar** (pausa e limpa pendências), **IA** (alertas, histórico com *Desfazer*, limites, chaves).

### Camada de segurança (todo comando passa por ela)
A IA **nunca**: muta canais, silencia o Main LR, desliga microfone, altera phantom, roteamento, atribuições, grupos DCA/mute ou envios, nem manda `-∞`. Só altera fader, ganho, low-cut, EQ, compressor e gate, com **limite por ação**, **desvio máximo do valor definido por você** (mais restrito em canais de pregador/voz) e no máximo 6 ações automáticas/minuto. Alterar ganho de entrada de canal de voz sempre pede autorização. Cada ação registra valor anterior, novo valor, motivo, horário e resultado; com a mesa ligada, só é dada como feita quando a mesa **confirma** (leitura de volta). A proteção contra picos é **100 % local** (não depende do Gemini). Picos isolados não geram ação; só excesso persistente.

### Chaves Gemini
- As chaves ficam **somente no servidor local** (`~/.xr18-studio/config.json`, permissão 600) – nunca no HTML, no JavaScript, no localStorage, no backup nem no GitHub. Cadastro: **Setup → IA em nuvem** (somente no PC que roda o servidor). Também aceita a variável `GEMINI_API_KEY`.
- Chave principal + reservas, com **ordem** configurável, ativar/desativar, **limite diário por chave** e substituição/remoção.
- Rodízio automático: limite (429) → cooldown e próxima chave; chave inválida (401/403) → marcada; falha de rede/5xx → pausa curta. Mostra a chave ativa, chamadas, falhas e tokens estimados.
- Chaves de **projetos diferentes** têm cotas separadas; várias chaves do mesmo projeto **não** multiplicam o limite.
- Modelo padrão econômico `gemini-2.5-flash-lite` (editável em Setup; há modelos reserva). Não pôde ser validado com chave real neste ambiente.

### Sem internet
O controle local da mesa, os faders, os alertas e as análises locais continuam. A barra mostra "☁ sem internet · IA local"; a nuvem não é usada e nenhuma ação automática depende dela.

## Backup e persistência
Configurações, cena (salva sozinha) e histórico ficam no IndexedDB do navegador + cópia em arquivo no PC (via servidor). **Setup → Backup**: exportar, restaurar (valida o arquivo, pede confirmação e guarda cópia do estado anterior) e desfazer restauração. Cenas `.scn` do X AIR Edit continuam compatíveis (testado: leitura → gravação → leitura sem perda). A gravação é salva em segmentos a cada ~10 s: se o navegador fechar, use **Recuperar última gravação** na aba REC.

## COMO PUBLICAR NO GITHUB PELO CELULAR
1. Baixe o arquivo **XR18-Studio.zip** no celular.
2. Abra o arquivo no gerenciador de arquivos e toque em **Extrair** (os arquivos ficam soltos: `index.html`, `style.css`, vários `.js`…).
3. No navegador do celular entre em **github.com**, abra seu repositório (ou crie um: **+ → New repository**).
4. Na página principal do repositório toque em **Add file → Upload files**.
5. Selecione **todos os arquivos extraídos** (não o ZIP) para enviar direto na raiz. Dica: no seletor, toque em "Selecionar tudo".
6. Role até o fim, toque **Commit changes**.
7. Confira: na página principal do repositório deve aparecer o `index.html` junto com os outros arquivos (sem pastas).
8. **GitHub Pages**: *Settings → Pages → Source: Deploy from a branch → Branch: main → / (root) → Save*. Em 1–2 minutos o endereço aparece ali.
9. **Atualizar depois**: repita *Add file → Upload files* com os arquivos novos; arquivos de mesmo nome são substituídos.
> O GitHub não "executa" um ZIP: envie os arquivos **extraídos**.
> **Importante sobre o GitHub Pages:** a página publicada funciona (modo demo, gravador, análises, EQ), mas o navegador **não deixa uma página https falar com a mesa pela rede local**. Para controlar a XR18 use o servidor no PC (`iniciar-pc.bat`) ou o app Android. Se mesmo assim quiser abrir a página do Pages no PC, rode `node servidor.js --origem https://SEU-USUARIO.github.io` (autoriza só essa origem).
> Limite do upload pelo navegador: 100 arquivos por vez e 25 MB por arquivo — o app tem 17 arquivos pequenos.

## Arquivos (tudo na raiz)
`index.html` `style.css` · `core.js` (OSC, cena, store) · `ui.js` · `eq.js` · `rec.js` (gravador) · `ai-core.js` · `ai-mesa.js` · `ai.js` (IA da gravação) · `storage.js` · `main.js` · `cena_2026.js/.scn` · `servidor.js` (app + ponte OSC + proxy seguro do Gemini) · `iniciar-pc.bat/.sh` · `README.md`.

## Limitações conhecidas (leia)
- **Não testado com XR18 real.** Protocolo conferido nos textos do `X-AIR-Edit.exe` e simulado.
- Áudio multicanal no navegador depende do driver (Windows pode expor só 2 canais; alternativa: gravar no Reaper e **Importar áudio**). USB multicanal em celular **não** foi testado: não use como garantia.
- A gravação fica na memória (~1,7 MB/s com 18 canais; recuperação automática em segmentos). WAV multicanal acima de 4 GB é recusado com aviso (use "1 WAV por canal").
- Não verificados na mesa: formato de roteamento por OSC, layout de `/meters`, endereços do GEQ, enum de `tap`, renovação da assinatura de medidores (feita a cada 5 s). Edição de parâmetros internos de FX é só leitura; **TEQ** não implementado.
- Metas da IA são heurísticas (editáveis em `ai.js`, objeto `PROF`), não substituem o ouvido.
- Integração real com Gemini depende de chave e não pôde ser testada aqui (testada com simulador do provedor).

## O que depende da mesa real
Confirmação por leitura de volta (eco OSC), layout dos medidores (`/meters/1`), renovação dos medidores/`/xremote`, endereços de GEQ/FX/DCA, latência real de rede, USB multicanal no navegador, comportamento da proteção de picos com sinal real, valores iniciais de limites da IA para o seu palco.

## Testes
Suíte em pacote separado (`XR18-Studio_testes.zip`): `DIST=<pasta do app> node suite.js` (precisa de Node + Playwright).
