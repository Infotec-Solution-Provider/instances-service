# Microsservico de instâncias do inPulse
## Descrição
Este micro serviço é responsável por guardar dados como conexões com banco de dados e parâmetros do WhatsApp, além de ser responsável por gerênciar conexòes com o banco e realizar qualquer tipo de consulta SQL

## Recuperação opcional do ZeroTier

O monitor pode reiniciar o serviço local do ZeroTier quando detectar falhas persistentes. Fica **desabilitado por padrão** e precisa ser habilitado com `ZEROTIER_RECOVERY_ENABLED=true` no ambiente do instances-service. Suporta Linux com systemd e Windows, com o ZeroTier instalado no mesmo host. Reiniciar o ZeroTier interrompe temporariamente o tráfego de todos os aplicativos que usam suas redes nesse host.

O monitor consulta o daemon local e, opcionalmente, as redes e os destinos TCP configurados. Conta como falha: estado offline, daemon inacessível ou consulta expirada, redes monitoradas em `PORT_ERROR` ou `REQUESTING_CONFIGURATION`, ou falha de todos os destinos TCP. Um resultado saudável zera a contagem; `TUNNELED` é aceito como operacional. Erros de configuração, como CLI ausente, falta de autenticação/permissão, JSON inválido, rede não aderida ou `ACCESS_DENIED`, são registrados sem reiniciar o serviço. Os significados dos estados e a necessidade de permissões estão na [documentação da CLI do ZeroTier](https://docs.zerotier.com/cli/).

Os destinos TCP permitem detectar perda de tráfego mesmo quando o daemon permanece online. Configure ao menos **dois hosts distintos**, acessíveis pela rede ZeroTier, com portas estáveis. A falha isolada de um banco não dispara a recuperação por esse critério. A indisponibilidade simultânea dos destinos também pode causar um reinício; escolha hosts independentes e confiáveis. Sem destinos TCP, o monitor avalia apenas os sinais locais do ZeroTier.

Os pools MySQL continuam sendo recuperados pelo próprio health check, com um único timer e sem verificações sobrepostas. O ping tem prazo de 10 segundos; se não conseguir adquirir uma conexão nesse período, mantém o pool para preservar consultas em andamento. Falhas após a aquisição retiram o pool afetado para recriação na próxima consulta. O encerramento de conexões antigas ocorre em segundo plano e pode continuar pendente no driver; esta recuperação não força o cancelamento de consultas presas quando todas as conexões estão ocupadas.

| Variável | Padrão | Uso |
| --- | --- | --- |
| `ZEROTIER_RECOVERY_ENABLED` | `false` | Habilita o monitor. |
| `ZEROTIER_RECOVERY_INTERVAL_MS` | `30000` | Intervalo entre verificações. |
| `ZEROTIER_RECOVERY_FAILURE_THRESHOLD` | `3` | Falhas consecutivas necessárias para tentar reiniciar. |
| `ZEROTIER_RECOVERY_COOLDOWN_MS` | `600000` | Intervalo mínimo entre tentativas, inclusive quando o reinício falha. |
| `ZEROTIER_RECOVERY_STARTUP_GRACE_MS` | `60000` | Espera inicial antes de verificar a saúde. |
| `ZEROTIER_RECOVERY_COMMAND_TIMEOUT_MS` | `15000` | Prazo de cada consulta à CLI. |
| `ZEROTIER_RECOVERY_RESTART_TIMEOUT_MS` | `30000` | Prazo do comando de reinício. |
| `ZEROTIER_RECOVERY_NETWORK_IDS` | vazio | IDs de rede com 16 caracteres hexadecimais, separados por vírgula; vazio desativa a checagem de redes específicas. |
| `ZEROTIER_RECOVERY_PROBE_TARGETS` | vazio | Destinos `host:porta`, separados por vírgula, com ao menos dois hosts distintos; prazo TCP de 5 segundos por destino. |
| `ZEROTIER_CLI_PATH` | padrão da plataforma | Caminho absoluto do executável da CLI, sem argumentos. |
| `ZEROTIER_RECOVERY_USE_SUDO` | `false` | Linux: executa as consultas e o reinício com `sudo -n`. |

Os valores numéricos são inteiros: mínimo de 2 falhas, 60000 ms de intervalo entre tentativas e 1000 ms nos demais tempos; máximo de 2147483647. Uma configuração inválida desativa somente o monitor e gera um log, sem impedir a inicialização da API.

Use somente um monitor por host. No PM2, processos com `NODE_APP_INSTANCE` diferente de `0` não iniciam o monitor. Essa proteção não coordena aplicações PM2 distintas, contêineres ou outros gerenciadores. A contagem e o intervalo mínimo entre tentativas ficam em memória e são reiniciados com o processo.

### Permissões e ativação

No Linux, o processo precisa consultar a CLI e executar `systemctl restart zerotier-one`, comando indicado nas [instruções oficiais de recuperação](https://docs.zerotier.com/faq/emergencyinstructions/). Para um usuário sem privilégios, habilite `ZEROTIER_RECOVERY_USE_SUDO=true` e autorize somente os comandos exatos em sudoers, sem senha e sem curingas. Não conceda sudo irrestrito ao usuário do Node.

Os caminhos usados são `/usr/sbin/zerotier-cli`, `/usr/bin/systemctl` e `/usr/bin/sudo`. Se a CLI estiver em outro caminho, ajuste `ZEROTIER_CLI_PATH` e a regra correspondente. Exemplo para editar com `visudo`, substituindo `instances` pelo usuário real do processo:

```sudoers
instances ALL=(root) NOPASSWD: /usr/sbin/zerotier-cli -j info, /usr/sbin/zerotier-cli -j listnetworks, /usr/bin/systemctl restart zerotier-one
```

Confirme que os executáveis autorizados e seus diretórios são administrados por root. Antes de habilitar, valide as consultas com o mesmo usuário do processo:

```sh
sudo -n /usr/sbin/zerotier-cli -j info
sudo -n /usr/sbin/zerotier-cli -j listnetworks
```

No Windows, o caminho padrão é `C:\Program Files (x86)\ZeroTier\One\zerotier-one_x64.exe`; ajuste `ZEROTIER_CLI_PATH` conforme a instalação. A conta do processo precisa acessar a CLI e ter permissão para reiniciar `ZeroTierOneService`, nome confirmado na [documentação do serviço](https://docs.zerotier.com/faq/noservice/). A opção de sudo se aplica somente ao Linux. O executável do ZeroTier é chamado diretamente em modo CLI (`-q -j info` e, quando necessário, `-q -j listnetworks`), sem arquivo `.bat`.

Após configurar o ambiente e as permissões, reinicie o instances-service pelo seu gerenciador habitual e acompanhe os logs do monitor para confirmar as verificações. Desabilite com `ZEROTIER_RECOVERY_ENABLED=false` e reinicie o processo. Não há endpoint HTTP para disparar o reinício. Os testes locais usam comandos simulados; eles não comprovam permissões, recuperação de tráfego ou reconexão dos bancos no servidor de produção.
