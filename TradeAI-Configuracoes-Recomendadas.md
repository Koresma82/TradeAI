# TradeAI — Configurações Recomendadas

Guia de referência com os valores recomendados para o **DCA** (o teu núcleo passivo) e para o **AI Brain** (o trading ativo opcional). Pensado para começares em modo paper com segurança e ires afinando com o tempo.

> **Nota importante:** estes valores são um ponto de partida seguro, não uma garantia de lucro. O AI Brain usa um modelo de IA rápido (Groq) cujas decisões não são infalíveis. Observa o comportamento durante várias semanas antes de tirares conclusões. O DCA é o núcleo sólido; o AI Brain é a aposta especulativa.

---

## Parte 1 — DCA (o teu núcleo)

O DCA é uma estratégia passiva: compra regular e automática, segurar a longo prazo. O poder dele está na disciplina e na consistência, não no timing.

### Configuração geral
- **Capital total disponível:** €1000
- **Valor por período (bolo):** €100
- **Reserva para AI Trade:** €10 a €100 (dinheiro separado; só se usares o AI Brain)

### Plano de cripto (exemplo)
- **Tipo de plano:** Cripto (automático)
- **Broker:** Binance
- **Execução:** Automático
- **Frequência:** Semanal
- **Alocação:** 90% do bolo (≈ €90/período)
- **Carteira sugerida (perfil equilibrado):**
  - Bitcoin (BTC) — 50%
  - Ethereum (ETH) — 30%
  - Solana (SOL) — 20%
- **Reequilíbrio automático:** Ligado (mantém as percentagens; vende excesso, reforça em falta)

> Se testares no Binance Testnet, confirma que os ativos existem lá. BTC e ETH funcionam sempre; outros podem falhar.

### Notificações DCA (Telegram)
- **Alerta de compra em queda:** Ligado — avisa-te quando um ativo cai bastante abaixo do teu preço médio, para reforçares (baixa o preço médio, dilui a perda)
- **Resumo mensal:** Ligado — balanço no início de cada mês
- **Lembrete diário de aporte:** Desligado — só útil para planos manuais (o automático não precisa)
- **Modo férias:** vazio — só se fores viajar e quiseres pausar as compras

### Estratégia de reforço (averaging down)
Quando um ativo está em queda e acreditas nele a longo prazo, reforçar baixa o teu preço médio (as posições consolidam-se numa só). Combina com o toggle **"só vender lucro"** por posição: reforças na queda, e o AI vende quando a posição consolidada ficar verde.

**Aviso:** reforçar em queda funciona se o ativo recuperar, mas amplifica a perda se continuar a cair. Usa só com ativos em que acreditas.

---

## Parte 2 — AI Brain (trading ativo opcional)

O AI Brain é a camada especulativa: compra e vende ativamente com base em sinais de IA. Usa dinheiro **separado** do DCA (a reserva AI Trade). Filosofia da configuração: **começar conservador** para aprenderes como se comporta.

### Perfil de Risco
- **Perfil:** Moderado ⚖️
  - Stop Loss: 6%
  - Take Profit: 12%
  - Compra em quedas de: 1,5%
  - Rácio risco/ganho 1:2 (arriscas 6% para ganhar 12%)

> Evita o Scalper (SL 3% / TP 4%) — faz muitos trades pequenos, difícil de avaliar. Evita o Agressivo (SL 9%) até teres confiança.

### Limites de Segurança
- **Máx. posições AI Brain:** 3
- **Máx. posições total:** 40
- **Stop Loss padrão:** 6%
- **Take Profit padrão:** 12%
- **Máximo por trade:** €50
- **Rotação de posições:** Desligada
- **Modo dinâmico (regime de mercado):** Ligado — reduz exposição em mercado de queda

### Automação Avançada com IA
- **Cérebro AI — entrada autónoma:** Ligado
- **Confiança mínima para agir:** 82% — só compra quando está bastante seguro (qualidade > quantidade)
- **Trailing Stop:** Ligado, 4% — protege lucros, trava se recuar 4% do pico
- **Sair quando a IA muda de opinião:** Ligado
- **Take-profit parcial:** Ligado, 60% — ao atingir o TP, vende 60% e deixa 40% correr
- **Frequência de análise:** 15 min — poupa tokens da Groq (partilhada entre app e bot)

### Valor e Teto por Origem
- Deixa tudo a **0** (herda o global). Só mexes se quiseres dar valores diferentes a cada fonte.

### Ajuste por Tipo de Ativo
- Deixa tudo em **1.0×** para começar. Mais tarde, se a cripto for volátil demais, podes baixar para 0.8× (SL/TP mais apertados).

### Fontes de Trading Ativo (liga uma de cada vez)
- **AI Brain (mestre):** Ligado — a chave-mestra
- **Compras autónomas:** Ligado — o Cérebro AI decide e compra
- **Estratégias:** Desligado — só quando criares estratégias tuas
- **Day Trading:** Desligado — o mais arriscado, deixa para o fim
- **Sugestão da IA a pedido:** Ligado — dá opinião quando pedes, sem executar (grátis e sem risco)

### Reserva de capital
- **Reserva p/ AI Trade:** €100 (de €1000) — margem para o AI operar sem tocar no DCA

---

## Resumo da lógica

Esta configuração desenha um AI Brain que:
- Compra só quando muito confiante (82%)
- Com posições pequenas (€50) e poucas (3)
- Protege lucros (trailing stop + take-profit parcial)
- Corta perdas cedo (stop loss 6%)
- Reduz-se sozinho em mercado mau (modo dinâmico)

É um perfil de "aprender a andar". Quando vires resultados consistentes ao longo de semanas, podes soltar mais (subir posições, baixar confiança, ligar mais fontes).

---

## Ordem recomendada para começar

1. Configura e testa o **DCA** primeiro (é o núcleo). Deixa correr uns dias.
2. Quando quiseres experimentar o AI Brain, aplica a **configuração recomendada** (botão nas Definições → grupo Trading Ativo).
3. Liga o **AI Brain (mestre)** + **Compras autónomas** + **Sugestão a pedido**.
4. Observa em paper durante várias semanas.
5. Só considera dinheiro real depois de veres resultados consistentes e de perceberes bem o comportamento do sistema.

---

*Documento gerado para referência pessoal. Não é aconselhamento financeiro. Cripto e trading ativo são de risco elevado — podes perder parte ou todo o capital investido.*
