import { createServer, request as httpRequest, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export type FaultMode =
  /** Reenvía sin alterar. */
  | { readonly kind: 'forward' }
  /** Responde 503 sin llegar a Catalog: la operación no se aplicó. */
  | { readonly kind: 'fail-before' }
  /** Reenvía a Catalog y descarta su respuesta con 503: la operación SÍ se aplicó (ambigüedad). */
  | { readonly kind: 'fail-after' }
  /** Ejecuta una acción (p. ej. vencer la reserva) y luego reenvía. */
  | { readonly kind: 'before'; readonly action: () => Promise<void> }
  /** Retiene la petición hasta que la prueba la libere. */
  | { readonly kind: 'hold'; readonly gate: Promise<void> };

type Rule = { readonly pattern: RegExp; mode: FaultMode; hits: number };

/**
 * Proxy HTTP real entre Commerce y el listener interno de Catalog. Permite reproducir caídas,
 * respuestas perdidas y retrasos en puntos concretos de la saga sin modificar código productivo.
 */
export class FaultProxy {
  private server: Server | undefined;
  private readonly rules: Rule[] = [];

  constructor(private readonly target: URL) {}

  async start(): Promise<URL> {
    this.server = createServer((incoming, outgoing) => {
      void this.handle(incoming).then(
        ({ status, headers, body }) => {
          outgoing.writeHead(status, headers);
          outgoing.end(body);
        },
        () => {
          outgoing.writeHead(502);
          outgoing.end();
        },
      );
    });
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    const { port } = this.server.address() as AddressInfo;
    return new URL(`http://127.0.0.1:${port}`);
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) =>
      this.server ? this.server.close(() => resolve()) : resolve(),
    );
  }

  /** Aplica `mode` a las peticiones que coinciden; `times` limita cuántas veces. */
  on(pattern: RegExp, mode: FaultMode): void {
    this.rules.unshift({ pattern, mode, hits: 0 });
  }

  hits(pattern: RegExp): number {
    return this.rules.find((rule) => rule.pattern.source === pattern.source)?.hits ?? 0;
  }

  reset(): void {
    this.rules.length = 0;
  }

  private async handle(
    incoming: IncomingMessage,
  ): Promise<{ status: number; headers: Record<string, string>; body: Buffer }> {
    const chunks: Buffer[] = [];
    for await (const chunk of incoming) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks);
    const signature = `${incoming.method ?? 'GET'} ${incoming.url ?? '/'}`;
    const rule = this.rules.find((candidate) => candidate.pattern.test(signature));
    const mode: FaultMode = rule?.mode ?? { kind: 'forward' };
    if (rule) rule.hits += 1;

    const unavailable = {
      status: 503,
      headers: { 'content-type': 'application/json' },
      body: Buffer.from(JSON.stringify({ code: 'INJECTED_FAULT' })),
    };
    if (mode.kind === 'fail-before') return unavailable;
    if (mode.kind === 'before') await mode.action();
    if (mode.kind === 'hold') await mode.gate;
    const forwarded = await this.forward(incoming, body);
    return mode.kind === 'fail-after' ? unavailable : forwarded;
  }

  private forward(
    incoming: IncomingMessage,
    body: Buffer,
  ): Promise<{ status: number; headers: Record<string, string>; body: Buffer }> {
    return new Promise((resolve, reject) => {
      const headers: Record<string, string> = {};
      for (const [name, value] of Object.entries(incoming.headers)) {
        if (typeof value === 'string' && name !== 'host' && name !== 'connection') {
          headers[name] = value;
        }
      }
      const outgoing = httpRequest(
        new URL(incoming.url ?? '/', this.target),
        { method: incoming.method, headers },
        (response) => {
          const parts: Buffer[] = [];
          response.on('data', (chunk: Buffer) => parts.push(chunk));
          response.on('end', () =>
            resolve({
              status: response.statusCode ?? 502,
              headers: { 'content-type': response.headers['content-type'] ?? 'application/json' },
              body: Buffer.concat(parts),
            }),
          );
          response.on('error', reject);
        },
      );
      outgoing.on('error', reject);
      outgoing.end(body);
    });
  }
}
