// idempotencia.test.ts · Criado por FlowCore Soluções LTDA · flowcoresolucoes.com.br/codigos · licença MIT
import { describe, expect, it, vi } from "vitest";
import { ArmazemMemoria, criarIdempotencia, hashPayload, jsonCanonico, type RespostaSalva } from "./idempotencia";

const ok = (corpo: unknown, status = 201): RespostaSalva => ({ status, corpo, headers: { "X-Pedido": "1" } });

describe("idempotencia", () => {
  it("executa uma vez e reaproveita a resposta na repetição", async () => {
    const idem = criarIdempotencia();
    const handler = vi.fn(async () => ok({ pedido: "ped_1" }));
    const r1 = await idem.executar("chave-1", { valor: 100 }, handler);
    const r2 = await idem.executar("chave-1", { valor: 100 }, handler);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(r1).toEqual({ status: 201, corpo: { pedido: "ped_1" }, headers: { "X-Pedido": "1" }, reaproveitada: false });
    expect(r2).toEqual({
      status: 201,
      corpo: { pedido: "ped_1" },
      headers: { "X-Pedido": "1", "Idempotent-Replayed": "true" },
      reaproveitada: true,
    });
  });

  it("recusa a mesma chave com payload diferente (422)", async () => {
    const idem = criarIdempotencia();
    await idem.executar("k", { valor: 100 }, async () => ok({}));
    const r = await idem.executar("k", { valor: 999 }, async () => ok({}));
    expect(r.status).toBe(422);
  });

  it("ordem das chaves do JSON não muda o hash", async () => {
    expect(jsonCanonico({ b: 1, a: { d: [1, { y: 2, x: 1 }], c: undefined } })).toBe('{"a":{"d":[1,{"x":1,"y":2}]},"b":1}');
    expect(await hashPayload({ a: 1, b: 2 })).toBe(await hashPayload({ b: 2, a: 1 }));
    expect(await hashPayload("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  it("devolve 409 enquanto a primeira requisição está em processamento", async () => {
    const idem = criarIdempotencia();
    let liberar!: () => void;
    const lento = new Promise<void>((r) => (liberar = r));
    let avisarInicio!: () => void;
    const comecou = new Promise<void>((r) => (avisarInicio = r));
    const primeira = idem.executar("k", {}, async () => {
      avisarInicio();
      await lento;
      return ok({ fim: true });
    });
    await comecou;
    const concorrente = await idem.executar("k", {}, async () => ok({ duplicado: true }));
    expect(concorrente.status).toBe(409);
    expect(concorrente.headers["Retry-After"]).toBe("1");
    liberar();
    expect((await primeira).corpo).toEqual({ fim: true });
  });

  it("libera a chave se o handler lançar erro", async () => {
    const idem = criarIdempotencia();
    await expect(idem.executar("k", {}, async () => Promise.reject(new Error("gateway caiu")))).rejects.toThrow("gateway caiu");
    const r = await idem.executar("k", {}, async () => ok({ segunda: true }));
    expect(r).toMatchObject({ status: 201, reaproveitada: false });
  });

  it("não guarda 5xx por padrão, mas guarda 4xx", async () => {
    const idem = criarIdempotencia();
    const h = vi.fn(async () => ok({ erro: "x" }, 503));
    await idem.executar("a", {}, h);
    await idem.executar("a", {}, h);
    expect(h).toHaveBeenCalledTimes(2);
    const h4 = vi.fn(async () => ok({ erro: "saldo" }, 402));
    await idem.executar("b", {}, h4);
    expect((await idem.executar("b", {}, h4)).reaproveitada).toBe(true);
    expect(h4).toHaveBeenCalledTimes(1);
  });

  it("expira a resposta após o TTL", async () => {
    let agora = 0;
    const idem = criarIdempotencia({ now: () => agora, ttlMs: 1000 });
    const h = vi.fn(async () => ok({}));
    await idem.executar("k", {}, h);
    agora = 999;
    await idem.executar("k", {}, h);
    agora = 1001;
    await idem.executar("k", {}, h);
    expect(h).toHaveBeenCalledTimes(2);
  });

  it("valida a chave (ausente, longa, com espaço)", async () => {
    const idem = criarIdempotencia();
    const h = vi.fn(async () => ok({}));
    expect((await idem.executar(undefined, {}, h)).status).toBe(400);
    expect((await idem.executar("x".repeat(256), {}, h)).status).toBe(400);
    expect((await idem.executar("com espaço", {}, h)).status).toBe(400);
    expect(h).not.toHaveBeenCalled();
  });

  it("armazém em memória: setSeNaoExistir é exclusivo e devolve cópias", async () => {
    const a = new ArmazemMemoria(() => 0);
    const reg = { estado: "processando" as const, hashPayload: "h", criadoEm: 0 };
    expect(await a.setSeNaoExistir("x", reg, 10)).toBe(true);
    expect(await a.setSeNaoExistir("x", reg, 10)).toBe(false);
    const lido = await a.get("x");
    lido!.hashPayload = "alterado";
    expect((await a.get("x"))!.hashPayload).toBe("h");
    await a.delete("x");
    expect(await a.get("x")).toBeNull();
  });
});
