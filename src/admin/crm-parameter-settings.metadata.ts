// Local copy of users-service business metadata; SQL remains authoritative for wire types and values.
export interface CrmParameterSetting {
  key: string;
  label: string;
  description: string;
  group: string;
  type: "boolean" | "number";
  trueValue?: string;
  falseValue?: string;
  min?: number;
  max?: number;
}

function toggle(
  key: string,
  label: string,
  description: string,
  group: string,
  longValues = false,
): CrmParameterSetting {
  return {
    key,
    label,
    description,
    group,
    type: "boolean",
    trueValue: longValues ? "SIM" : "S",
    falseValue: longValues ? "NAO" : "N",
  };
}

function number(
  key: string,
  label: string,
  description: string,
  group: string,
): CrmParameterSetting {
  return {
    key,
    label,
    description,
    group,
    type: "number",
    min: 0,
    max: 2147483647,
  };
}

// Supported business settings only; availability and defaults are read from each tenant's SQL schema.
export const crmParameterSettings: CrmParameterSetting[] = [
  toggle(
    "VALIDA_CPF_CNPJ",
    "Validar CPF e CNPJ",
    "Ativar a validação de documentos no CRM legado.",
    "Clientes",
    true,
  ),
  toggle(
    "UTILIZA_API_CEP",
    "Consultar endereço pelo CEP",
    "Utilizar a integração de CEP configurada no CRM legado.",
    "Clientes",
  ),
  toggle(
    "ALERTA_API_CEP",
    "Alertas da consulta de CEP",
    "Exibir alertas relacionados à consulta de CEP.",
    "Clientes",
  ),
  toggle(
    "ATIVO_ALTERAR_RAZAO",
    "Alterar razão social no atendimento ativo",
    "Permitir a alteração da razão social no módulo ativo.",
    "Clientes",
  ),
  toggle(
    "HABILITAR_CLIENTES_BLOQUEADOS",
    "Habilitar clientes bloqueados",
    "Habilitar o recurso de clientes bloqueados no CRM legado.",
    "Clientes",
  ),
  number(
    "QTD_HISTORICO_CLI",
    "Quantidade de históricos do cliente",
    "Quantidade usada pelo histórico de clientes do CRM legado.",
    "Clientes",
  ),
  toggle(
    "AGENDA_FERIADO",
    "Agendar em feriados",
    "Permitir agendamentos em feriados.",
    "Agendamento",
    true,
  ),
  toggle(
    "AGENDA_SABADO",
    "Agendar aos sábados",
    "Permitir agendamentos aos sábados.",
    "Agendamento",
    true,
  ),
  toggle(
    "AGENDA_DOMINGO",
    "Agendar aos domingos",
    "Permitir agendamentos aos domingos.",
    "Agendamento",
    true,
  ),
  toggle(
    "VALIDA_AGENDAMENTOS",
    "Validar agendamentos",
    "Ativar as validações de agendamento do CRM legado.",
    "Agendamento",
  ),
  toggle(
    "AGENDAMENTO_SUPERVISOR",
    "Agendamento pelo supervisor",
    "Habilitar o agendamento pelo supervisor.",
    "Agendamento",
  ),
  toggle(
    "EXIBIR_TODOS_AGENDAMENTOS",
    "Exibir todos os agendamentos",
    "Exibir todos os agendamentos no CRM legado.",
    "Agendamento",
  ),
  toggle(
    "BLOQ_LIMITE_AGENDAMENTO_DIA",
    "Bloquear ao atingir o limite diário",
    "Aplicar o bloqueio pelo limite de agendamentos do dia.",
    "Agendamento",
  ),
  number(
    "LIMITE_AGENDAMENTO_DIA",
    "Limite diário de agendamentos",
    "Quantidade limite de agendamentos por dia.",
    "Agendamento",
  ),
  number(
    "DIAS_LIMITE_AGENDAMENTO",
    "Limite de dias para agendamento",
    "Limite de dias usado pelo agendamento do CRM legado.",
    "Agendamento",
  ),
  toggle(
    "EXIBIR_PRODUTIVIDADE",
    "Exibir produtividade",
    "Exibir os indicadores de produtividade no CRM legado.",
    "Atendimento",
  ),
  toggle(
    "EXIBIR_PEDIDOS_FECHADOS",
    "Exibir pedidos fechados",
    "Exibir pedidos fechados no atendimento.",
    "Atendimento",
  ),
  toggle(
    "EXIBIR_FASE_CONTATO",
    "Exibir fase do contato",
    "Exibir a fase do contato no CRM legado.",
    "Atendimento",
  ),
  toggle(
    "EXIGIR_FASE_CONTATO",
    "Exigir fase do contato",
    "Exigir o preenchimento da fase do contato.",
    "Atendimento",
  ),
  toggle(
    "CARTEIRA_FIXA_OPERADOR",
    "Carteira fixa por operador",
    "Utilizar carteiras fixas por operador.",
    "Atendimento",
  ),
  toggle(
    "MANTER_REPRESENTANTE",
    "Manter representante",
    "Manter o representante associado ao cliente.",
    "Atendimento",
  ),
  toggle(
    "OCULTAR_BOTAO_TRANSFERENCIA",
    "Ocultar botão de transferência",
    "Ocultar o botão de transferência no CRM legado.",
    "Atendimento",
  ),
  toggle(
    "OCULTAR_OPERADORES_CHAT",
    "Ocultar operadores no chat",
    "Ocultar operadores no chat do CRM legado.",
    "Atendimento",
  ),
  toggle(
    "IMPORTAR_CLIENTES",
    "Importar clientes",
    "Habilitar a importação de clientes.",
    "Importação",
  ),
  toggle(
    "IMPORTAR_COMPRAS",
    "Importar compras",
    "Habilitar a importação de compras.",
    "Importação",
  ),
  toggle(
    "IMPORTAR_CLIENTE_EXISTENTE",
    "Importar clientes existentes",
    "Permitir que a importação atualize clientes existentes.",
    "Importação",
  ),
  toggle(
    "IMP_POR_CPFNCPJ_CLIENTE",
    "Identificar clientes por CPF ou CNPJ",
    "Utilizar CPF ou CNPJ para identificar clientes durante a importação.",
    "Importação",
  ),
  toggle(
    "AVISO_RECOMPRA_SUPERVISOR",
    "Avisar supervisor sobre recompra",
    "Exibir avisos de recompra para o supervisor.",
    "Recompra",
  ),
  toggle(
    "AVISO_RECOMPRA_OPERADOR",
    "Avisar operador sobre recompra",
    "Exibir avisos de recompra para o operador.",
    "Recompra",
  ),
  toggle(
    "BLOQUEAR_AGENDAMENTO_FORA_PERIODO_RECOMPRA",
    "Bloquear agendamento fora da recompra",
    "Bloquear agendamentos fora do período de recompra.",
    "Recompra",
  ),
  number(
    "DIAS_VALIDAR_PERIODO_RECOMPRA",
    "Dias para validar período de recompra",
    "Quantidade de dias usada na validação do período de recompra.",
    "Recompra",
  ),
  toggle(
    "EXPIRAR_TRANSFERENCIA_CLIENTES",
    "Expirar transferências de clientes",
    "Aplicar expiração às transferências de clientes.",
    "Transferência",
  ),
  number(
    "DIAS_EXPIRAR_TRANSFERENCIA_CLIENTES",
    "Dias para expirar transferências",
    "Quantidade de dias até a expiração de uma transferência.",
    "Transferência",
  ),
];
