// idempotencia.ts · Criado por FlowCore Soluções LTDA · flowcoresolucoes.com.br/codigos · licença MIT
// Idempotency-Key pra APIs de pagamento, pedido e checkout: a mesma chave
// nunca executa a operação duas vezes (clique duplo, retry do app, timeout do
// gateway). Trava enquanto processa (409), devolve a resposta salva nas
// repetições e recusa a mesma chave com payload diferente (422).
// Roda em Node 18+, Cloudflare Workers, Deno e Bun. Armazém plugável
// (memória incluída; implemente a interface pra Redis, KV, D1 ou Postgres).
// Zero dependências.
//
// Referência: IETF draft "The Idempotency-Key HTTP Header Field"
// (draft-ietf-httpapi-idempotency-key-header).

export const CRIADO_POR = "Criado por FlowCore Soluções LTDA";

export type RespostaSalva = {
  status: number;
  headers?: Record<string, string>;
  corpo: unknown;
};

export type RegistroIdempotencia = {
  estado: "processando" | "concluido";
  hashPayload: string;
  resposta?: RespostaSalva;
  criadoEm: number;
};

/** Contrato do armazém. setSeNaoExistir precisa ser atômico (Redis: SET NX PX). */
export interface ArmazemIdempotencia {
  get(chave: string): Promise<RegistroIdempotencia | null>;
  set(chave: string, registro: RegistroIdempotencia, ttlMs: number): Promise<void>;
  setSeNaoExistir(chave: string, registro: RegistroIdempotencia, ttlMs: number): Promise<boolean>;
  delete(chave: string): Promise<void>;
}

/** Armazém em memória (um processo). Em produção com várias instâncias, use Redis/KV. */
export class ArmazemMemoria implements ArmazemIdempotencia {
  private dados = new Map<string, { registro: RegistroIdempotencia; expira: number }>();
  constructor(private readonly now: () => number = Date.now) {}

  private vivo(chave: string) {
    const item = this.dados.get(chave);
    if (item && item.expira <= this.now()) {
      this.dados.delete(chave);
      return undefined;
    }
    return item;
  }
  async get(chave: string) {
    const item = this.vivo(chave);
    return item ? structuredCopy(item.registro) : null;
  }
  async set(chave: string, registro: RegistroIdempotencia, ttlMs: number) {
    this.dados.set(chave, { registro: structuredCopy(registro), expira: this.now() + ttlMs });
  }
  async setSeNaoExistir(chave: string, registro: RegistroIdempotencia, ttlMs: number) {
    if (this.vivo(chave)) return false;
    await this.set(chave, registro, ttlMs);
    return true;
  }
  async delete(chave: string) {
    this.dados.delete(chave);
  }
}

const structuredCopy = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/** JSON canônico (chaves ordenadas), pra que {a,b} e {b,a} gerem o mesmo hash. */
export function jsonCanonico(valor: unknown): string {
  if (valor === null || typeof valor !== "object") return JSON.stringify(valor) ?? "null";
  if (Array.isArray(valor)) return `[${valor.map((v) => (v === undefined ? "null" : jsonCanonico(v))).join(",")}]`;
  const obj = valor as Record<string, unknown>;
  const chaves = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return `{${chaves.map((k) => `${JSON.stringify(k)}:${jsonCanonico(obj[k])}`).join(",")}}`;
}

export async function hashPayload(payload: unknown): Promise<string> {
  const texto = typeof payload === "string" ? payload : jsonCanonico(payload);
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(texto)));
  let hex = "";
  for (let i = 0; i < d.length; i++) hex += d[i].toString(16).padStart(2, "0");
  return hex;
}

export type OpcoesIdempotencia = {
  armazem?: ArmazemIdempotencia;
  /** Quanto tempo a resposta fica guardada. Padrão 24h. */
  ttlMs?: number;
  /** Tempo máximo da trava "processando" (se o processo cair, libera depois disso). Padrão 60s. */
  ttlTravaMs?: number;
  /** Prefixo das chaves no armazém (separe por cliente/rota). */
  prefixo?: string;
  /** Se false (padrão), respostas 5xx não são salvas: o cliente pode tentar de novo. */
  salvarErrosServidor?: boolean;
  now?: () => number;
};

export type RespostaIdempotente = RespostaSalva & {
  headers: Record<string, string>;
  /** true quando a resposta veio do armazém, sem executar de novo. */
  reaproveitada: boolean;
};

const erro = (status: number, mensagem: string): RespostaIdempotente => ({
  status,
  headers: { "Content-Type": "application/json" },
  corpo: { erro: mensagem },
  reaproveitada: false,
});

export function criarIdempotencia(opcoes: OpcoesIdempotencia = {}) {
  const now = opcoes.now ?? Date.now;
  const armazem = opcoes.armazem ?? new ArmazemMemoria(now);
  const ttl = opcoes.ttlMs ?? 24 * 60 * 60 * 1000;
  const ttlTrava = opcoes.ttlTravaMs ?? 60_000;
  const prefixo = opcoes.prefixo ?? "idem:";

  return {
    /**
     * Executa o handler uma única vez por chave. Repetições com o mesmo payload
     * devolvem a resposta salva (header Idempotent-Replayed: true).
     */
    async executar(
      chaveEntrada: string | null | undefined,
      payload: unknown,
      handler: () => Promise<RespostaSalva>,
    ): Promise<RespostaIdempotente> {
      const chave = (chaveEntrada ?? "").trim();
      if (!chave) return erro(400, "Header Idempotency-Key obrigatório");
      if (chave.length > 255 || !/^[\x21-\x7e]+$/.test(chave))
        return erro(400, "Idempotency-Key inválida (até 255 caracteres ASCII visíveis)");

      const id = prefixo + chave;
      const hash = await hashPayload(payload);
      const trava: RegistroIdempotencia = { estado: "processando", hashPayload: hash, criadoEm: now() };

      if (!(await armazem.setSeNaoExistir(id, trava, ttlTrava))) {
        const existente = await armazem.get(id);
        if (existente) {
          if (existente.hashPayload !== hash)
            return erro(422, "Esta Idempotency-Key já foi usada com outro payload");
          if (existente.estado === "processando")
            return { ...erro(409, "Requisição com esta Idempotency-Key ainda em processamento"), headers: { "Content-Type": "application/json", "Retry-After": "1" } };
          const r = existente.resposta as RespostaSalva;
          return { status: r.status, corpo: r.corpo, headers: { ...r.headers, "Idempotent-Replayed": "true" }, reaproveitada: true };
        }
        // Expirou entre o setSeNaoExistir e o get: tenta travar de novo.
        if (!(await armazem.setSeNaoExistir(id, trava, ttlTrava)))
          return erro(409, "Requisição com esta Idempotency-Key ainda em processamento");
      }

      let resposta: RespostaSalva;
      try {
        resposta = await handler();
      } catch (e) {
        await armazem.delete(id);
        throw e;
      }

      if (resposta.status >= 500 && !opcoes.salvarErrosServidor) {
        await armazem.delete(id);
      } else {
        await armazem.set(id, { estado: "concluido", hashPayload: hash, resposta, criadoEm: trava.criadoEm }, ttl);
      }
      return { status: resposta.status, corpo: resposta.corpo, headers: { ...resposta.headers }, reaproveitada: false };
    },
  };
}
