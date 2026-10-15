# Idempotência de Requisições

> Implementa Idempotency-Key: a mesma cobrança ou pedido nunca é processado duas vezes, com trava em andamento (409) e payload divergente (422). Fim do cliente cobrado em dobro.

**Ver ao vivo, com preview e manual:** https://flowcoresolucoes.com.br/codigos/idempotency-key

Criado por **FlowCore Soluções LTDA**.

## Arquivos

- [`src/idempotencia.ts`](src/idempotencia.ts)
- [`src/idempotencia.test.ts`](src/idempotencia.test.ts)

## Como instalar

1. **Funciona onde você já roda** Node 18+, Cloudflare Workers, Deno, Bun, Vercel e Netlify Functions. Zero dependência: só fetch e Web Crypto, que já vêm no runtime.
2. **Crie src/lib/idempotencia.ts** Copie o conteúdo de `src/idempotencia.ts` e `src/idempotencia.test.ts` deste repositório.
3. **Use**

   ```bash
   const idem = criarIdempotencia({ ttlMs: 24 * 3600_000 });
   const r = await idem.executar(req.headers.get("Idempotency-Key"), body, async () => {
     const pedido = await criarPedido(body);
     return { status: 201, corpo: pedido };
   });
   return Response.json(r.corpo, { status: r.status, headers: r.headers });
   ```

4. **Rode o teste junto** O arquivo de teste (`src/idempotencia.test.ts`) cobre 9 cenários. Copie para src/lib/ ao lado e rode:

   ```bash
   npm install -D vitest
   npx vitest run src/lib
   ```


## Testes

`src/idempotencia.test.ts` cobre 9 cenários.

```bash
npm install
npm test
```

## Licença

MIT. Pode usar em projeto pessoal ou comercial, de graça. A única condição é manter a linha **“Criado por FlowCore Soluções LTDA”** (ou o crédito de adaptação) onde ela está.

---

Precisa disso integrado no seu sistema? A [FlowCore](https://flowcoresolucoes.com.br) desenvolve sob medida.
