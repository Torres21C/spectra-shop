import { Injectable, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';

/**
 * DT-05 / D-M05-06: las respuestas de Commerce contienen carrito, pedidos y datos de entrega
 * (PII de laboratorio) ligados a la sesión. Ningún navegador ni proxy debe almacenarlas.
 */
@Injectable()
export class NoStoreMiddleware implements NestMiddleware {
  use(_request: Request, response: Response, next: NextFunction): void {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Pragma', 'no-cache');
    next();
  }
}
